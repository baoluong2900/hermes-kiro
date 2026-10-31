package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-go/config"
	"kiro-go/pool"
)

// upstreamStream stands up a Kiro upstream that replays the given event-stream
// frames verbatim and points the gateway's HTTP client at it. It also resets
// config to a temp file, so the account registered afterwards is the only one
// the pool can route to.
func upstreamStream(t *testing.T, frames ...[]byte) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		w.WriteHeader(http.StatusOK)
		for _, f := range frames {
			_, _ = w.Write(f)
		}
	}))
	t.Cleanup(server.Close)
	redirectKiroTrafficTo(t, server)
}

// sseEvent is one parsed `event:`/`data:` pair from the response body.
type sseEvent struct {
	Name string
	Data map[string]interface{}
}

func parseSSE(t *testing.T, body string) []sseEvent {
	t.Helper()
	var events []sseEvent
	for _, chunk := range strings.Split(body, "\n\n") {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		var name, data string
		for _, line := range strings.Split(chunk, "\n") {
			if rest, ok := strings.CutPrefix(line, "event: "); ok {
				name = rest
			} else if rest, ok := strings.CutPrefix(line, "data: "); ok {
				data = rest
			}
		}
		if name == "" {
			continue
		}
		parsed := map[string]interface{}{}
		if data != "" {
			if err := json.Unmarshal([]byte(data), &parsed); err != nil {
				t.Fatalf("event %s carried invalid JSON %q: %v", name, data, err)
			}
		}
		events = append(events, sseEvent{Name: name, Data: parsed})
	}
	return events
}

// runClaudeStream drives the real streaming handler end to end and returns the
// parsed SSE events the client would have seen.
func runClaudeStream(t *testing.T, req *ClaudeRequest, thinking bool, opts claudeThinkingResponseOptions) []sseEvent {
	t.Helper()

	h := &Handler{
		pool:        poolWithTestAccount(t),
		sticky:      newStickyRouter(),
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL),
	}
	payload := ClaudeToKiro(req, false)
	rec := httptest.NewRecorder()
	httpReq := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte("{}")))

	h.handleClaudeStream(rec, httpReq, nil, req, payload, req.Model, thinking, opts, 10, nil, "", false)

	return parseSSE(t, rec.Body.String())
}

// findBlocks groups the stream's content_block_* events by index so a test can
// assert on one block's whole lifecycle.
type streamBlock struct {
	Index  int
	Type   string
	Start  map[string]interface{}
	Deltas []map[string]interface{}
	Closed bool
}

func collectBlocks(t *testing.T, events []sseEvent) []streamBlock {
	t.Helper()
	byIndex := map[int]*streamBlock{}
	order := []int{}
	for _, ev := range events {
		idxF, ok := ev.Data["index"].(float64)
		if !ok {
			continue
		}
		idx := int(idxF)
		blk, seen := byIndex[idx]
		if !seen {
			blk = &streamBlock{Index: idx}
			byIndex[idx] = blk
			order = append(order, idx)
		}
		switch ev.Name {
		case "content_block_start":
			cb, _ := ev.Data["content_block"].(map[string]interface{})
			blk.Start = cb
			blk.Type, _ = cb["type"].(string)
		case "content_block_delta":
			d, _ := ev.Data["delta"].(map[string]interface{})
			blk.Deltas = append(blk.Deltas, d)
		case "content_block_stop":
			blk.Closed = true
		}
	}
	out := make([]streamBlock, 0, len(order))
	for _, idx := range order {
		out = append(out, *byIndex[idx])
	}
	return out
}

func deltaTypes(blk streamBlock) []string {
	types := make([]string, 0, len(blk.Deltas))
	for _, d := range blk.Deltas {
		tp, _ := d["type"].(string)
		types = append(types, tp)
	}
	return types
}

// The whole point of the feature: a turn whose upstream carried a signature must
// reach the client as a thinking block that ends with signature_delta, then
// content_block_stop. Without it, Claude Code replays unsigned thinking on the
// next turn and the upstream answers 400 THINKING_SIGNATURE_INVALID.
func TestClaudeStreamEmitsSignatureDelta(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "weighing the options"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-stream"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Here is the answer."}),
	)

	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{Format: "thinking"})
	blocks := collectBlocks(t, events)
	if len(blocks) < 2 {
		t.Fatalf("expected a thinking block and a text block, got %d: %+v", len(blocks), blocks)
	}

	thinkingBlock := blocks[0]
	if thinkingBlock.Type != "thinking" {
		t.Fatalf("first block should be thinking, got %q", thinkingBlock.Type)
	}
	// content_block_start must declare the signature field, matching Anthropic's
	// wire shape; strict clients key on its presence.
	if _, ok := thinkingBlock.Start["signature"]; !ok {
		t.Fatalf("thinking content_block_start missing the signature field: %+v", thinkingBlock.Start)
	}
	if !thinkingBlock.Closed {
		t.Fatalf("thinking block was never closed: %+v", thinkingBlock)
	}

	types := deltaTypes(thinkingBlock)
	if len(types) < 2 || types[len(types)-1] != "signature_delta" {
		t.Fatalf("signature_delta must be the last delta of the thinking block, got %v", types)
	}
	last := thinkingBlock.Deltas[len(thinkingBlock.Deltas)-1]
	if last["signature"] != "sig-stream" {
		t.Fatalf("signature value lost: %+v", last)
	}
	if blocks[1].Type != "text" {
		t.Fatalf("answer text should follow the thinking block, got %q", blocks[1].Type)
	}
}

