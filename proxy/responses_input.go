package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
)

func parseResponsesInput(raw json.RawMessage) ([]OpenAIMessage, error) {
	if len(raw) == 0 {
		return nil, nil
	}

	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}

	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, fmt.Errorf("invalid input string: %w", err)
		}
		if strings.TrimSpace(s) == "" {
			return nil, nil
		}
		return []OpenAIMessage{{Role: "user", Content: s}}, nil
	}

	if trimmed[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, fmt.Errorf("invalid input array: %w", err)
		}
		return convertResponsesInputItems(items)
	}

	if trimmed[0] == '{' {
		return convertResponsesInputItems([]json.RawMessage{raw})
	}

	return nil, fmt.Errorf("unsupported input shape")
}

func convertResponsesInputItems(items []json.RawMessage) ([]OpenAIMessage, error) {
	messages := make([]OpenAIMessage, 0, len(items))
	pendingUserParts := []interface{}{}

	// pendingReasoning holds the encrypted_content of a `reasoning` input item
	// until the assistant turn it belongs to is emitted. OpenAI orders a
	// reasoning item immediately before the assistant message/function_call it
	// produced, so the opaque blob is attached to the next assistant message and
	// forwarded to Kiro for continuity. Dropping it loses the model's reasoning
	// state — and for signed Claude reasoning, makes the turn unverifiable.
	pendingReasoning := ""
	takeReasoning := func() string {
		r := pendingReasoning
		pendingReasoning = ""
		return r
	}

	// settleTrailingReasoning attaches a still-pending blob to the PRECEDING
	// assistant turn once that turn is closed by a user/tool item or by the end
	// of the input. Our own streaming responses emit the reasoning item last
	// (the upstream only reveals the blob after the text, and a streamed item
	// cannot be back-dated to index 0), so a client replaying `response.output`
	// verbatim sends reasoning AFTER its assistant turn. Without this the blob
	// would leak onto the next assistant turn — or be dropped entirely.
	settleTrailingReasoning := func() {
		if pendingReasoning == "" {
			return
		}
		if n := len(messages); n > 0 && messages[n-1].Role == "assistant" &&
			messages[n-1].RedactedReasoning == "" {
			messages[n-1].RedactedReasoning = pendingReasoning
		}
		pendingReasoning = ""
	}

	flushPendingUser := func() {
		if len(pendingUserParts) == 0 {
			return
		}
		messages = append(messages, OpenAIMessage{
			Role:    "user",
			Content: pendingUserParts,
		})
		pendingUserParts = nil
	}

	for _, item := range items {
		var obj map[string]interface{}
		if err := json.Unmarshal(item, &obj); err != nil {
			continue
		}

		typ, _ := obj["type"].(string)
		role, _ := obj["role"].(string)

		switch {
		case typ == "reasoning":
			// Opaque or signed reasoning emitted on a prior turn and replayed
			// back verbatim. Hold it until the assistant turn it precedes.
			if enc, _ := obj["encrypted_content"].(string); enc != "" {
				pendingReasoning = enc
			}

		case typ == "message" || (typ == "" && role != ""):
			if role != "assistant" {
				settleTrailingReasoning()
			}
			flushPendingUser()
			msg := buildMessageFromInputItem(obj, role)
			if msg != nil {
				if msg.Role == "assistant" {
					msg.RedactedReasoning = takeReasoning()
				}
				messages = append(messages, *msg)
			}

		case typ == "function_call_output" || typ == "tool_result":
			settleTrailingReasoning()
			flushPendingUser()
			callID, _ := obj["call_id"].(string)
			if callID == "" {
				callID, _ = obj["tool_call_id"].(string)
			}
			out := stringifyArbitrary(obj["output"])
			if out == "" {
				out = stringifyArbitrary(obj["content"])
			}
			messages = append(messages, OpenAIMessage{
				Role:       "tool",
				Content:    out,
				ToolCallID: callID,
			})

		case typ == "function_call":
			flushPendingUser()
			tc := ToolCall{
				ID:   stringField(obj, "call_id", "id"),
				Type: "function",
			}
			tc.Function.Name, _ = obj["name"].(string)
			tc.Function.Arguments = stringifyArbitrary(obj["arguments"])
			// Merge consecutive function_call items into a single assistant
			// message so parallel tool calls stay grouped in one turn. The
			// Responses API emits each parallel call as a separate input item;
			// keeping them in one assistant message preserves the tool_use /
			// tool_result pairing that Kiro requires.
			if n := len(messages); n > 0 &&
				messages[n-1].Role == "assistant" &&
				len(messages[n-1].ToolCalls) > 0 &&
				strings.TrimSpace(extractOpenAIMessageText(messages[n-1].Content)) == "" {
				messages[n-1].ToolCalls = append(messages[n-1].ToolCalls, tc)
				if messages[n-1].RedactedReasoning == "" {
					messages[n-1].RedactedReasoning = takeReasoning()
				}
			} else {
				messages = append(messages, OpenAIMessage{
					Role:              "assistant",
					Content:           "",
					ToolCalls:         []ToolCall{tc},
					RedactedReasoning: takeReasoning(),
				})
			}

		case typ == "input_text" || typ == "text":
			text, _ := obj["text"].(string)
			if text != "" {
				pendingUserParts = append(pendingUserParts, map[string]interface{}{
					"type": "input_text",
					"text": text,
				})
			}

		case typ == "input_image", typ == "image", typ == "image_url":
			pendingUserParts = append(pendingUserParts, map[string]interface{}(obj))

		case typ == "output_text":
			flushPendingUser()
			text, _ := obj["text"].(string)
			if text != "" {
				messages = append(messages, OpenAIMessage{
					Role:              "assistant",
					Content:           text,
					RedactedReasoning: takeReasoning(),
				})
			}

		default:
			if role != "" {
				flushPendingUser()
				msg := buildMessageFromInputItem(obj, role)
				if msg != nil {
					messages = append(messages, *msg)
				}
			}
		}
	}

	settleTrailingReasoning()
	flushPendingUser()
	return messages, nil
}

