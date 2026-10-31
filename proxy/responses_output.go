package proxy

import (
	"encoding/json"
	"strings"

	"kiro-go/logger"
)

// responsesOutputBuilder turns the upstream callback sequence into OpenAI
// Responses output items, in the order the upstream produced them, and (when
// emit is set) streams the matching events:
//
//	reasoning: output_item.added → content_part.added(reasoning_text) →
//	           reasoning_text.delta* → reasoning_text.done → content_part.done →
//	           output_item.done (content + encrypted_content)
//	message:   output_item.added → content_part.added(output_text) →
//	           output_text.delta* → output_text.done → content_part.done →
//	           output_item.done
//	tool call: output_item.added → function_call_arguments.delta →
//	           function_call_arguments.done → output_item.done
//
// Both the streaming and the non-streaming path go through this one builder, so
// `response.completed` can never describe a different item list than the events
// that preceded it.
//
// Signed reasoning is surfaced with encrypted_content set to the Kiro envelope
// {"reasoningText":{"text","signature"}}, so a client that replays the item
// restores the thinking block and its signature. Reasoning text is exposed in
// content only when the client asked for reasoning.
type responsesOutputBuilder struct {
	emit        func(event string, payload map[string]interface{})
	includeText bool

	items       []ResponseOutputItem
	outputIndex int

	msgOpen bool
	msgID   string
	msgText strings.Builder

	rsOpen    bool
	rsEmitted bool
	rsID      string
	rsText    strings.Builder

	fullText      strings.Builder
	reasoningText strings.Builder
	toolUses      []KiroToolUse
	redacted      []string
}

func newResponsesOutputBuilder(includeText bool, emit func(string, map[string]interface{})) *responsesOutputBuilder {
	return &responsesOutputBuilder{emit: emit, includeText: includeText}
}

func (b *responsesOutputBuilder) send(event string, payload map[string]interface{}) {
	if b.emit == nil {
		return
	}
	payload["type"] = event
	b.emit(event, payload)
}

// Text/Reasoning/ToolUse/Redacted mirror the upstream stream callbacks.
func (b *responsesOutputBuilder) Text(delta string) {
	if delta == "" {
		return
	}
	b.closeReasoning("")
	if !b.msgOpen {
		b.msgOpen = true
		b.msgID = generateOutputItemID("msg")
		b.msgText.Reset()
		inProgress := newMessageOutputItem(b.msgID, "in_progress", "")
		inProgress.Content = []ResponseContentPart{}
		b.send("response.output_item.added", map[string]interface{}{"output_index": b.outputIndex, "item": inProgress})
		b.send("response.content_part.added", map[string]interface{}{
			"item_id": b.msgID, "output_index": b.outputIndex, "content_index": 0,
			"part": ResponseContentPart{Type: "output_text"},
		})
	}
	b.msgText.WriteString(delta)
	b.fullText.WriteString(delta)
	b.send("response.output_text.delta", map[string]interface{}{
		"item_id": b.msgID, "output_index": b.outputIndex, "content_index": 0,
		"delta": delta, "logprobs": []interface{}{},
	})
}

func (b *responsesOutputBuilder) closeMessage() {
	if !b.msgOpen {
		return
	}
	b.msgOpen = false
	text := b.msgText.String()
	b.send("response.output_text.done", map[string]interface{}{
		"item_id": b.msgID, "output_index": b.outputIndex, "content_index": 0,
		"text": text, "logprobs": []interface{}{},
	})
	b.send("response.content_part.done", map[string]interface{}{
		"item_id": b.msgID, "output_index": b.outputIndex, "content_index": 0,
		"part": ResponseContentPart{Type: "output_text", Text: text},
	})
	done := newMessageOutputItem(b.msgID, "completed", text)
	b.send("response.output_item.done", map[string]interface{}{"output_index": b.outputIndex, "item": done})
	b.items = append(b.items, done)
	b.outputIndex++
}

func (b *responsesOutputBuilder) openReasoning() {
	b.rsOpen = true
	b.rsEmitted = false
	b.rsID = generateOutputItemID("rs")
	b.rsText.Reset()
	if !b.includeText {
		// Without visible reasoning the item is announced only once it is known
		// to carry replayable state (see closeReasoning).
		return
	}
	b.rsEmitted = true
	inProgress := newReasoningTextOutputItem(b.rsID, "in_progress", "", "", false)
	inProgress.Content = []ResponseContentPart{}
	b.send("response.output_item.added", map[string]interface{}{"output_index": b.outputIndex, "item": inProgress})
	b.send("response.content_part.added", map[string]interface{}{
		"item_id": b.rsID, "output_index": b.outputIndex, "content_index": 0,
		"part": ResponseContentPart{Type: "reasoning_text"},
	})
}

func (b *responsesOutputBuilder) Reasoning(delta string) {
	if delta == "" {
		return
	}
	b.closeMessage()
	if !b.rsOpen {
		b.openReasoning()
	}
	b.rsText.WriteString(delta)
	b.reasoningText.WriteString(delta)
	if b.rsEmitted {
		b.send("response.reasoning_text.delta", map[string]interface{}{
			"item_id": b.rsID, "output_index": b.outputIndex, "content_index": 0, "delta": delta,
		})
	}
}

