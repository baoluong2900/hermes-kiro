package proxy

import (
	"bytes"
	"encoding/json"
	"testing"
)

// The upstream carries the thinking signature two ways: inline on the reasoning
// event, and as its own frame. Both must reach OnSignature — a signature the
// gateway never sees is a signature it can never hand back to the client, and
// the next turn then replays unsigned reasoning that the upstream rejects with
// 400 THINKING_SIGNATURE_INVALID.
func TestParseEventStreamSurfacesThinkingSignature(t *testing.T) {
	cases := []struct {
		name   string
		frames []map[string]interface{}
		events []string
		want   string
	}{
		{
			name:   "inline on reasoning event",
			events: []string{"reasoningContentEvent"},
			frames: []map[string]interface{}{{"text": "weighing options", "signature": "sig-inline"}},
			want:   "sig-inline",
		},
		{
			name:   "separate signature frame",
			events: []string{"reasoningContentEvent", "reasoningContentSignatureEvent"},
			frames: []map[string]interface{}{{"text": "weighing options"}, {"signature": "sig-frame"}},
			want:   "sig-frame",
		},
		{
			name:   "legacy signatureEvent spelling",
			events: []string{"signatureEvent"},
			frames: []map[string]interface{}{{"signature": "sig-legacy"}},
			want:   "sig-legacy",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stream bytes.Buffer
			for i, f := range tc.frames {
				stream.Write(awsEventStreamFrame(t, tc.events[i], f))
			}

			var got string
			err := parseEventStream(bytes.NewReader(stream.Bytes()), &KiroStreamCallback{
				OnSignature: func(sig string) { got = sig },
			})
			if err != nil {
				t.Fatalf("unexpected parse error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("signature: got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseEventStreamSurfacesRedactedReasoning(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": "blob-a"}))
	stream.Write(awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": "blob-b"}))

	var got []string
	err := parseEventStream(bytes.NewReader(stream.Bytes()), &KiroStreamCallback{
		OnRedactedReasoning: func(data string) { got = append(got, data) },
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(got) != 2 || got[0] != "blob-a" || got[1] != "blob-b" {
		t.Fatalf("redacted blobs: got %v, want [blob-a blob-b]", got)
	}
}

// A stream that produced nothing but a signature still did work upstream, so it
// must not be reported as an empty response (which would trigger a failover).
func TestParseEventStreamSignatureOnlyIsNotEmpty(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig"}))

	err := parseEventStream(bytes.NewReader(stream.Bytes()), &KiroStreamCallback{
		OnSignature: func(string) {},
	})
	if err != nil {
		t.Fatalf("signature-only stream reported as failure: %v", err)
	}
}

// A client that replays a signed thinking block must have the text/signature
// pair echoed back verbatim as reasoningContent, or adaptive thinking loses
// continuity across the tool-use turn.
func TestClaudeToKiroEchoesSignedThinking(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-5",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "list the files"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "thinking", "thinking": "I should call ls", "signature": "sig-abc"},
				map[string]interface{}{"type": "text", "text": "Listing now."},
			}},
			{Role: "user", Content: "thanks"},
		},
	}

	payload := ClaudeToKiro(req, false)

	var asst *KiroAssistantResponseMessage
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil && h.AssistantResponseMessage.Content == "Listing now." {
			asst = h.AssistantResponseMessage
		}
	}
	if asst == nil {
		t.Fatalf("assistant turn missing from history: %+v", payload.ConversationState.History)
	}
	if asst.ReasoningContent == nil || asst.ReasoningContent.ReasoningText == nil {
		t.Fatalf("expected reasoningContent to be echoed back, got %+v", asst.ReasoningContent)
	}
	if got := asst.ReasoningContent.ReasoningText.Signature; got != "sig-abc" {
		t.Fatalf("signature: got %q, want %q", got, "sig-abc")
	}
	if got := asst.ReasoningContent.ReasoningText.Text; got != "I should call ls" {
		t.Fatalf("thinking text: got %q", got)
	}
}

// Unsigned thinking must be dropped rather than forwarded: the upstream verifies
// the pair and answers 400 THINKING_SIGNATURE_INVALID for reasoning it cannot
// verify, which no retry and no other account can fix.
func TestClaudeToKiroDropsUnsignedThinking(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-5",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "hi"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "thinking", "thinking": "no signature here"},
				map[string]interface{}{"type": "text", "text": "Hello."},
			}},
			{Role: "user", Content: "again"},
		},
	}

	payload := ClaudeToKiro(req, false)
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil && h.AssistantResponseMessage.ReasoningContent != nil {
			t.Fatalf("unsigned thinking was forwarded upstream: %+v", h.AssistantResponseMessage.ReasoningContent)
		}
	}
}

