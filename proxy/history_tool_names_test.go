package proxy

import "testing"

// A replayed tool call must name the tool exactly as the current request's
// specification does. convertClaudeTools camelCases names for Kiro, so a
// history carrying the client's original "exec_command" made the upstream see
// calls to a tool it was never given — asked to summarize such a history the
// model replied that the calls "used the name exec_command although the tool I
// was given is called execCommand, so I can't be sure those results came from a
// real run".
func TestClaudeHistoryToolNamesMatchTheSpecsSent(t *testing.T) {
	req := &ClaudeRequest{
		Model: "claude-sonnet-5",
		Tools: []ClaudeTool{{
			Name:        "exec_command",
			Description: "Run a shell command",
			InputSchema: map[string]interface{}{"type": "object"},
		}},
		Messages: []ClaudeMessage{
			{Role: "user", Content: "run it"},
			{Role: "assistant", Content: []interface{}{
				map[string]interface{}{"type": "tool_use", "id": "t1", "name": "exec_command", "input": map[string]interface{}{}},
			}},
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "done"},
			}},
			{Role: "user", Content: "summarize"},
		},
	}

	payload := ClaudeToKiro(req, false)

	specs := map[string]bool{}
	if ctx := payload.ConversationState.CurrentMessage.UserInputMessage.UserInputMessageContext; ctx != nil {
		for _, w := range ctx.Tools {
			specs[w.ToolSpecification.Name] = true
		}
	}
	if !specs["execCommand"] {
		t.Fatalf("expected the sanitized spec name on the wire, got %v", specs)
	}

	calls := 0
	for _, h := range payload.ConversationState.History {
		a := h.AssistantResponseMessage
		if a == nil {
			continue
		}
		for _, tu := range a.ToolUses {
			calls++
			if !specs[tu.Name] {
				t.Fatalf("history calls %q but the specs sent are %v", tu.Name, specs)
			}
		}
	}
	if calls == 0 {
		t.Fatalf("expected the structured tool call to survive in history")
	}
}

// Not every spec goes through the camelCase sanitizer: the gateway injects its
// own web_search tool under its literal name. Renaming history calls blindly
// would rewrite "web_search" to "webSearch" and the agentic loop would stop
// recognising the model's own calls.
func TestUnmappedToolNamesAreLeftAlone(t *testing.T) {
	history := []KiroHistoryMessage{{
		AssistantResponseMessage: &KiroAssistantResponseMessage{
			ToolUses: []KiroToolUse{
				{ToolUseID: "a", Name: "web_search"},
				{ToolUseID: "b", Name: "exec_command"},
			},
		},
	}}
	// Only exec_command was sanitized, so only it has a mapping.
	alignHistoryToolNames(history, map[string]string{"execCommand": "exec_command"})

	got := history[0].AssistantResponseMessage.ToolUses
	if got[0].Name != "web_search" {
		t.Fatalf("unmapped name was rewritten: %q", got[0].Name)
	}
	if got[1].Name != "execCommand" {
		t.Fatalf("mapped name was not aligned: %q", got[1].Name)
	}
}

// A conversation with no renamed tools must not be touched at all.
func TestAlignHistoryToolNamesNoopWithoutMapping(t *testing.T) {
	history := []KiroHistoryMessage{{
		AssistantResponseMessage: &KiroAssistantResponseMessage{
			ToolUses: []KiroToolUse{{ToolUseID: "a", Name: "lookup"}},
		},
	}}
	alignHistoryToolNames(history, nil)
	if history[0].AssistantResponseMessage.ToolUses[0].Name != "lookup" {
		t.Fatalf("names changed with an empty mapping")
	}
}
