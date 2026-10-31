package proxy

import (
	"bytes"
	"testing"
)

// The whole point of honoring the upstream reason: Kiro closes a response that
// hit the output-token cap exactly like a complete one — same accounting
// events, clean EOF. Inference therefore reports it as end_turn and the client
// believes a cut-off answer is finished. Only the metadataEvent says otherwise.
func TestMaxTokensIsNotReportedAsEndTurn(t *testing.T) {
	inferred := claudeStopReason(0, true, true)
	if inferred != "end_turn" {
		t.Fatalf("precondition: inference should give end_turn here, got %q", inferred)
	}
	if got := resolveClaudeStopReason("MAX_TOKENS", 0, true, true); got != "max_tokens" {
		t.Fatalf("upstream MAX_TOKENS must win over inference, got %q", got)
	}
	if got := resolveOpenAIFinishReason("MAX_TOKENS", 0, true, true); got != "length" {
		t.Fatalf("OpenAI finish_reason for MAX_TOKENS should be length, got %q", got)
	}
}

func TestUpstreamStopReasonMapping(t *testing.T) {
	claude := map[string]string{
		"END_TURN": "end_turn", "MAX_TOKENS": "max_tokens", "TOOL_USE": "tool_use",
		"STOP_SEQUENCE": "stop_sequence", "PAUSE_TURN": "pause_turn",
		"MODEL_CONTEXT_WINDOW_EXCEEDED": "model_context_window_exceeded",
		"REFUSAL":                       "refusal", "GUARDRAIL_INTERVENED": "refusal",
		// Tokens arrive in varying shapes; folding is part of the contract.
		"end-turn": "end_turn", "  max_tokens  ": "max_tokens",
		// Unknown values fall back to inference, signalled by "".
		"SOMETHING_NEW": "",
	}
	for upstream, want := range claude {
		if got := mapUpstreamClaudeStopReason(upstream); got != want {
			t.Fatalf("claude %q: got %q, want %q", upstream, got, want)
		}
	}

	openai := map[string]string{
		"END_TURN": "stop", "PAUSE_TURN": "stop", "MAX_TOKENS": "length",
		"MODEL_CONTEXT_WINDOW_EXCEEDED": "length", "TOOL_USE": "tool_calls",
		"CONTENT_FILTERED": "content_filter", "": "",
	}
	for upstream, want := range openai {
		if got := mapUpstreamOpenAIFinishReason(upstream); got != want {
			t.Fatalf("openai %q: got %q, want %q", upstream, got, want)
		}
	}
}

// Upstream sometimes labels a completed tool turn END_TURN. An Anthropic client
// must see tool_use or it will never execute the call, so that one value is
// overridden — but a truncation or refusal must survive even with tool blocks.
func TestToolUseOverridesEndTurnOnly(t *testing.T) {
	if got := resolveClaudeStopReason("END_TURN", 1, true, true); got != "tool_use" {
		t.Fatalf("a tool turn labelled END_TURN must become tool_use, got %q", got)
	}
	if got := resolveClaudeStopReason("MAX_TOKENS", 1, true, true); got != "max_tokens" {
		t.Fatalf("truncation must survive alongside tool blocks, got %q", got)
	}
	if got := resolveClaudeStopReason("REFUSAL", 1, true, true); got != "refusal" {
		t.Fatalf("refusal must survive alongside tool blocks, got %q", got)
	}
	if got := resolveOpenAIFinishReason("END_TURN", 1, true, true); got != "tool_calls" {
		t.Fatalf("openai tool turn labelled END_TURN must become tool_calls, got %q", got)
	}
}

// With no upstream reason (connection dropped before the metadataEvent), the
// legacy inference still applies: content with no terminal accounting events
// means the stream was physically cut off.
func TestFallsBackToInferenceWithoutUpstreamReason(t *testing.T) {
	if got := resolveClaudeStopReason("", 0, true, false); got != "max_tokens" {
		t.Fatalf("a cut-off stream should infer max_tokens, got %q", got)
	}
	if got := resolveClaudeStopReason("", 0, true, true); got != "end_turn" {
		t.Fatalf("a clean stream should infer end_turn, got %q", got)
	}
	if got := resolveClaudeStopReason("", 2, false, true); got != "tool_use" {
		t.Fatalf("tool calls should infer tool_use, got %q", got)
	}
}

// The parser must surface the metadataEvent reason, or none of the above runs.
func TestParseEventStreamSurfacesStopReason(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hi"}))
	stream.Write(awsEventStreamFrame(t, "metadataEvent", map[string]interface{}{"stopReason": "MAX_TOKENS"}))

	var got string
	err := parseEventStream(bytes.NewReader(stream.Bytes()), &KiroStreamCallback{
		OnText:       func(string, bool) {},
		OnStopReason: func(r string) { got = r },
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got != "MAX_TOKENS" {
		t.Fatalf("stop reason not surfaced: %q", got)
	}
}