func buildMessageFromInputItem(obj map[string]interface{}, role string) *OpenAIMessage {
	if role == "" {
		role = "user"
	}

	if content, ok := obj["content"]; ok {
		switch v := content.(type) {
		case string:
			return &OpenAIMessage{Role: role, Content: v}
		case []interface{}:
			parts := make([]interface{}, 0, len(v))
			textOnly := strings.Builder{}
			anyNonText := false
			for _, p := range v {
				part, ok := p.(map[string]interface{})
				if !ok {
					continue
				}
				ptype, _ := part["type"].(string)
				switch ptype {
				case "input_text", "text":
					if t, ok := part["text"].(string); ok {
						textOnly.WriteString(t)
						parts = append(parts, map[string]interface{}{"type": "input_text", "text": t})
					}
				case "output_text":
					if t, ok := part["text"].(string); ok {
						textOnly.WriteString(t)
						parts = append(parts, map[string]interface{}{"type": "input_text", "text": t})
					}
				case "input_image", "image", "image_url":
					anyNonText = true
					parts = append(parts, part)
				default:
					if t, ok := part["text"].(string); ok && t != "" {
						textOnly.WriteString(t)
						parts = append(parts, map[string]interface{}{"type": "input_text", "text": t})
					}
				}
			}
			if !anyNonText {
				return &OpenAIMessage{Role: role, Content: textOnly.String()}
			}
			return &OpenAIMessage{Role: role, Content: parts}
		case map[string]interface{}:
			return buildMessageFromInputItem(v, role)
		}
	}

	if text, ok := obj["text"].(string); ok && text != "" {
		return &OpenAIMessage{Role: role, Content: text}
	}

	return nil
}

func stringifyArbitrary(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

func stringField(obj map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := obj[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}
