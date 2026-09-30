package proxy

import (
	"bytes"
	"errors"
	"io"
	"kiro-go/config"
	"testing"
)

// errAfterReader replays a prefix and then fails, standing in for a stream that
// dies mid-answer: a dropped upstream connection or a client that cancelled.
type errAfterReader struct {
	data []byte
	off  int
	err  error
}

func (r *errAfterReader) Read(p []byte) (int, error) {
	if r.off >= len(r.data) {
		return 0, r.err
	}
	n := copy(p, r.data[r.off:])
	r.off += n
	return n, nil
}

// Upstream charges for what it generated the moment it reports metering. The
// parser used to keep that in a local and only hand it to the caller after the
// read loop finished cleanly, so every mid-stream error threw the number away and
// the caller billed nothing at all.
func TestParseEventStreamFlushesMeteringOnReadError(t *testing.T) {
	body := bytes.Join([][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial answer"}),
		awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.75}),
	}, nil)

	var credits float64
	var completed bool
	var gotIn, gotOut int
	cb := &KiroStreamCallback{
		OnText:    func(string, bool) {},
		OnCredits: func(c float64) { credits = c },
		OnComplete: func(in, out int) {
			completed = true
			gotIn, gotOut = in, out
		},
	}

	wantErr := errors.New("connection reset")
	err := parseEventStream(&errAfterReader{data: body, err: wantErr}, cb)
	if err == nil {
		t.Fatal("expected the read error to propagate to the caller")
	}
	if credits != 0.75 {
		t.Fatalf("metered credits must survive the error: got %v want 0.75", credits)
	}
	if !completed {
		t.Fatal("OnComplete must fire so the caller can attribute token usage")
	}
	_, _ = gotIn, gotOut
}

// A clean stream must still report usage exactly once.
func TestParseEventStreamFlushesOnceOnSuccess(t *testing.T) {
	body := bytes.Join([][]byte{
		awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "done"}),
		awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.5}),
	}, nil)

	creditCalls := 0
	completeCalls := 0
	cb := &KiroStreamCallback{
		OnText:     func(string, bool) {},
		OnCredits:  func(float64) { creditCalls++ },
		OnComplete: func(int, int) { completeCalls++ },
	}
	if err := parseEventStream(bytes.NewReader(body), cb); err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if creditCalls != 1 {
		t.Fatalf("OnCredits must fire exactly once, got %d", creditCalls)
	}
	if completeCalls != 1 {
		t.Fatalf("OnComplete must fire exactly once, got %d", completeCalls)
	}
}

// An error before any metering must not fabricate a charge.
func TestParseEventStreamUnmeteredErrorBillsNothing(t *testing.T) {
	var credits float64
	cb := &KiroStreamCallback{OnCredits: func(c float64) { credits = c }}
	err := parseEventStream(&errAfterReader{data: nil, err: io.ErrUnexpectedEOF}, cb)
	if err == nil {
		t.Fatal("expected the read error to propagate")
	}
	if credits != 0 {
		t.Fatalf("nothing was metered, so nothing may be billed: got %v", credits)
	}
}

// Partial usage lands on the balance but must not inflate the request count: one
// client request that internally retried is still one request.
func TestRecordApiKeyPartialUsageDoesNotCountAsRequest(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "partial", Key: "sk-partial", Enabled: true})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}

	if err := config.RecordApiKeyPartialUsage(created.ID, 120, 0.25); err != nil {
		t.Fatalf("RecordApiKeyPartialUsage: %v", err)
	}
	got := config.GetApiKeyEntry(created.ID)
	if got == nil {
		t.Fatal("key vanished")
	}
	if got.CreditsUsed != 0.25 {
		t.Fatalf("credits must be booked: got %v want 0.25", got.CreditsUsed)
	}
	if got.TokensUsed != 120 {
		t.Fatalf("tokens must be booked: got %d want 120", got.TokensUsed)
	}
	if got.RequestsCount != 0 {
		t.Fatalf("a retried attempt is not a new client request: got %d want 0", got.RequestsCount)
	}
	if got.LastUsedAt == 0 {
		t.Fatal("LastUsedAt must advance so the key does not look idle")
	}

	// A delivered response still counts as a request, and adds on top.
	if err := config.RecordApiKeyUsage(created.ID, 30, 0.1); err != nil {
		t.Fatalf("RecordApiKeyUsage: %v", err)
	}
	got = config.GetApiKeyEntry(created.ID)
	if got.RequestsCount != 1 {
		t.Fatalf("delivered request must be counted once: got %d", got.RequestsCount)
	}
	if got.TokensUsed != 150 {
		t.Fatalf("token totals must accumulate: got %d want 150", got.TokensUsed)
	}
	if d := got.CreditsUsed - 0.35; d > 1e-9 || d < -1e-9 {
		t.Fatalf("credit totals must accumulate: got %v want 0.35", got.CreditsUsed)
	}
}

func TestRecordApiKeyPartialUsageIgnoresEmptyDelta(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "noop", Key: "sk-noop", Enabled: true})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	if err := config.RecordApiKeyPartialUsage(created.ID, 0, 0); err != nil {
		t.Fatalf("an empty delta must be a silent no-op, got %v", err)
	}
	got := config.GetApiKeyEntry(created.ID)
	if got.LastUsedAt != 0 || got.TokensUsed != 0 || got.CreditsUsed != 0 {
		t.Fatalf("nothing should have changed: %+v", got)
	}
}

// The credit ceiling still has to reject a key whose balance was reached purely
// through partial-usage attribution.
func TestPartialUsagePushesKeyOverCreditLimit(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{
		Name: "ceiling", Key: "sk-ceiling", Enabled: true, CreditLimit: 1.0,
	})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	if err := config.RecordApiKeyPartialUsage(created.ID, 0, 1.5); err != nil {
		t.Fatalf("RecordApiKeyPartialUsage: %v", err)
	}
	got := config.GetApiKeyEntry(created.ID)
	_, overCredit := config.ApiKeyOverLimit(*got)
	if !overCredit {
		t.Fatalf("key at %v of a %v limit must be over the ceiling", got.CreditsUsed, got.CreditLimit)
	}
}
