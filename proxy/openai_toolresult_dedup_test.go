package proxy

import (
	"strings"
	"testing"
)

// TestOpenAIToKiroDoesNotDuplicateToolResultText reproduces the bug where a
// non-final tool-result history entry was pre-filled with the
// "Tool results:" continuation text AND kept the structured ToolResults, which
// the history repair then narrated again, producing the same output twice.
// Each tool result's output must appear exactly once in history — whether it
// travels as a structured result or (for a broken pair) as narrated text.
func TestOpenAIToKiroDoesNotDuplicateToolResultText(t *testing.T) {
	req := &OpenAIRequest{
		Model: "claude-opus-4.8",
		Messages: []OpenAIMessage{
			{Role: "user", Content: "run it"},
			{Role: "assistant", Content: "", ToolCalls: []ToolCall{newToolCall("call_1", "exec_command", `{"cmd":"ls"}`)}},
			{Role: "tool", ToolCallID: "call_1", Content: "UNIQUE_OUTPUT_MARKER_12345"},
			{Role: "user", Content: "now summarize"},
		},
	}

	payload := OpenAIToKiro(req, false)

	if got := countToolOutput(payload, "UNIQUE_OUTPUT_MARKER_12345"); got != 1 {
		t.Fatalf("expected tool result output to appear exactly once in history, got %d", got)
	}
}

// countToolOutput counts how many times a marker appears anywhere in history:
// in message content, and in structured tool results. A complete tool pair
// keeps its output structured, so counting only content would miss it.
func countToolOutput(payload *KiroPayload, marker string) int {
	count := 0
	for _, h := range payload.ConversationState.History {
		if u := h.UserInputMessage; u != nil {
			count += strings.Count(u.Content, marker)
			if u.UserInputMessageContext != nil {
				for _, tr := range u.UserInputMessageContext.ToolResults {
					for _, c := range tr.Content {
						count += strings.Count(c.Text, marker)
					}
				}
			}
		}
		if a := h.AssistantResponseMessage; a != nil {
			count += strings.Count(a.Content, marker)
		}
	}
	return count
}

func newToolCall(id, name, args string) ToolCall {
	tc := ToolCall{ID: id, Type: "function"}
	tc.Function.Name = name
	tc.Function.Arguments = args
	return tc
}
