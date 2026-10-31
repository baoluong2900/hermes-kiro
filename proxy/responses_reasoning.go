package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The Responses API has one slot for opaque model state a client must replay:
// a reasoning item's `encrypted_content`. Two different things travel in it.
//
//   - GPT-family models return an already-encrypted blob. It is echoed back
//     verbatim as reasoningContent.redactedContent.
//   - Claude models return plaintext reasoning plus a signature. Anthropic
//     verifies the text/signature pair, so both halves have to survive the
//     round trip. They are packed into the same envelope the Kiro clients use:
//
//     {"reasoningText":{"text":"...","signature":"..."}}
//
// Packing the pair this way is what lets /v1/responses carry a Claude signature
// at all: the API has no `signature` field of its own, and a signature that
// cannot be replayed makes the next turn's reasoning unverifiable — the
// upstream answers 400 THINKING_SIGNATURE_INVALID and no retry can fix it.

type ideReasoningEnvelope struct {
	ReasoningText *KiroReasoningText `json:"reasoningText,omitempty"`
}

// encodeIDEReasoningEnvelope packs signed reasoning into the string that travels
// as encrypted_content. HTML escaping is off because the value is replayed
// verbatim and `<` sequences would change the bytes the upstream verifies.
func encodeIDEReasoningEnvelope(text *KiroReasoningText) (string, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(ideReasoningEnvelope{ReasoningText: text}); err != nil {
		return "", fmt.Errorf("responses reasoning envelope: %w", err)
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// decodeIDEReasoningEnvelope returns the signed reasoning inside an
// encrypted_content value, or nil when the value is some other opaque blob.
func decodeIDEReasoningEnvelope(raw string) *KiroReasoningText {
	var envelope ideReasoningEnvelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return nil
	}
	if envelope.ReasoningText == nil || envelope.ReasoningText.Signature == "" {
		return nil
	}
	return envelope.ReasoningText
}

// kiroReasoningFromOpaque maps an opaque reasoning blob a client replayed
// (Anthropic redacted_thinking data, OpenAI reasoning encrypted_content) back
// onto the Kiro history shape. An envelope carries signed plaintext reasoning,
// which the upstream accepts as reasoningText; anything else is a GPT-style
// encrypted blob echoed verbatim.
func kiroReasoningFromOpaque(blob string) *KiroReasoningContent {
	if blob == "" {
		return nil
	}
	if text := decodeIDEReasoningEnvelope(blob); text != nil {
		return &KiroReasoningContent{ReasoningText: &KiroReasoningText{Text: text.Text, Signature: text.Signature}}
	}
	return &KiroReasoningContent{RedactedContent: blob}
}