// Signature closes the reasoning item it signs. A signature with no reasoning
// text (display omitted) still yields an item, because the pair must be
// replayed for the next turn to continue the model's reasoning.
func (b *responsesOutputBuilder) Signature(signature string) {
	if signature == "" {
		return
	}
	if !b.rsOpen {
		if b.msgOpen || len(b.items) > 0 {
			logger.Debugf("[Responses] reasoning signature arrived without an open reasoning item; attaching it to an empty reasoning item")
		}
		b.closeMessage()
		b.openReasoning()
	}
	b.closeReasoning(signature)
}

func (b *responsesOutputBuilder) closeReasoning(signature string) {
	if !b.rsOpen {
		return
	}
	b.rsOpen = false
	text := b.rsText.String()
	encrypted := ""
	if signature != "" {
		envelope, err := encodeIDEReasoningEnvelope(&KiroReasoningText{Text: text, Signature: signature})
		if err != nil {
			logger.Warnf("[Responses] could not encode reasoning envelope: %v", err)
		} else {
			encrypted = envelope
		}
	}
	if !b.rsEmitted {
		if encrypted == "" {
			// Unsigned, hidden reasoning carries nothing to replay.
			return
		}
		inProgress := newReasoningTextOutputItem(b.rsID, "in_progress", "", "", false)
		b.send("response.output_item.added", map[string]interface{}{"output_index": b.outputIndex, "item": inProgress})
	} else {
		b.send("response.reasoning_text.done", map[string]interface{}{
			"item_id": b.rsID, "output_index": b.outputIndex, "content_index": 0, "text": text,
		})
		b.send("response.content_part.done", map[string]interface{}{
			"item_id": b.rsID, "output_index": b.outputIndex, "content_index": 0,
			"part": ResponseContentPart{Type: "reasoning_text", Text: text},
		})
	}
	done := newReasoningTextOutputItem(b.rsID, "completed", text, encrypted, b.includeText)
	b.send("response.output_item.done", map[string]interface{}{"output_index": b.outputIndex, "item": done})
	b.items = append(b.items, done)
	b.outputIndex++
}

func (b *responsesOutputBuilder) ToolUse(tu KiroToolUse) {
	b.closeReasoning("")
	b.closeMessage()
	b.toolUses = append(b.toolUses, tu)
	args := toolUseArguments(tu)
	id := generateOutputItemID("fc")
	// arguments starts empty on `added`: clients accumulate the deltas.
	added := newFunctionCallOutputItem(id, "in_progress", tu.ToolUseID, tu.Name, args)
	added.Arguments = ""
	b.send("response.output_item.added", map[string]interface{}{"output_index": b.outputIndex, "item": added})
	b.send("response.function_call_arguments.delta", map[string]interface{}{"item_id": id, "output_index": b.outputIndex, "delta": args})
	b.send("response.function_call_arguments.done", map[string]interface{}{"item_id": id, "output_index": b.outputIndex, "arguments": args})
	done := newFunctionCallOutputItem(id, "completed", tu.ToolUseID, tu.Name, args)
	b.send("response.output_item.done", map[string]interface{}{"output_index": b.outputIndex, "item": done})
	b.items = append(b.items, done)
	b.outputIndex++
}

// Redacted records a GPT-family encrypted reasoning blob. The upstream reveals
// it only at the very end of the stream, so it cannot be placed before the
// answer while streaming.
func (b *responsesOutputBuilder) Redacted(blob string) {
	if strings.TrimSpace(blob) != "" {
		b.redacted = append(b.redacted, blob)
	}
}

// Finish closes open items and returns the output in emission order. When not
// streaming, encrypted blobs are placed first, as the OpenAI API orders a
// reasoning item before the answer it produced; a stream has to append them.
func (b *responsesOutputBuilder) Finish() []ResponseOutputItem {
	b.closeReasoning("")
	b.closeMessage()
	if b.emit == nil {
		blobs := make([]ResponseOutputItem, 0, len(b.redacted)+len(b.items))
		for _, blob := range b.redacted {
			blobs = append(blobs, newReasoningOutputItem(generateOutputItemID("rs"), blob))
		}
		b.items = append(blobs, b.items...)
		b.redacted = nil
		return b.items
	}
	for _, blob := range b.redacted {
		item := newReasoningOutputItem(generateOutputItemID("rs"), blob)
		b.send("response.output_item.added", map[string]interface{}{"output_index": b.outputIndex, "item": item})
		b.send("response.output_item.done", map[string]interface{}{"output_index": b.outputIndex, "item": item})
		b.items = append(b.items, item)
		b.outputIndex++
	}
	b.redacted = nil
	return b.items
}

// AnswerText is the visible answer accumulated so far, used for token accounting.
func (b *responsesOutputBuilder) AnswerText() string { return b.fullText.String() }

// ReasoningOutput is the reasoning text accumulated so far, used for token
// accounting even when the client never sees it.
func (b *responsesOutputBuilder) ReasoningOutput() string { return b.reasoningText.String() }

// ToolUses are the structured calls the upstream emitted, in order.
func (b *responsesOutputBuilder) ToolUses() []KiroToolUse { return b.toolUses }

func toolUseArguments(tu KiroToolUse) string {
	args, err := json.Marshal(tu.Input)
	if err != nil || len(args) == 0 {
		return "{}"
	}
	return string(args)
}
