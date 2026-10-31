package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Regression tests for the Kiro-Go port of the thinking/tool/no-truncation
// pipeline. Symptom that started it: /v1/messages returned
// {"type":"thinking","thinking":""} with no signature, so the next turn could
// not replay the reasoning.

// Thinking used to be requested by injecting <thinking_mode> into the system
// prompt whenever native thinking was unavailable. That produced unsigned
// <thinking> prose. No translator may inject it any more.
func TestTranslatorsNeverInjectThinkingPrompt(t *testing.T) {
	claude := ClaudeToKiro(&ClaudeRequest{
		Model:    "claude-sonnet-4.6",
		System:   "be brief",
		Thinking: &ClaudeThinkingConfig{Type: "enabled", BudgetTokens: 2048},
		Messages: []ClaudeMessage{{Role: "user", Content: "hi"}},
	})
	openai := OpenAIToKiro(&OpenAIRequest{
		Model:           "claude-sonnet-4.6",
		ReasoningEffort: "high",
		Messages: []OpenAIMessage{
			{Role: "system", Content: "be brief"},
			{Role: "user", Content: "hi"},
		},
	})
	for name, payload := range map[string]*KiroPayload{"claude": claude, "openai": openai} {
		body, _ := json.Marshal(payload)
		if strings.Contains(string(body), "thinking_mode") || strings.Contains(string(body), "max_thinking_length") {
			t.Fatalf("%s payload carries a prompt-injected thinking directive: %s", name, body)
		}
	}
}

// Upstream text is passed through verbatim: <thinking> written by the model is
// its answer, not reasoning to be parsed out.
func TestClaudeStreamKeepsThinkingTagsInAnswerText(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "use <thinking>x</thinking> tags"}),
	)
	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{})
	var text strings.Builder
	for _, blk := range collectBlocks(t, events) {
		if blk.Type == "thinking" {
			t.Fatalf("answer text was turned into a thinking block: %+v", blk)
		}
		for _, d := range blk.Deltas {
			if s, ok := d["text"].(string); ok {
				text.WriteString(s)
			}
		}
	}
	if text.String() != "use <thinking>x</thinking> tags" {
		t.Fatalf("answer text altered: %q", text.String())
	}
}

// A signature that arrives after answer text already closed the reasoning
// block must still reach the client, paired with the text it signs. Before the
// port it was emitted on an empty block, a pair that cannot verify.
func TestClaudeStreamPairsLateSignatureWithItsReasoning(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "n"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "The limit is 1/2."}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-late"}),
	)
	events := runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{})

	var signed *streamBlock
	blocks := collectBlocks(t, events)
	for i := range blocks {
		for _, d := range blocks[i].Deltas {
			if d["type"] == "signature_delta" && d["signature"] == "sig-late" {
				signed = &blocks[i]
			}
		}
	}
	if signed == nil {
		t.Fatalf("late signature was dropped: %+v", blocks)
	}
	var thought string
	for _, d := range signed.Deltas {
		if s, ok := d["thinking"].(string); ok {
			thought += s
		}
	}
	if thought != "n" {
		t.Fatalf("late signature not paired with its reasoning text, got %q", thought)
	}
}

// Reasoning that arrives after the answer started is held back and emitted as
// one signed block once the signature comes, instead of splitting the answer.
func TestClaudeStreamEmitsLateSignedReasoningAsOneBlock(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "Answer first."}),
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "late thought"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-after"}),
	)
	blocks := collectBlocks(t, runClaudeStream(t, simpleClaudeRequest(), true, claudeThinkingResponseOptions{}))
	if len(blocks) != 2 || blocks[0].Type != "text" || blocks[1].Type != "thinking" {
		t.Fatalf("expected text then one signed thinking block, got %+v", blocks)
	}
	types := deltaTypes(blocks[1])
	if len(types) != 2 || types[0] != "thinking_delta" || types[1] != "signature_delta" {
		t.Fatalf("late reasoning block malformed: %v", types)
	}
}

