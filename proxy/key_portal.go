package proxy

import (
	"encoding/json"
	"kiro-go/config"
	"net/http"
	"os"
	"strings"
	"time"
)

// Public API-key quota checker, ported from the edge Worker (handleQuotaCheck) so
// /key, /check, /quota keep working after the domains moved to the Go server.
// web/key.html is the Worker's renderQuotaCheckHtml output with origin "__KIRO_ORIGIN__".

func isKeyPortalPath(path string) bool {
	switch path {
	case "/check", "/quota", "/v1/check", "/key", "/keys", "/v1/key", "/v1/keys", "/v1/quota", "/check-key":
		return true
	}
	return strings.HasPrefix(path, "/check/") || strings.HasPrefix(path, "/key/") || strings.HasPrefix(path, "/quota/")
}

func keyPortalRawKey(w http.ResponseWriter, r *http.Request, path string) string {
	q := r.URL.Query()
	for _, name := range []string{"key", "api_key", "token", "k"} {
		if v := strings.TrimSpace(q.Get(name)); v != "" {
			return v
		}
	}
	for _, prefix := range []string{"/check/", "/key/", "/quota/"} {
		if strings.HasPrefix(path, prefix) {
			if v := strings.TrimSpace(strings.TrimPrefix(path, prefix)); v != "" {
				return v
			}
		}
	}
	if r.Method == http.MethodPost {
		var b struct {
			Key     string `json:"key"`
			APIKey  string `json:"apiKey"`
			APIKey2 string `json:"api_key"`
			Token   string `json:"token"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) == nil {
			for _, v := range []string{b.Key, b.APIKey, b.APIKey2, b.Token} {
				if v = strings.TrimSpace(v); v != "" {
					return v
				}
			}
		}
	}
	for _, name := range []string{"Authorization", "X-Api-Key", "Anthropic-Auth-Token", "X-Anthropic-Auth-Token", "Api-Key"} {
		if v := strings.TrimSpace(r.Header.Get(name)); v != "" {
			return strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(v, "Bearer "), "bearer "))
		}
	}
	return ""
}

// keyPortalLogs returns this key's entries from the in-memory request log (newest
// first), without account IDs or client IPs.
func (h *Handler) keyPortalLogs(keyID string) []map[string]interface{} {
	out := []map[string]interface{}{}
	for _, l := range h.getRequestLogs() {
		if l.ApiKeyID != keyID {
			continue
		}
		kind := "openai"
		if l.Endpoint == "claude" {
			kind = "anthropic"
		}
		out = append(out, map[string]interface{}{
			"time": l.Time, "model": l.Model, "kind": kind, "status": l.Status, "success": l.Status == "success",
			"error": l.Error, "totalTokens": l.Tokens, "tokens": l.Tokens, "inputTokens": l.InputTokens, "outputTokens": l.OutputTokens, "cacheReadTokens": l.CacheReadTokens, "cacheWriteTokens": l.CacheWriteTokens, "credits": l.Credits, "duration": l.Duration,
		})
	}
	return out
}

func keyPortalPayload(e *config.ApiKeyEntry, logs []map[string]interface{}) map[string]interface{} {
	now := time.Now().Unix()
	expired := e.ExpiresAt > 0 && now >= e.ExpiresAt
	status := "active"
	if !e.Enabled {
		status = "disabled"
	} else if expired || (e.CreditLimit > 0 && e.CreditsUsed >= e.CreditLimit) || (e.TokenLimit > 0 && e.TokensUsed >= e.TokenLimit) {
		status = "quota_exceeded"
	}
	var remainingCredits, remainingTokens interface{} = "unlimited", "unlimited"
	if e.CreditLimit > 0 {
		remainingCredits = max(0, e.CreditLimit-e.CreditsUsed)
	}
	if e.TokenLimit > 0 {
		remainingTokens = max(0, e.TokenLimit-e.TokensUsed)
	}
	name := e.Name
	if name == "" {
		name = "API Key"
	}
	return map[string]interface{}{
		"success": true, "name": name, "key_name": name,
		"key_masked": config.MaskApiKey(e.Key), "enabled": e.Enabled, "status": status,
		"expires_at": e.ExpiresAt, "expired": expired,
		"credit_limit": e.CreditLimit, "credits_used": e.CreditsUsed, "remaining_credits": remainingCredits,
		// shortcut: Go tracks only a token total per key, so in/out split is unknown; logs are in-memory (last 500, reset on restart).
		"token_limit": e.TokenLimit, "tokens_in": 0, "tokens_out": 0, "tokens_used": e.TokensUsed, "remaining_tokens": remainingTokens,
		"requests_count": e.RequestsCount, "model_usage": map[string]interface{}{},
		"created_at": e.CreatedAt, "last_used_at": e.LastUsedAt,
		"recent_logs": logs, "live": true, "server_time": now,
	}
}

func (h *Handler) handleKeyPortal(w http.ResponseWriter, r *http.Request, path string) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	accept := r.Header.Get("Accept")
	format := strings.ToLower(r.URL.Query().Get("format"))
	asJSON := format == "json" || r.URL.Query().Get("json") == "1" || r.URL.Query().Get("json") == "true" ||
		(strings.Contains(accept, "application/json") && !strings.Contains(accept, "text/html") && !strings.Contains(accept, "*/*"))

	rawKey := keyPortalRawKey(w, r, path)
	// Exact match only: the Worker's id/prefix matching would let a key ID or partial key read usage.
	entry := config.FindApiKeyByValue(rawKey)

	if asJSON {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		switch {
		case rawKey == "":
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "Missing ?key parameter"})
		case entry == nil:
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"error": "API Key not found"})
		default:
			json.NewEncoder(w).Encode(keyPortalPayload(entry, h.keyPortalLogs(entry.ID)))
		}
		return
	}

	page, err := os.ReadFile("web/key.html")
	if err != nil {
		http.Error(w, "key portal unavailable", http.StatusInternalServerError)
		return
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	html := strings.ReplaceAll(string(page), "__KIRO_ORIGIN__", scheme+"://"+r.Host)
	if entry != nil {
		keyJSON, _ := json.Marshal(rawKey) // json.Marshal escapes <, > and & for safe inlining
		logs := h.keyPortalLogs(entry.ID)
		dataJSON, _ := json.Marshal(keyPortalPayload(entry, logs))
		logsJSON, _ := json.Marshal(logs)
		html = strings.Replace(html, `var activeKey = "";`, "var activeKey = "+string(keyJSON)+";", 1)
		html = strings.Replace(html, "var initialData = null;", "var initialData = "+string(dataJSON)+";", 1)
		html = strings.Replace(html, "var initialLogs = [];", "var initialLogs = "+string(logsJSON)+";", 1)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(html))
}