// display=omitted upstream sends a signature with no reasoning text at all.
// There is still nowhere else to carry it, so a thinking block has to be opened
// for it rather than dropping the signature.
func TestClaudeStreamEmitsSignatureWithoutReasoningText(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-omitted"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Answer."}),
	)

	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{Format: "thinking"})
	blocks := collectBlocks(t, events)

	var signed *streamBlock
	for i := range blocks {
		if blocks[i].Type == "thinking" {
			signed = &blocks[i]
		}
	}
	if signed == nil {
		t.Fatalf("no thinking block was opened for the detached signature: %+v", blocks)
	}
	types := deltaTypes(*signed)
	if len(types) != 1 || types[0] != "signature_delta" {
		t.Fatalf("expected exactly one signature_delta, got %v", types)
	}
	if !signed.Closed {
		t.Fatalf("signature block was never closed: %+v", signed)
	}
}

// Opaque reasoning blobs round-trip as their own redacted_thinking blocks — one
// per blob, because a block is the unit the client echoes back verbatim.
func TestClaudeStreamEmitsRedactedThinkingBlocks(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": "blob-a"}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": "blob-b"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Answer."}),
	)

	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{Format: "thinking"})

	var blobs []string
	for _, blk := range collectBlocks(t, events) {
		if blk.Type != "redacted_thinking" {
			continue
		}
		if !blk.Closed {
			t.Fatalf("redacted block %d was never closed", blk.Index)
		}
		data, _ := blk.Start["data"].(string)
		blobs = append(blobs, data)
	}
	if len(blobs) != 2 || blobs[0] != "blob-a" || blobs[1] != "blob-b" {
		t.Fatalf("redacted blobs lost or merged: %v", blobs)
	}
}

// Reasoning that arrives in two runs, each signed, becomes two separate blocks:
// one signature per block is the contract, and merging them would produce a
// text/signature pair that cannot verify.
func TestClaudeStreamSplitsBlockPerSignature(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "first thought"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-1"}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "second thought"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-2"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Answer."}),
	)

	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{Format: "thinking"})

	var sigs []string
	thinkingBlocks := 0
	for _, blk := range collectBlocks(t, events) {
		if blk.Type != "thinking" {
			continue
		}
		thinkingBlocks++
		count := 0
		for _, d := range blk.Deltas {
			if d["type"] == "signature_delta" {
				count++
				sig, _ := d["signature"].(string)
				sigs = append(sigs, sig)
			}
		}
		if count != 1 {
			t.Fatalf("block %d carried %d signatures; the contract is exactly one", blk.Index, count)
		}
	}
	if thinkingBlocks != 2 {
		t.Fatalf("expected two thinking blocks, got %d", thinkingBlocks)
	}
	if len(sigs) != 2 || sigs[0] != "sig-1" || sigs[1] != "sig-2" {
		t.Fatalf("signatures not kept with their own block: %v", sigs)
	}
}

// With reasoning rendering off, the client never asked for thinking: a thinking
// block it did not request must not appear just because upstream signed one.
func TestClaudeStreamDropsSignatureWhenThinkingOff(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-unused"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Answer."}),
	)

	events := runClaudeStream(t, simpleClaudeRequest(), false, claudeThinkingResponseOptions{Format: "thinking"})
	for _, blk := range collectBlocks(t, events) {
		if blk.Type == "thinking" {
			t.Fatalf("thinking block emitted while rendering is off: %+v", blk)
		}
	}
	if !strings.Contains(sseBodyOf(events), "signature_delta") {
		return // expected: no signature anywhere
	}
	t.Fatalf("signature_delta leaked into a non-thinking stream")
}

// The stream has to stay a valid Anthropic envelope: message_start first,
// message_stop last, every block closed.
func TestClaudeStreamEnvelopeStaysValidWithSignature(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "thinking", "signature": "sig-inline"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Answer."}),
	)

	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{Format: "thinking"})
	if len(events) == 0 {
		t.Fatal("stream produced no events")
	}
	if events[0].Name != "message_start" {
		t.Fatalf("stream must open with message_start, got %q", events[0].Name)
	}
	if events[len(events)-1].Name != "message_stop" {
		t.Fatalf("stream must close with message_stop, got %q", events[len(events)-1].Name)
	}
	for _, blk := range collectBlocks(t, events) {
		if !blk.Closed {
			t.Fatalf("block %d (%s) left open", blk.Index, blk.Type)
		}
	}
}

func sseBodyOf(events []sseEvent) string {
	var b strings.Builder
	for _, ev := range events {
		data, _ := json.Marshal(ev.Data)
		b.WriteString(ev.Name)
		b.Write(data)
	}
	return b.String()
}

func simpleClaudeRequest() *ClaudeRequest {
	return &ClaudeRequest{
		Model:     "claude-sonnet-5",
		MaxTokens: 1024,
		Messages:  []ClaudeMessage{{Role: "user", Content: "hello"}},
	}
}

// poolWithTestAccount registers a single API-key account and returns the live
// pool. config was already pointed at a temp file by redirectKiroTrafficTo, so
// this account is the only one the pool can route to.
func poolWithTestAccount(t *testing.T) *pool.AccountPool {
	t.Helper()
	acct := config.Account{
		ID:         "stream-test-account",
		Nickname:   "stream-test",
		Enabled:    true,
		AuthMethod: "api_key",
		KiroApiKey: "ksk_stream_test",
		Region:     "us-east-1",
	}
	if err := config.AddAccount(acct); err != nil {
		t.Fatalf("add test account: %v", err)
	}
	p := pool.GetPool()
	p.Reload()
	// The singleton outlives the test; put it back on a config with no accounts
	// so a later test cannot route to this one.
	t.Cleanup(p.Reload)
	return p
}