// Non-stream: the thinking block carries the upstream signature.
func TestClaudeNonStreamThinkingCarriesSignature(t *testing.T) {
	upstreamStream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "n"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-ns"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "**The limit is 1/2.**"}),
	)
	h := &Handler{
		pool:        poolWithTestAccount(t),
		sticky:      newStickyRouter(),
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL),
	}
	req := simpleClaudeRequest()
	rec := httptest.NewRecorder()
	httpReq := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte("{}")))
	h.handleClaudeNonStream(rec, httpReq, nil, req, ClaudeToKiro(req), req.Model, true, claudeThinkingResponseOptions{}, 10, nil, "", false)

	var resp ClaudeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad response %q: %v", rec.Body.String(), err)
	}
	if len(resp.Content) != 2 || resp.Content[0].Type != "thinking" {
		t.Fatalf("expected thinking then text, got %+v", resp.Content)
	}
	if resp.Content[0].Thinking != "n" || resp.Content[0].Signature != "sig-ns" {
		t.Fatalf("thinking block lost its text or signature: %+v", resp.Content[0])
	}
	if resp.Content[1].Text != "**The limit is 1/2.**" {
		t.Fatalf("answer text altered: %q", resp.Content[1].Text)
	}
}

// Large requests reach the upstream whole: no history is dropped, no
// placeholder is inserted, the current message and tool descriptions are not
// clipped.
func TestLargeRequestIsNeverTruncated(t *testing.T) {
	big := strings.Repeat("0123456789", 300_000) // 3 MB
	desc := strings.Repeat("describe the tool. ", 2000)
	messages := []ClaudeMessage{}
	for i := 0; i < 20; i++ {
		messages = append(messages,
			ClaudeMessage{Role: "user", Content: big[:100_000]},
			ClaudeMessage{Role: "assistant", Content: "ok"})
	}
	messages = append(messages, ClaudeMessage{Role: "user", Content: big})
	payload := ClaudeToKiro(&ClaudeRequest{
		Model:    "claude-sonnet-4.6",
		Messages: messages,
		Tools:    []ClaudeTool{{Name: "probe_tool", Description: desc, InputSchema: map[string]interface{}{"type": "object"}}},
	})

	if got := payload.ConversationState.CurrentMessage.UserInputMessage.Content; got != big {
		t.Fatalf("current message clipped: %d of %d bytes", len(got), len(big))
	}
	if got := len(payload.ConversationState.History); got != 40 {
		t.Fatalf("history turns dropped: %d of 40", got)
	}
	body, _ := json.Marshal(payload)
	if strings.Contains(string(body), "truncated") {
		t.Fatal("a truncation marker was injected")
	}
	tools := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext.Tools
	if tools[0].ToolSpecification.Description != desc {
		t.Fatalf("tool description clipped: %d of %d chars", len(tools[0].ToolSpecification.Description), len(desc))
	}

	var openaiTool OpenAITool
	openaiTool.Type = "function"
	openaiTool.Function.Name = "probe"
	openaiTool.Function.Description = desc
	openaiTools := convertOpenAITools([]OpenAITool{openaiTool})
	if openaiTools[0].ToolSpecification.Description != desc {
		t.Fatal("OpenAI tool description clipped")
	}
}

// Tool arguments that are not valid JSON used to become an empty-input
// tool_use, so the client ran the tool with no arguments.
func TestMalformedToolArgumentsFailTheTurn(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
		"toolUseId": "toolu_1", "name": "readFile", "input": `{"path": "/tmp/a`,
	}))
	stream.Write(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
		"toolUseId": "toolu_1", "name": "readFile", "stop": true,
	}))
	var emitted []KiroToolUse
	err := parseEventStream(&stream, &KiroStreamCallback{OnToolUse: func(tu KiroToolUse) { emitted = append(emitted, tu) }})
	var malformed *MalformedToolUseError
	if !errors.As(err, &malformed) {
		t.Fatalf("expected MalformedToolUseError, got %v", err)
	}
	if len(emitted) != 0 {
		t.Fatalf("a tool call with broken arguments was emitted: %+v", emitted)
	}
}

// An oversized input is reported once as a 400 with Anthropic's wording so the
// client compacts and retries; it is not retried on every account.
func TestInputTooLongReturns400(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`))
	}))
	t.Cleanup(server.Close)
	redirectKiroTrafficTo(t, server)

	h := &Handler{
		pool:        poolWithTestAccount(t),
		sticky:      newStickyRouter(),
		promptCache: newPromptCacheTracker(defaultPromptCacheTTL),
	}
	req := simpleClaudeRequest()
	rec := httptest.NewRecorder()
	httpReq := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte("{}")))
	h.handleClaudeNonStream(rec, httpReq, nil, req, ClaudeToKiro(req), req.Model, false, claudeThinkingResponseOptions{}, 1234, nil, "", false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "prompt is too long: 1234 tokens") || !strings.Contains(body, "invalid_request_error") {
		t.Fatalf("client cannot recognise the overflow: %s", body)
	}
	if calls != 1 {
		t.Fatalf("an oversized input was sent upstream %d times", calls)
	}
}
