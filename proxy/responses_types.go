package proxy

import (
	"encoding/json"
	"strings"
)

type ResponsesRequest struct {
	Model              string            `json:"model"`
	Input              json.RawMessage   `json:"input"`
	Instructions       string            `json:"instructions,omitempty"`
	Stream             bool              `json:"stream,omitempty"`
	Tools              []OpenAITool      `json:"tools,omitempty"`
	ToolChoice         json.RawMessage   `json:"tool_choice,omitempty"`
	PreviousResponseID string            `json:"previous_response_id,omitempty"`
	Store              *bool             `json:"store,omitempty"`
	Temperature        *float64          `json:"temperature,omitempty"`
	MaxOutputTokens    *int              `json:"max_output_tokens,omitempty"`
	Metadata           map[string]string `json:"metadata,omitempty"`
	// Reasoning is the Responses API's reasoning directive. Only the effort
	// level is interpreted; it is mapped onto the upstream model's advertised
	// effort enum like reasoning_effort on the Chat Completions path.
	Reasoning *ResponsesReasoningConfig `json:"reasoning,omitempty"`
}

type ResponsesReasoningConfig struct {
	Effort string `json:"effort,omitempty"`
}

type ResponsesObject struct {
	ID                 string               `json:"id"`
	Object             string               `json:"object"`
	CreatedAt          int64                `json:"created_at"`
	Status             string               `json:"status"`
	Model              string               `json:"model"`
	Output             []ResponseOutputItem `json:"output"`
	Usage              ResponsesUsage       `json:"usage"`
	PreviousResponseID string               `json:"previous_response_id,omitempty"`
	Metadata           map[string]string    `json:"metadata,omitempty"`
	Error              *ResponsesError      `json:"error,omitempty"`
	Instructions       string               `json:"instructions,omitempty"`
	StoredInput        json.RawMessage      `json:"-"`
	StoredInstr        string               `json:"-"`
	StoredAt           int64                `json:"stored_at,omitempty"`
}

type ResponseOutputItem struct {
	ID        string                `json:"id"`
	Type      string                `json:"type"`
	Role      string                `json:"role,omitempty"`
	Status    string                `json:"status,omitempty"`
	Content   []ResponseContentPart `json:"content,omitempty"`
	CallID    string                `json:"call_id,omitempty"`
	Name      string                `json:"name,omitempty"`
	Arguments string                `json:"arguments,omitempty"`
	// Reasoning item fields (Type == "reasoning"). Summary carries any
	// human-readable reasoning summaries; Content carries the raw
	// reasoning_text; EncryptedContent carries the opaque state the client
	// replays: a GPT-family encrypted blob, or for signed (Claude) reasoning the
	// Kiro envelope {"reasoningText":{"text","signature"}}.
	//
	// Summary is a pointer so it serializes as an explicit empty list on
	// reasoning items (the OpenAI SDKs treat `summary` as required there) while
	// staying absent on message and function_call items.
	Summary          *[]ResponseReasoningSummary `json:"summary,omitempty"`
	EncryptedContent string                      `json:"encrypted_content,omitempty"`
}

