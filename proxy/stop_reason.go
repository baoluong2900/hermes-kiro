package proxy

import "strings"

// Stop-reason resolution.
//
// Kiro's streaming protocol DOES report why generation stopped: the terminal
// metadataEvent carries an authoritative stopReason (e.g. "END_TURN",
// "MAX_TOKENS", "TOOL_USE"), followed by the accounting events
// (contextUsageEvent + meteringEvent). We honor that value first and only fall
// back to inference when the upstream reason is absent (e.g. the connection
// dropped before the metadataEvent arrived).
//
// The legacy inference (kept as a fallback) works as follows:
//
//   - tool calls present            -> tool_use / tool_calls
//   - content produced but the
//     stream ended WITHOUT the
//     terminal accounting events     -> max_tokens / length (truncated)
//   - otherwise                     -> end_turn / stop
//
// The truncation signal for the fallback is the ABSENCE of the terminal events:
// on a clean finish Kiro always sends contextUsageEvent and meteringEvent, so a
// stream that is physically cut off omits them. Note this fallback CANNOT detect
// a server-side max-tokens truncation, because Kiro still closes such a stream
// cleanly (with accounting events) — only the metadataEvent stopReason
// distinguishes it. That is why honoring the upstream reason matters: it is the
// only reliable signal that a response was truncated at the output-token cap.

// normalizeUpstreamStopReason canonicalizes a Kiro stopReason token: trim,
// uppercase, and fold dashes to underscores (matching the reference adapter's
// MapStopReason so "end-turn" and "END_TURN" resolve identically).
func normalizeUpstreamStopReason(upstream string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(upstream), "-", "_"))
}

// mapUpstreamClaudeStopReason maps Kiro's native metadataEvent stopReason to the
// Anthropic stop_reason vocabulary. Returns "" when the upstream value is
// empty or unrecognized so the caller can fall back to inference. The mapping
// mirrors the kiro_anthropic_response reference adapter.
func mapUpstreamClaudeStopReason(upstream string) string {
	switch normalizeUpstreamStopReason(upstream) {
	case "END_TURN":
		return "end_turn"
	case "MAX_TOKENS", "MAX_TOKEN":
		return "max_tokens"
	case "TOOL_USE", "TOOL_CALLS":
		return "tool_use"
	case "STOP_SEQUENCE":
		return "stop_sequence"
	case "PAUSE_TURN":
		return "pause_turn"
	case "MODEL_CONTEXT_WINDOW_EXCEEDED":
		return "model_context_window_exceeded"
	case "REFUSAL", "CONTENT_FILTERED", "GUARDRAIL_INTERVENED":
		return "refusal"
	default:
		return ""
	}
}

// mapUpstreamOpenAIFinishReason maps Kiro's native metadataEvent stopReason to
// the OpenAI finish_reason vocabulary. Returns "" when the upstream value is
// empty or unrecognized so the caller can fall back to inference.
func mapUpstreamOpenAIFinishReason(upstream string) string {
	switch normalizeUpstreamStopReason(upstream) {
	case "END_TURN", "STOP_SEQUENCE", "PAUSE_TURN":
		return "stop"
	// OpenAI has no context-window-exceeded finish_reason; "length" is the
	// closest signal that the response was cut short by a token limit.
	case "MAX_TOKENS", "MAX_TOKEN", "MODEL_CONTEXT_WINDOW_EXCEEDED":
		return "length"
	case "TOOL_USE", "TOOL_CALLS":
		return "tool_calls"
	case "REFUSAL", "CONTENT_FILTERED", "GUARDRAIL_INTERVENED":
		return "content_filter"
	default:
		return ""
	}
}