// Several reasoning blocks cannot all fit Kiro's single reasoningContent slot.
// The last verifiable one wins and is copied verbatim — texts and signatures are
// never recombined across blocks, because Anthropic verifies them as a pair.
func TestClaudeToKiroKeepsLastSignedThinkingBlockVerbatim(t *testing.T) {
	blocks := []claudeReasoningBlock{
		{Text: "first", Signature: "sig-1"},
		{Text: "second", Signature: "sig-2"},
	}
	got := selectKiroReasoningContent(blocks)
	if got == nil || got.ReasoningText == nil {
		t.Fatalf("expected a reasoningContent, got %+v", got)
	}
	if got.ReasoningText.Text != "second" || got.ReasoningText.Signature != "sig-2" {
		t.Fatalf("expected the last signed pair verbatim, got %+v", got.ReasoningText)
	}
}

func TestClaudeToKiroEchoesRedactedThinking(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-5",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "hi"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "redacted_thinking", "data": "opaque-blob"},
				map[string]interface{}{"type": "text", "text": "Hello."},
			}},
			{Role: "user", Content: "again"},
		},
	}

	payload := ClaudeToKiro(req, false)
	found := false
	for _, h := range payload.ConversationState.History {
		rc := (*KiroReasoningContent)(nil)
		if h.AssistantResponseMessage != nil {
			rc = h.AssistantResponseMessage.ReasoningContent
		}
		if rc != nil && rc.RedactedContent == "opaque-blob" {
			found = true
			if rc.ReasoningText != nil {
				t.Fatalf("redacted-only turn must not carry a reasoningText: %+v", rc)
			}
		}
	}
	if !found {
		t.Fatalf("redacted reasoning was not echoed back: %+v", payload.ConversationState.History)
	}
}

// The non-streaming Claude response must carry the signature on the thinking
// block, and one redacted_thinking block per opaque blob — a block is the unit
// Anthropic verifies and echoes back, so blobs must not be collapsed.
func TestKiroToClaudeResponseWithSignature(t *testing.T) {
	resp := KiroToClaudeResponseWithSignature("answer", "reasoned", "sig-xyz",
		[]string{"blob-a", "blob-b"}, false, nil, 10, 20, "claude-sonnet-5")

	if len(resp.Content) != 4 {
		t.Fatalf("expected thinking + 2 redacted + text blocks, got %d: %+v", len(resp.Content), resp.Content)
	}
	if resp.Content[0].Type != "thinking" || resp.Content[0].Signature != "sig-xyz" {
		t.Fatalf("thinking block missing its signature: %+v", resp.Content[0])
	}
	if resp.Content[1].Type != "redacted_thinking" || resp.Content[1].Data != "blob-a" {
		t.Fatalf("first redacted block wrong: %+v", resp.Content[1])
	}
	if resp.Content[2].Type != "redacted_thinking" || resp.Content[2].Data != "blob-b" {
		t.Fatalf("second redacted block wrong: %+v", resp.Content[2])
	}
	if resp.Content[3].Type != "text" {
		t.Fatalf("text block wrong: %+v", resp.Content[3])
	}
}