// MarshalJSON keeps the per-type required fields present: a message always has
// content, a function_call always has arguments, and a reasoning item always has
// summary. Clients parse these unconditionally, so omitempty would break them.
func (item ResponseOutputItem) MarshalJSON() ([]byte, error) {
	type plain ResponseOutputItem
	switch item.Type {
	case "message":
		type messageWire struct {
			ID      string                `json:"id"`
			Type    string                `json:"type"`
			Status  string                `json:"status"`
			Role    string                `json:"role"`
			Content []ResponseContentPart `json:"content"`
		}
		content := item.Content
		if content == nil {
			content = []ResponseContentPart{}
		}
		role := item.Role
		if role == "" {
			role = "assistant"
		}
		return json.Marshal(messageWire{ID: item.ID, Type: item.Type, Status: item.Status, Role: role, Content: content})
	case "function_call":
		type functionCallWire struct {
			ID        string `json:"id"`
			Type      string `json:"type"`
			Status    string `json:"status,omitempty"`
			Arguments string `json:"arguments"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
		}
		return json.Marshal(functionCallWire{ID: item.ID, Type: item.Type, Status: item.Status, Arguments: item.Arguments, CallID: item.CallID, Name: item.Name})
	case "reasoning":
		type reasoningWire struct {
			ID               string                     `json:"id"`
			Type             string                     `json:"type"`
			Summary          []ResponseReasoningSummary `json:"summary"`
			Content          []ResponseContentPart      `json:"content,omitempty"`
			EncryptedContent string                     `json:"encrypted_content,omitempty"`
			Status           string                     `json:"status,omitempty"`
		}
		summary := []ResponseReasoningSummary{}
		if item.Summary != nil && *item.Summary != nil {
			summary = *item.Summary
		}
		return json.Marshal(reasoningWire{ID: item.ID, Type: item.Type, Summary: summary, Content: item.Content, EncryptedContent: item.EncryptedContent, Status: item.Status})
	}
	return json.Marshal(plain(item))
}

// newReasoningOutputItem builds the `reasoning` output item that carries an
// opaque encrypted reasoning blob. Both the streaming events and the terminal
// response object use this constructor so the two never drift.
func newReasoningOutputItem(id, encryptedContent string) ResponseOutputItem {
	summary := []ResponseReasoningSummary{}
	return ResponseOutputItem{
		ID:               id,
		Type:             "reasoning",
		Status:           "completed",
		Summary:          &summary,
		EncryptedContent: encryptedContent,
	}
}

// newReasoningTextOutputItem builds a reasoning item carrying raw reasoning text
// (content[].reasoning_text) and, when signed, its replayable envelope.
func newReasoningTextOutputItem(id, status, text, encryptedContent string, includeText bool) ResponseOutputItem {
	item := newReasoningOutputItem(id, encryptedContent)
	item.Status = status
	if includeText {
		item.Content = []ResponseContentPart{{Type: "reasoning_text", Text: text}}
	}
	return item
}

// newMessageOutputItem builds an assistant `message` output item.
func newMessageOutputItem(id, status, text string) ResponseOutputItem {
	return ResponseOutputItem{
		ID:      id,
		Type:    "message",
		Role:    "assistant",
		Status:  status,
		Content: []ResponseContentPart{{Type: "output_text", Text: text}},
	}
}

// newFunctionCallOutputItem builds a `function_call` output item. Arguments are
// always a JSON object string: OpenAI clients parse this field unconditionally,
// so an empty value would break them.
func newFunctionCallOutputItem(id, status, callID, name, arguments string) ResponseOutputItem {
	if strings.TrimSpace(arguments) == "" || arguments == "null" {
		arguments = "{}"
	}
	return ResponseOutputItem{
		ID:        id,
		Type:      "function_call",
		Status:    status,
		CallID:    callID,
		Name:      name,
		Arguments: arguments,
	}
}

// ResponseReasoningSummary is a single human-readable reasoning summary entry
// inside a reasoning output item.
type ResponseReasoningSummary struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type ResponseContentPart struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// MarshalJSON emits the fields the spec requires per part type: output_text
// always carries text, annotations and logprobs; reasoning_text carries text.
func (p ResponseContentPart) MarshalJSON() ([]byte, error) {
	switch p.Type {
	case "output_text":
		return json.Marshal(struct {
			Type        string        `json:"type"`
			Text        string        `json:"text"`
			Annotations []interface{} `json:"annotations"`
			Logprobs    []interface{} `json:"logprobs"`
		}{p.Type, p.Text, []interface{}{}, []interface{}{}})
	case "reasoning_text":
		return json.Marshal(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{p.Type, p.Text})
	}
	type plain ResponseContentPart
	return json.Marshal(plain(p))
}

type ResponsesUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type ResponsesError struct {
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}
