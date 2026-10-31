package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"kiro-go/config"
	"kiro-go/logger"
	"os"
	"path/filepath"
)

// Request logs are persisted as JSON lines next to config.json so the admin Logs tab
// and the /key portal survive restarts and redeploys. The file is compacted back to
// the in-memory ring (last requestLogsMaxSize entries) once it grows past this size.
const (
	requestLogsFileName     = "request-logs.jsonl"
	requestLogsCompactBytes = 4 << 20
)

// loadRequestLogs restores the ring from disk and enables persistence. Only
// NewHandler calls it, so handlers built directly in tests never touch disk.
func (h *Handler) loadRequestLogs() {
	h.requestLogsPath = filepath.Join(config.GetConfigDir(), requestLogsFileName)
	f, err := os.Open(h.requestLogsPath)
	if err != nil {
		return
	}
	defer f.Close()
	var logs []RequestLog
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var e RequestLog
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue // a torn last line from a crash must not block startup
		}
		logs = append(logs, e)
		if len(logs) >= 2*requestLogsMaxSize {
			logs = append([]RequestLog(nil), logs[len(logs)-requestLogsMaxSize:]...)
		}
	}
	if len(logs) > requestLogsMaxSize {
		logs = logs[len(logs)-requestLogsMaxSize:]
	}
	h.requestLogsMu.Lock()
	h.requestLogs = logs
	h.requestLogsMu.Unlock()
}

// persistRequestLogLocked appends one entry; caller holds requestLogsMu.
func (h *Handler) persistRequestLogLocked(entry RequestLog) {
	if h.requestLogsPath == "" {
		return
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	f, err := os.OpenFile(h.requestLogsPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		logger.Warnf("[RequestLogs] persist failed: %v", err)
		return
	}
	_, werr := f.Write(append(line, '\n'))
	info, serr := f.Stat()
	f.Close()
	if werr != nil {
		logger.Warnf("[RequestLogs] persist failed: %v", werr)
		return
	}
	if serr == nil && info.Size() > requestLogsCompactBytes {
		h.rewriteRequestLogsLocked()
	}
}

// rewriteRequestLogsLocked replaces the file with the current ring; caller holds requestLogsMu.
func (h *Handler) rewriteRequestLogsLocked() {
	if h.requestLogsPath == "" {
		return
	}
	var buf bytes.Buffer
	for _, e := range h.requestLogs {
		if line, err := json.Marshal(e); err == nil {
			buf.Write(line)
			buf.WriteByte('\n')
		}
	}
	tmp := h.requestLogsPath + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		logger.Warnf("[RequestLogs] compact failed: %v", err)
		return
	}
	if err := os.Rename(tmp, h.requestLogsPath); err != nil {
		logger.Warnf("[RequestLogs] compact failed: %v", err)
	}
}