// display=omitted produces a signature with no reasoning text. The block still
// has to exist, or there is nowhere to carry the signature back.
func TestKiroToClaudeResponseEmitsThinkingBlockForSignatureAlone(t *testing.T) {
	resp := KiroToClaudeResponseWithSignature("answer", "", "sig-only", nil, false, nil, 1, 2, "claude-sonnet-5")
	if len(resp.Content) == 0 || resp.Content[0].Type != "thinking" || resp.Content[0].Signature != "sig-only" {
		t.Fatalf("expected a thinking block carrying the signature, got %+v", resp.Content)
	}
}

// Round-trip: what the gateway emits must be accepted back by its own parser.
func TestThinkingSignatureSurvivesClientRoundTrip(t *testing.T) {
	resp := KiroToClaudeResponseWithSignature("answer", "reasoned", "sig-round", nil, false,
		[]KiroToolUse{{ToolUseID: "toolu_1", Name: "ls", Input: map[string]interface{}{}}}, 1, 2, "claude-sonnet-5")

	encoded, err := json.Marshal(resp.Content)
	if err != nil {
		t.Fatalf("marshal response content: %v", err)
	}
	var replayed []interface{}
	if err := json.Unmarshal(encoded, &replayed); err != nil {
		t.Fatalf("unmarshal replayed content: %v", err)
	}

	_, toolUses, reasoning := extractClaudeAssistantContentWithThinking(replayed)
	if len(toolUses) != 1 {
		t.Fatalf("tool use lost in round trip: %+v", toolUses)
	}
	rc := selectKiroReasoningContent(reasoning)
	if rc == nil || rc.ReasoningText == nil || rc.ReasoningText.Signature != "sig-round" {
		t.Fatalf("signature lost in round trip: %+v", rc)
	}
}

// The OpenAI path has to hand the signature to the client too, otherwise a
// client that preserves reasoning_content replays it unsigned.
func TestKiroToOpenAIResponseCarriesSignature(t *testing.T) {
	resp := KiroToOpenAIResponseWithReasoningSignature("answer", "reasoned", "sig-oai", nil, 1, 2, "claude-sonnet-5", "reasoning_content")
	choices := resp["choices"].([]map[string]interface{})
	msg := choices[0]["message"].(map[string]interface{})
	if msg["signature"] != "sig-oai" {
		t.Fatalf("expected signature on the OpenAI message, got %+v", msg)
	}

	// The <think> format folds reasoning into the answer text: nothing is left
	// for a signature to sign, so it must not be emitted.
	resp = KiroToOpenAIResponseWithReasoningSignature("answer", "reasoned", "sig-oai", nil, 1, 2, "claude-sonnet-5", "think")
	choices = resp["choices"].([]map[string]interface{})
	msg = choices[0]["message"].(map[string]interface{})
	if _, ok := msg["signature"]; ok {
		t.Fatalf("signature must not be emitted in <think> format: %+v", msg)
	}
}

func TestOpenAIToKiroEchoesSignedReasoning(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-sonnet-5",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "hi"},
			{Role: "assistant", Content: "Hello.", ReasoningContent: "thought", Signature: "sig-oai"},
			{Role: "user", Content: "again"},
		},
	}

	payload := OpenAIToKiro(req, false)
	found := false
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage == nil || h.AssistantResponseMessage.ReasoningContent == nil {
			continue
		}
		rt := h.AssistantResponseMessage.ReasoningContent.ReasoningText
		if rt != nil && rt.Signature == "sig-oai" && rt.Text == "thought" {
			found = true
		}
	}
	if !found {
		t.Fatalf("signed reasoning_content was not echoed back: %+v", payload.ConversationState.History)
	}
}

func TestOpenAIToKiroDropsUnsignedReasoning(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-sonnet-5",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "hi"},
			{Role: "assistant", Content: "Hello.", ReasoningContent: "thought"},
			{Role: "user", Content: "again"},
		},
	}

	payload := OpenAIToKiro(req, false)
	for _, h := range payload.ConversationState.History {
		if h.AssistantResponseMessage != nil && h.AssistantResponseMessage.ReasoningContent != nil {
			t.Fatalf("unsigned reasoning_content was forwarded: %+v", h.AssistantResponseMessage.ReasoningContent)
		}
	}
}
