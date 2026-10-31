package proxy

import (
	"strings"
	"testing"
)

// TestClaudeToKiroKeepsCompleteHistoryToolCycles covers the context compaction
// scenario: a conversation whose history contains completed tool cycles
// (assistant tool_use + user tool_result), followed by a plain-text instruction.
//
// An earlier version flattened every one of those pairs into "Tool results:"
// prose, on the belief that Kiro rejects structured tool activity in history.
// That belief is wrong — this exact payload was replayed against the live
// upstream and answered HTTP 200 — and the flattening caused a real regression:
// dozens of in-context examples of "tool activity is prose" taught the model to
// answer with a narrative instead of emitting a real tool call, so the turn came
// back END_TURN with no toolUseEvent and the client's agent loop halted.
//
// Complete pairs must therefore stay structured, in the shape the real Kiro CLI
// sends: strict user/assistant alternation, tool-result turns carrying empty
// content, and a messageId stamped on assistant turns that hold tool calls.
func TestClaudeToKiroKeepsCompleteHistoryToolCycles(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "run the build"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "text", "text": "running build"},
				map[string]interface{}{"type": "tool_use", "id": "t1", "name": "exec_command", "input": map[string]interface{}{"cmd": "make"}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "build ok"},
			}},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "tool_use", "id": "t2", "name": "exec_command", "input": map[string]interface{}{"cmd": "test"}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "t2", "content": "tests pass"},
			}},
			// Final plain-text instruction (the compaction request).
			{Role: "user", Content: "Summarize everything that happened above."},
		},
	}

	payload := ClaudeToKiro(req)

	calls, results, stamped := 0, 0, 0
	for _, h := range payload.ConversationState.History {
		if a := h.AssistantResponseMessage; a != nil {
			calls += len(a.ToolUses)
			if len(a.ToolUses) > 0 && a.MessageID != "" {
				stamped++
			}
		}
		if u := h.UserInputMessage; u != nil && u.UserInputMessageContext != nil {
			results += len(u.UserInputMessageContext.ToolResults)
		}
	}
	if calls != 2 || results != 2 {
		t.Fatalf("expected both tool pairs kept structured, got %d calls / %d results", calls, results)
	}
	if stamped != 2 {
		t.Fatalf("assistant turns carrying tool calls must be stamped with a messageId, got %d of 2", stamped)
	}

	assertStrictAlternation(t, payload)

	// A turn that answers tool calls carries empty content upstream — never a
	// "." placeholder or narration.
	for i, h := range payload.ConversationState.History {
		u := h.UserInputMessage
		if u == nil || u.UserInputMessageContext == nil || len(u.UserInputMessageContext.ToolResults) == 0 {
			continue
		}
		if strings.TrimSpace(u.Content) != "" {
			t.Fatalf("history[%d] answers tool calls but carries content %q", i, u.Content)
		}
	}

	// The compaction instruction is the current message and carries no results.
	cur := payload.ConversationState.CurrentMessage.UserInputMessage
	if cur.UserInputMessageContext != nil && len(cur.UserInputMessageContext.ToolResults) > 0 {
		t.Fatalf("current message should not carry structured toolResults for a plain instruction")
	}
	if !strings.Contains(cur.Content, "Summarize everything") {
		t.Fatalf("expected current content to be the compaction instruction, got %q", cur.Content)
	}

	// Tool output must survive exactly once, structurally.
	for _, marker := range []string{"build ok", "tests pass"} {
		if got := countToolOutput(payload, marker); got != 1 {
			t.Fatalf("tool output %q should appear exactly once, got %d", marker, got)
		}
	}

	// Regression guard: assistant turns must never contain tool-invocation prose.
	for i, h := range payload.ConversationState.History {
		a := h.AssistantResponseMessage
		if a == nil {
			continue
		}
		for _, bad := range []string{"[Called tool", "with input {"} {
			if strings.Contains(a.Content, bad) {
				t.Fatalf("history[%d] assistant content contains mimicable tool text %q", i, bad)
			}
		}
	}
}

// TestClaudeToKiroFlattensBrokenToolPairs covers the other half of the rule:
// a tool result whose originating call is gone (client-side compaction dropped
// it) cannot stay structured — the upstream answers 400 "unexpected tool_use_id
// found in tool_result blocks" — so it is narrated on the user side instead.
func TestClaudeToKiroFlattensBrokenToolPairs(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-opus-4.8",
		Messages: []ClaudeMessage{
			{Role: "user", Content: "start"},
			{Role: "assistant", Content: "working on it"},
			// Result with no preceding call anywhere in history.
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "orphan", "content": "ORPHAN_OUTPUT"},
			}},
			{Role: "user", Content: "what happened?"},
		},
	}

	payload := ClaudeToKiro(req)

	for i, h := range payload.ConversationState.History {
		if u := h.UserInputMessage; u != nil && u.UserInputMessageContext != nil {
			if len(u.UserInputMessageContext.ToolResults) > 0 {
				t.Fatalf("history[%d] kept an orphaned tool result structured", i)
			}
		}
	}
	// The output itself must not be lost — it is the only copy left.
	if countToolOutput(payload, "ORPHAN_OUTPUT") == 0 {
		t.Fatalf("orphaned tool output was dropped instead of narrated")
	}
}