// resolveClaudeStopReason returns the Anthropic stop_reason, preferring the
// authoritative upstream metadataEvent value and falling back to inference when
// it is absent. A tool_use block in the response always forces tool_use, since
// an Anthropic client must see tool_use to execute the call — upstream
// occasionally labels tool turns END_TURN.
func resolveClaudeStopReason(upstream string, toolUseCount int, contentProduced, streamCompletedNormally bool) string {
	if mapped := mapUpstreamClaudeStopReason(upstream); mapped != "" {
		// Upstream occasionally labels a completed tool turn END_TURN. A
		// tool_use block requires stop_reason=tool_use for the client to run
		// it, so only end_turn is overridden — a refusal, truncation, or
		// context-window-exceeded reason must survive even with tool blocks.
		if toolUseCount > 0 && mapped == "end_turn" {
			return "tool_use"
		}
		return mapped
	}
	return claudeStopReason(toolUseCount, contentProduced, streamCompletedNormally)
}

// responsesTerminal describes how a Kiro stop reason maps onto the OpenAI
// Responses API terminal state. The Responses API has no stop_reason field;
// the outcome is expressed as a status (completed / incomplete / failed) plus
// an incomplete reason or an error code. Mirrors the kiro_openai_responses
// reference adapter's terminal-reason table.
type responsesTerminal struct {
	Status           string // "completed", "incomplete", or "failed"
	IncompleteReason string // set when Status == "incomplete"
	ErrorCode        string // set when Status == "failed"
	ErrorMessage     string // human-readable detail, set when Status == "failed"
}

// mapUpstreamResponsesStatus maps Kiro's metadataEvent stopReason to a Responses
// terminal state. An empty (absent) reason is treated as a clean completion,
// since a dropped stream surfaces as a transport error elsewhere rather than a
// metadataEvent. An unrecognized reason is left as completed rather than failing
// an otherwise-usable response — a deliberate, forward-compatible softening of
// the reference's "unknown -> server_error" rule.
func mapUpstreamResponsesStatus(upstream string) responsesTerminal {
	switch normalizeUpstreamStopReason(upstream) {
	case "", "END_TURN", "TOOL_USE", "TOOL_CALLS", "STOP_SEQUENCE", "PAUSE_TURN":
		return responsesTerminal{Status: "completed"}
	case "MAX_TOKENS", "MAX_TOKEN":
		return responsesTerminal{Status: "incomplete", IncompleteReason: "max_output_tokens"}
	case "CONTENT_FILTERED", "GUARDRAIL_INTERVENED", "REFUSAL":
		return responsesTerminal{Status: "incomplete", IncompleteReason: "content_filter"}
	case "MODEL_CONTEXT_WINDOW_EXCEEDED":
		return responsesTerminal{
			Status:       "failed",
			ErrorCode:    "context_length_exceeded",
			ErrorMessage: "The input plus generated output exceeded the model's context window.",
		}
	default:
		return responsesTerminal{Status: "completed"}
	}
}

// resolveOpenAIFinishReason returns the OpenAI finish_reason, preferring the
// authoritative upstream metadataEvent value and falling back to inference when
// it is absent. Tool calls force tool_calls for the same reason as above.
func resolveOpenAIFinishReason(upstream string, toolCallCount int, contentProduced, streamCompletedNormally bool) string {
	if mapped := mapUpstreamOpenAIFinishReason(upstream); mapped != "" {
		if toolCallCount > 0 && mapped == "stop" {
			return "tool_calls"
		}
		return mapped
	}
	return openAIFinishReason(toolCallCount, contentProduced, streamCompletedNormally)
}

// claudeStopReason returns the Anthropic stop_reason inferred for a completed
// stream when no authoritative upstream reason is available.
func claudeStopReason(toolUseCount int, contentProduced, streamCompletedNormally bool) string {
	switch {
	case toolUseCount > 0:
		return "tool_use"
	case contentProduced && !streamCompletedNormally:
		return "max_tokens"
	default:
		return "end_turn"
	}
}

// openAIFinishReason returns the OpenAI finish_reason inferred for a completed
// stream when no authoritative upstream reason is available.
func openAIFinishReason(toolCallCount int, contentProduced, streamCompletedNormally bool) string {
	switch {
	case toolCallCount > 0:
		return "tool_calls"
	case contentProduced && !streamCompletedNormally:
		return "length"
	default:
		return "stop"
	}
}
