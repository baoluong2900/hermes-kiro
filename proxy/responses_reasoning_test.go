package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// responsesUpstream stands up a Kiro upstream replaying the given frames and
// points the Responses path at it.
func responsesUpstream(t *testing.T, frames ...[]byte) func() {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		for _, f := range frames {
			_, _ = w.Write(f)
		}
	}))
	t.Cleanup(server.Close)
	return swapKiroEndpointsForTest(t, server)
}

func postResponses(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.handleOpenAIResponses(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	return rec
}

// The whole point of the port: signed reasoning has to leave /v1/responses as a
// reasoning item whose encrypted_content carries BOTH halves of the pair. The
// API has no signature field of its own, so without the envelope a Claude
// signature simply cannot survive this endpoint.
func TestResponsesNonStreamEmitsSignedReasoningItem(t *testing.T) {
	h, cleanup := setupResponsesTestHandler(t)
	defer cleanup()
	defer responsesUpstream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "let me think"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-resp"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "the answer"}),
	)()

	rec := postResponses(t, h, `{"model":"claude-sonnet-4.5","input":"hi","reasoning":{"effort":"high"},"store":false}`)

	var resp ResponsesObject
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(resp.Output) != 2 {
		t.Fatalf("expected a reasoning item then a message, got %d: %s", len(resp.Output), rec.Body.String())
	}
	reasoning := resp.Output[0]
	if reasoning.Type != "reasoning" {
		t.Fatalf("reasoning item must come first, got %q", reasoning.Type)
	}
	// The envelope is what a client replays; decoding it must give back the
	// exact text/signature pair the upstream produced.
	pair := decodeIDEReasoningEnvelope(reasoning.EncryptedContent)
	if pair == nil {
		t.Fatalf("encrypted_content is not a signed envelope: %q", reasoning.EncryptedContent)
	}
	if pair.Signature != "sig-resp" || pair.Text != "let me think" {
		t.Fatalf("envelope lost the pair: %+v", pair)
	}
	if len(reasoning.Content) != 1 || reasoning.Content[0].Type != "reasoning_text" || reasoning.Content[0].Text != "let me think" {
		t.Fatalf("reasoning text not exposed to a client that asked for it: %+v", reasoning.Content)
	}
	if resp.Output[1].Type != "message" || joinTextParts(resp.Output[1].Content) != "the answer" {
		t.Fatalf("answer message wrong: %+v", resp.Output[1])
	}
}

// A reasoning item must always serialize `summary`, which the OpenAI SDKs treat
// as required on that item type.
func TestResponsesReasoningItemAlwaysHasSummary(t *testing.T) {
	item := newReasoningOutputItem("rs_1", "blob")
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := decoded["summary"]; !ok {
		t.Fatalf("reasoning item must always carry summary: %s", encoded)
	}
	// A message item must NOT carry it.
	encoded, _ = json.Marshal(newMessageOutputItem("msg_1", "completed", "hi"))
	if strings.Contains(string(encoded), "summary") {
		t.Fatalf("message item must not carry summary: %s", encoded)
	}
}

// The envelope is replayed verbatim and verified upstream, so its bytes must not
// be mangled — Go's default HTML escaping would rewrite <, > and & inside the
// reasoning text and break verification.
func TestReasoningEnvelopeDoesNotHTMLEscape(t *testing.T) {
	encoded, err := encodeIDEReasoningEnvelope(&KiroReasoningText{Text: `a < b && c > d`, Signature: "sig"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// json.Marshal is the HTML-escaping encoder: it rewrites <, > and & into
	// \u00xx escapes, which changes the bytes the upstream verifies. The
	// envelope encoder must not produce that form.
	escaping, err := json.Marshal(ideReasoningEnvelope{ReasoningText: &KiroReasoningText{Text: `a < b && c > d`, Signature: "sig"}})
	if err != nil {
		t.Fatalf("reference marshal: %v", err)
	}
	if encoded == string(escaping) {
		t.Fatalf("envelope was HTML-escaped: %s", encoded)
	}
	if !strings.Contains(encoded, `a < b && c > d`) {
		t.Fatalf("envelope did not keep the text verbatim: %s", encoded)
	}
	pair := decodeIDEReasoningEnvelope(encoded)
	if pair == nil || pair.Text != `a < b && c > d` {
		t.Fatalf("round trip changed the text: %+v", pair)
	}
}

// An unsigned blob is not an envelope and must stay opaque: echoing it as
// plaintext reasoningText would hand the upstream reasoning it cannot verify.
func TestOpaqueBlobStaysRedacted(t *testing.T) {
	rc := kiroReasoningFromOpaque("gAAAAA-not-an-envelope")
	if rc == nil || rc.RedactedContent != "gAAAAA-not-an-envelope" || rc.ReasoningText != nil {
		t.Fatalf("opaque blob mishandled: %+v", rc)
	}
	// An envelope without a signature is not replayable either.
	if got := decodeIDEReasoningEnvelope(`{"reasoningText":{"text":"x"}}`); got != nil {
		t.Fatalf("unsigned envelope must not decode as replayable: %+v", got)
	}
}

// GPT-family models return an opaque blob instead of plaintext. It becomes its
// own reasoning item so the client can replay it verbatim.
func TestResponsesNonStreamEmitsRedactedReasoningItem(t *testing.T) {
	h, cleanup := setupResponsesTestHandler(t)
	defer cleanup()
	defer responsesUpstream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"redactedContent": "opaque-blob"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer"}),
	)()

	rec := postResponses(t, h, `{"model":"claude-sonnet-4.5","input":"hi","store":false}`)

	var resp ResponsesObject
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Output) != 2 || resp.Output[0].Type != "reasoning" {
		t.Fatalf("expected a leading reasoning item, got %s", rec.Body.String())
	}
	if resp.Output[0].EncryptedContent != "opaque-blob" {
		t.Fatalf("opaque blob not surfaced: %+v", resp.Output[0])
	}
}

// Streaming must announce the reasoning item through the standard item/part
// events and finish it with the encrypted_content the client replays.
func TestResponsesStreamEmitsReasoningEvents(t *testing.T) {
	h, cleanup := setupResponsesTestHandler(t)
	defer cleanup()
	defer responsesUpstream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "pondering"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-stream"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer"}),
	)()

	rec := postResponses(t, h, `{"model":"claude-sonnet-4.5","input":"hi","stream":true,"reasoning":{"effort":"high"},"store":false}`)
	body := rec.Body.String()

	for _, want := range []string{
		"event: response.output_item.added",
		"event: response.content_part.added",
		"event: response.reasoning_text.delta",
		"event: response.reasoning_text.done",
		"event: response.output_item.done",
		"event: response.output_text.delta",
		"event: response.completed",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in stream:\n%s", want, body)
		}
	}
	if !strings.Contains(body, "sig-stream") {
		t.Fatalf("signature never reached the client:\n%s", body)
	}

	// response.completed must describe exactly the items that were streamed.
	completed := lastResponseObject(t, body)
	if len(completed.Output) != 2 || completed.Output[0].Type != "reasoning" || completed.Output[1].Type != "message" {
		t.Fatalf("completed output does not mirror the streamed items: %+v", completed.Output)
	}
	if decodeIDEReasoningEnvelope(completed.Output[0].EncryptedContent) == nil {
		t.Fatalf("streamed reasoning item carries no replayable envelope: %+v", completed.Output[0])
	}
}

// Reasoning the client did not ask for still has to be replayable, so the item
// is emitted with its envelope — but without exposing the reasoning text.
func TestResponsesHidesReasoningTextWhenNotRequested(t *testing.T) {
	h, cleanup := setupResponsesTestHandler(t)
	defer cleanup()
	defer responsesUpstream(t,
		awsEventStreamFrame(t, "reasoningContentEvent", map[string]interface{}{"text": "private thought"}),
		awsEventStreamFrame(t, "reasoningContentSignatureEvent", map[string]interface{}{"signature": "sig-hidden"}),
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "answer"}),
	)()

	rec := postResponses(t, h, `{"model":"claude-sonnet-4.5","input":"hi","store":false}`)

	var resp ResponsesObject
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Output[0].Type != "reasoning" || resp.Output[0].EncryptedContent == "" {
		t.Fatalf("the replayable item must still be emitted: %+v", resp.Output[0])
	}
	// The reasoning text lives inside the envelope (it is half of the pair the
	// upstream verifies, so it has to survive the round trip) but must not be
	// surfaced as a readable content part.
	if len(resp.Output[0].Content) != 0 {
		t.Fatalf("reasoning text must stay out of content: %+v", resp.Output[0].Content)
	}
	if decodeIDEReasoningEnvelope(resp.Output[0].EncryptedContent) == nil {
		t.Fatalf("hidden reasoning must still be replayable: %+v", resp.Output[0])
	}
}

// Full circle: the item the gateway emitted, fed straight back as input, must
// restore the signed pair on the Kiro request.
func TestResponsesReasoningItemRoundTripsToKiro(t *testing.T) {
	envelope, err := encodeIDEReasoningEnvelope(&KiroReasoningText{Text: "prior thought", Signature: "sig-rt"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	input := json.RawMessage(`[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]},
		{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":` + jsonQuote(envelope) + `},
		{"type":"message","role":"assistant","content":[{"type":"output_text","text":"prior answer"}]},
		{"type":"message","role":"user","content":[{"type":"input_text","text":"follow up"}]}
	]`)

	msgs, err := parseResponsesInput(input)
	if err != nil {
		t.Fatalf("parse input: %v", err)
	}
	var asst *OpenAIMessage
	for i := range msgs {
		if msgs[i].Role == "assistant" {
			asst = &msgs[i]
		}
	}
	if asst == nil || asst.RedactedReasoning != envelope {
		t.Fatalf("reasoning item did not attach to its assistant turn: %+v", msgs)
	}

	payload := OpenAIToKiro(&OpenAIRequest{Model: "claude-sonnet-5", Messages: msgs})
	found := false
	for _, hmsg := range payload.ConversationState.History {
		if hmsg.AssistantResponseMessage == nil || hmsg.AssistantResponseMessage.ReasoningContent == nil {
			continue
		}
		rt := hmsg.AssistantResponseMessage.ReasoningContent.ReasoningText
		if rt != nil && rt.Signature == "sig-rt" && rt.Text == "prior thought" {
			found = true
		}
	}
	if !found {
		t.Fatalf("signed pair lost on the way to Kiro: %+v", payload.ConversationState.History)
	}
}

// Our own streams emit the reasoning item AFTER the assistant turn (the blob is
// only known once the text is done), so a client replaying response.output
// verbatim sends it in that order. It must still land on the turn it belongs to.
func TestResponsesTrailingReasoningItemAttachesToPrecedingTurn(t *testing.T) {
	input := json.RawMessage(`[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]},
		{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a"}]},
		{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"trailing-blob"}
	]`)

	msgs, err := parseResponsesInput(input)
	if err != nil {
		t.Fatalf("parse input: %v", err)
	}
	if n := len(msgs); n == 0 || msgs[n-1].Role != "assistant" || msgs[n-1].RedactedReasoning != "trailing-blob" {
		t.Fatalf("trailing reasoning did not settle onto the preceding assistant turn: %+v", msgs)
	}
}

// previous_response_id chains go through the stored output, not the input
// parser, so the same ordering rule has to hold there.
func TestStoredOutputReasoningAttachesToAssistantTurn(t *testing.T) {
	items := []ResponseOutputItem{
		newReasoningOutputItem("rs_1", "stored-blob"),
		newMessageOutputItem("msg_1", "completed", "answer"),
	}
	msgs := outputToMessages(items)
	if len(msgs) != 1 || msgs[0].RedactedReasoning != "stored-blob" {
		t.Fatalf("stored reasoning lost: %+v", msgs)
	}

	// Streamed responses store the reasoning item last; it belongs to the turn
	// before it.
	msgs = outputToMessages([]ResponseOutputItem{
		newMessageOutputItem("msg_1", "completed", "answer"),
		newReasoningOutputItem("rs_1", "stored-blob"),
	})
	if len(msgs) != 1 || msgs[0].RedactedReasoning != "stored-blob" {
		t.Fatalf("trailing stored reasoning lost: %+v", msgs)
	}
}

// lastResponseObject pulls the response object out of the final
// response.completed event of a stream.
func lastResponseObject(t *testing.T, body string) ResponsesObject {
	t.Helper()
	marker := "event: response.completed\ndata: "
	idx := strings.LastIndex(body, marker)
	if idx < 0 {
		t.Fatalf("no response.completed event in:\n%s", body)
	}
	rest := body[idx+len(marker):]
	if end := strings.Index(rest, "\n"); end >= 0 {
		rest = rest[:end]
	}
	var envelope struct {
		Response ResponsesObject `json:"response"`
	}
	if err := json.Unmarshal([]byte(rest), &envelope); err != nil {
		t.Fatalf("decode response.completed: %v (%s)", err, rest)
	}
	return envelope.Response
}

// jsonQuote JSON-quotes a string for embedding in a raw JSON literal.
func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
