package proxy

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"kiro-go/config"
	"kiro-go/pool"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

// Regression suite for upstream failures that arrived inside a 200 event stream.
//
// AWS event streams do not use the HTTP status to report modeled errors. Smithy
// sends a frame with ":message-type: exception" and ":exception-type: <Name>",
// and no ":event-type" at all. extractEventType only looked at ":event-type", so
// those frames matched no case in the dispatch switch and were discarded. The
// stream then hit a clean EOF, parseEventStream returned nil, and the caller
// forwarded an empty assistant turn. Clients treat an empty turn as a transient
// glitch and retry at once, so a single upstream rejection became a tight loop.

// awsExceptionFrame builds an event-stream frame shaped like a Smithy modeled
// error: exception headers, no ":event-type".
func awsExceptionFrame(t *testing.T, exceptionType, message string) []byte {
	t.Helper()
	return awsFrameWithHeaders(t, map[string]string{
		":message-type":   "exception",
		":exception-type": exceptionType,
		":content-type":   "application/json",
	}, map[string]interface{}{"message": message})
}

func awsFrameWithHeaders(t *testing.T, hdrs map[string]string, payload map[string]interface{}) []byte {
	t.Helper()

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	var headers []byte
	for name, value := range hdrs {
		headers = append(headers, byte(len(name)))
		headers = append(headers, []byte(name)...)
		headers = append(headers, byte(7)) // string value type
		headers = append(headers, byte(len(value)>>8), byte(len(value)))
		headers = append(headers, []byte(value)...)
	}

	totalLength := 12 + len(headers) + len(payloadBytes) + 4
	frame := make([]byte, 12, totalLength)
	binary.BigEndian.PutUint32(frame[0:4], uint32(totalLength))
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(headers)))
	frame = append(frame, headers...)
	frame = append(frame, payloadBytes...)
	frame = append(frame, 0, 0, 0, 0)
	return frame
}

// ---------------------------------------------------------------- header parsing

func TestParseFrameHeadersReadsHeadersBeyondEventType(t *testing.T) {
	frame := awsExceptionFrame(t, "ThrottlingException", "slow down")
	headersLen := binary.BigEndian.Uint32(frame[4:8])
	got := parseFrameHeaders(frame[12 : 12+headersLen])

	if got[":message-type"] != "exception" {
		t.Fatalf(":message-type not decoded: %#v", got)
	}
	if got[":exception-type"] != "ThrottlingException" {
		t.Fatalf(":exception-type not decoded: %#v", got)
	}
	if got[":content-type"] != "application/json" {
		t.Fatalf("trailing header lost: %#v", got)
	}
	if ev := extractEventType(frame[12 : 12+headersLen]); ev != "" {
		t.Fatalf("an exception frame has no :event-type, got %q", ev)
	}
}

func TestParseFrameHeadersStillFindsEventType(t *testing.T) {
	frame := awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "hi"})
	headersLen := binary.BigEndian.Uint32(frame[4:8])
	if got := extractEventType(frame[12 : 12+headersLen]); got != "assistantResponseEvent" {
		t.Fatalf("event type regressed: %q", got)
	}
}

// ------------------------------------------------------------ exception frames

func TestParseEventStreamSurfacesExceptionFrame(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial"}))
	stream.Write(awsExceptionFrame(t, "ValidationException", "Input is too long for requested model"))

	var got string
	err := parseEventStream(bytes.NewReader(stream.Bytes()), &KiroStreamCallback{
		OnText: func(text string, _ bool) { got += text },
	})
	if err == nil {
		t.Fatal("an exception frame must not be silently dropped")
	}
	ue, ok := AsUpstreamError(err)
	if !ok {
		t.Fatalf("expected *KiroUpstreamError, got %T: %v", err, err)
	}
	if ue.ExceptionType != "ValidationException" {
		t.Fatalf("exception type lost: %q", ue.ExceptionType)
	}
	if !strings.Contains(ue.Message, "too long") {
		t.Fatalf("upstream message lost: %q", ue.Message)
	}
	if got != "partial" {
		t.Fatalf("content before the exception must still be delivered, got %q", got)
	}
}

func TestParseEventStreamTreatsExceptionSuffixedEventTypeAsFailure(t *testing.T) {
	// Belt and braces: some frames name the error in :event-type instead.
	stream := bytes.NewReader(awsEventStreamFrame(t, "throttlingException",
		map[string]interface{}{"message": "slow down"}))

	err := parseEventStream(stream, &KiroStreamCallback{})
	ue, ok := AsUpstreamError(err)
	if !ok {
		t.Fatalf("expected *KiroUpstreamError, got %T: %v", err, err)
	}
	if ue.StatusCode() != http.StatusTooManyRequests {
		t.Fatalf("throttling must map to 429, got %d", ue.StatusCode())
	}
}

// A failure that upstream already metered still costs money. flushUsage runs on
// every exit path so the caller can bill it; returning early must not bypass it.
func TestParseEventStreamBillsCreditsMeteredBeforeException(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "partial"}))
	stream.Write(awsEventStreamFrame(t, "meteringEvent", map[string]interface{}{"usage": 0.42}))
	stream.Write(awsExceptionFrame(t, "ThrottlingException", "slow down"))

	var credits float64
	var completed bool
	err := parseEventStream(bytes.NewReader(stream.Bytes()), &KiroStreamCallback{
		OnText:     func(string, bool) {},
		OnCredits:  func(c float64) { credits = c },
		OnComplete: func(int, int) { completed = true },
	})
	if _, ok := AsUpstreamError(err); !ok {
		t.Fatalf("expected an upstream error, got %v", err)
	}
	if credits != 0.42 {
		t.Fatalf("credits metered before the failure must still be reported, got %v", credits)
	}
	if !completed {
		t.Fatal("OnComplete must run on the error path too")
	}
}

// ------------------------------------------------------------ empty responses

func TestParseEventStreamRejectsEmptyResponse(t *testing.T) {
	err := parseEventStream(bytes.NewReader(nil), &KiroStreamCallback{})
	if err == nil {
		t.Fatal("a 200 stream with nothing in it must not look like a successful turn")
	}
	if ue, ok := AsUpstreamError(err); !ok || ue.ExceptionType != "EmptyUpstreamResponse" {
		t.Fatalf("expected EmptyUpstreamResponse, got %T: %v", err, err)
	}
}

func TestParseEventStreamAcceptsMeteredResponseWithoutText(t *testing.T) {
	// Upstream charged for it, so it did work. Only a response with no content,
	// no tokens and no metering counts as nothing at all.
	stream := bytes.NewReader(awsEventStreamFrame(t, "meteringEvent",
		map[string]interface{}{"usage": 0.1}))

	var credits float64
	if err := parseEventStream(stream, &KiroStreamCallback{
		OnCredits: func(c float64) { credits = c },
	}); err != nil {
		t.Fatalf("a metered response is not empty: %v", err)
	}
	if credits != 0.1 {
		t.Fatalf("credits lost: %v", credits)
	}
}

func TestParseEventStreamAcceptsTokenOnlyResponse(t *testing.T) {
	stream := bytes.NewReader(awsEventStreamFrame(t, "metadataEvent",
		map[string]interface{}{"inputTokens": 100.0, "outputTokens": 5.0}))

	if err := parseEventStream(stream, &KiroStreamCallback{}); err != nil {
		t.Fatalf("a response with reported tokens is not empty: %v", err)
	}
}

func TestParseEventStreamAcceptsToolOnlyResponse(t *testing.T) {
	stream := bytes.NewReader(awsEventStreamFrame(t, "toolUseEvent", map[string]interface{}{
		"toolUseId": "toolu_1",
		"name":      "readFile",
		"input":     `{"path":"a.go"}`,
	}))

	var seen int
	if err := parseEventStream(stream, &KiroStreamCallback{
		OnToolUse: func(KiroToolUse) { seen++ },
	}); err != nil {
		t.Fatalf("a tool-only response is a real answer: %v", err)
	}
	if seen != 1 {
		t.Fatalf("expected the tool call to be emitted, got %d", seen)
	}
}

// -------------------------------------------------------------- classification

func TestUpstreamErrorStatusAndRetryability(t *testing.T) {
	for _, tc := range []struct {
		exception string
		status    int
		retryable bool
	}{
		{"ThrottlingException", http.StatusTooManyRequests, true},
		{"ServiceQuotaExceededException", http.StatusTooManyRequests, true},
		{"ValidationException", http.StatusBadRequest, false},
		{"ContentLengthExceededException", http.StatusBadRequest, false},
		{"AccessDeniedException", http.StatusUnauthorized, false},
		{"ExpiredTokenException", http.StatusUnauthorized, false},
		{"InternalServerException", http.StatusServiceUnavailable, true},
		{"SomethingNovelException", http.StatusBadGateway, true},
	} {
		ue := &KiroUpstreamError{ExceptionType: tc.exception, Message: "boom"}
		if got := ue.StatusCode(); got != tc.status {
			t.Errorf("%s status: got %d, want %d", tc.exception, got, tc.status)
		}
		if got := ue.Retryable(); got != tc.retryable {
			t.Errorf("%s retryable: got %v, want %v", tc.exception, got, tc.retryable)
		}
	}
}

// The HTTP status the client sees must come from the exception, not from a
// blanket 502 that clients treat as transient and retry.
func TestUpstreamErrorHTTPStatusUsesTypedException(t *testing.T) {
	for _, tc := range []struct {
		exception string
		want      int
	}{
		{"ThrottlingException", http.StatusTooManyRequests},
		{"ValidationException", http.StatusBadRequest},
		{"AccessDeniedException", http.StatusUnauthorized},
	} {
		err := error(&KiroUpstreamError{ExceptionType: tc.exception, Message: "boom"})
		if got := upstreamErrorHTTPStatus(err); got != tc.want {
			t.Errorf("%s: got %d, want %d", tc.exception, got, tc.want)
		}
	}

	// Pre-existing string-matched paths must keep working.
	if got := upstreamErrorHTTPStatus(errString("HTTP 401 from kiro: nope")); got != http.StatusUnauthorized {
		t.Errorf("auth heuristic regressed: %d", got)
	}
	if got := upstreamErrorHTTPStatus(errString("quota exhausted")); got != http.StatusTooManyRequests {
		t.Errorf("quota heuristic regressed: %d", got)
	}
	if got := upstreamErrorHTTPStatus(nil); got != http.StatusServiceUnavailable {
		t.Errorf("nil error: %d", got)
	}
}

func TestEmptyUpstreamResponseIsRetryableSoftFailure(t *testing.T) {
	// An empty response should rotate to another account, not disable one that
	// may be perfectly healthy, and not be reported as a client error.
	if !ErrEmptyUpstreamResponse.Retryable() {
		t.Fatal("an empty response is worth retrying elsewhere")
	}
	if got := ErrEmptyUpstreamResponse.StatusCode(); got != http.StatusBadGateway {
		t.Fatalf("empty response status: got %d, want 502", got)
	}
}

// -------------------------------------------------- HTTP-level modeled errors

// Upstream also reports modeled errors as ordinary non-200 responses, with the
// exception name in "__type". Those used to become a plain string error, so
// upstreamErrorHTTPStatus fell through to 502 and told the client "gateway
// problem, retry" for a request upstream had rejected as malformed.
func TestCallKiroAPILogsEmptyUpstreamResponseHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		w.Header().Set("x-amzn-RequestId", "req-test-12345")
		w.WriteHeader(http.StatusOK)
		// Empty body: 0 bytes sent
	}))
	defer server.Close()

	targetURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	originalClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: rewriteRoundTripper{
		target: targetURL,
		base:   server.Client().Transport,
	}})
	t.Cleanup(func() { kiroHttpStore.Store(originalClient) })
	if err := config.Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	account := &config.Account{AuthMethod: "api_key", KiroApiKey: "test-key", Region: "us-east-1"}
	callErr := CallKiroAPI(account, &KiroPayload{}, nil)
	if callErr == nil {
		t.Fatal("expected error on empty response, got nil")
	}
	ue, ok := AsUpstreamError(callErr)
	if !ok || ue.ExceptionType != "EmptyUpstreamResponse" {
		t.Fatalf("expected EmptyUpstreamResponse, got %T: %v", callErr, callErr)
	}
}

func TestUpstreamExceptionTypeFromBody(t *testing.T) {
	for _, tc := range []struct {
		body string
		want string
	}{
		{`{"__type":"com.amazon.kiro.runtimeservice#ValidationException","message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`, "ValidationException"},
		{`{"__type":"ThrottlingException","message":"slow down"}`, "ThrottlingException"},
		{`{"code":"svc#AccessDeniedException"}`, "AccessDeniedException"},
		{`{"__type":"com.amazon.kiro#SomeStruct"}`, ""},
		{`{"message":"no type here"}`, ""},
		{`not json at all`, ""},
		{``, ""},
	} {
		if got := upstreamExceptionTypeFromBody([]byte(tc.body)); got != tc.want {
			t.Errorf("body %q: got %q, want %q", tc.body, got, tc.want)
		}
	}
}

func TestHTTPModeledExceptionKeepsUpstreamStatusAndText(t *testing.T) {
	text := `HTTP 400 from Kiro CLI: {"__type":"com.amazon.kiro.runtimeservice#ValidationException","message":"Improperly formed request."}`
	err := error(&KiroUpstreamError{
		ExceptionType: "ValidationException",
		HTTPStatus:    http.StatusBadRequest,
		Text:          text,
	})

	if got := upstreamErrorHTTPStatus(err); got != http.StatusBadRequest {
		t.Fatalf("a rejected request must surface as 400, got %d", got)
	}
	if err.Error() != text {
		t.Fatalf("original text must be preserved for message-based checks, got %q", err.Error())
	}
	ue, _ := AsUpstreamError(err)
	if ue.Retryable() {
		t.Fatal("a validation failure is not worth retrying on another account")
	}
}

// The real HTTP status wins over name-based classification when both exist.
func TestHTTPStatusOverridesNameClassification(t *testing.T) {
	ue := &KiroUpstreamError{ExceptionType: "ValidationException", HTTPStatus: http.StatusTooManyRequests}
	if got := ue.StatusCode(); got != http.StatusTooManyRequests {
		t.Fatalf("upstream status should win, got %d", got)
	}
	// Out-of-range or absent status falls back to the name.
	ue2 := &KiroUpstreamError{ExceptionType: "ValidationException", HTTPStatus: 0}
	if got := ue2.StatusCode(); got != http.StatusBadRequest {
		t.Fatalf("name classification should apply, got %d", got)
	}
}

// An auth failure carried in a 401/403 body must still disable the credential,
// which depends on the message text surviving the wrap.
func TestHTTPModeledAuthExceptionStillMatchesAuthHeuristic(t *testing.T) {
	err := error(&KiroUpstreamError{
		ExceptionType: "AccessDeniedException",
		HTTPStatus:    http.StatusForbidden,
		Text:          `HTTP 403 from Kiro CLI: {"__type":"AccessDeniedException"}`,
	})
	if !isAuthErrorMessage(err.Error()) {
		t.Fatal("wrapping must not hide the HTTP 403 that auth handling keys on")
	}
}

// End to end through CallKiroAPI: a 400 carrying a modeled exception must come
// back typed, so the handler answers 400 instead of 502. Constructing the error
// by hand in the tests above does not cover this wiring.
func TestCallKiroAPITypesModeledHTTPException(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"__type":"com.amazon.kiro.runtimeservice#ValidationException","message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`))
	}))
	defer server.Close()

	targetURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	originalClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: rewriteRoundTripper{
		target: targetURL,
		base:   server.Client().Transport,
	}})
	t.Cleanup(func() { kiroHttpStore.Store(originalClient) })
	if err := config.Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	account := &config.Account{AuthMethod: "api_key", KiroApiKey: "ksk_test", Region: "us-east-1"}
	callErr := CallKiroAPI(account, &KiroPayload{}, nil)

	ue, ok := AsUpstreamError(callErr)
	if !ok {
		t.Fatalf("a modeled 400 must come back typed, got %T: %v", callErr, callErr)
	}
	if ue.ExceptionType != "ValidationException" {
		t.Fatalf("exception type: got %q", ue.ExceptionType)
	}
	if got := upstreamErrorHTTPStatus(callErr); got != http.StatusBadRequest {
		t.Fatalf("client-visible status: got %d, want 400", got)
	}
	if !strings.Contains(callErr.Error(), "HTTP 400") {
		t.Fatalf("original text must survive for message-based checks: %q", callErr.Error())
	}
	if ue.Retryable() {
		t.Fatal("a malformed request must not be retried across the pool")
	}
}

// A non-200 without a modeled exception body must stay a plain error, exactly as
// before, so nothing that depended on the old shape changes.
func TestCallKiroAPILeavesUnmodeledHTTPErrorUntyped(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream exploded"))
	}))
	defer server.Close()

	targetURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	originalClient := kiroHttpStore.Load()
	kiroHttpStore.Store(&http.Client{Transport: rewriteRoundTripper{
		target: targetURL,
		base:   server.Client().Transport,
	}})
	t.Cleanup(func() { kiroHttpStore.Store(originalClient) })
	if err := config.Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}

	account := &config.Account{AuthMethod: "api_key", KiroApiKey: "ksk_test", Region: "us-east-1"}
	callErr := CallKiroAPI(account, &KiroPayload{}, nil)
	if callErr == nil {
		t.Fatal("expected an error")
	}
	if _, ok := AsUpstreamError(callErr); ok {
		t.Fatalf("an unmodeled body must not be typed: %v", callErr)
	}
	if got := upstreamErrorHTTPStatus(callErr); got != http.StatusBadGateway {
		t.Fatalf("unmodeled upstream failure should stay 502, got %d", got)
	}
}

// ------------------------------------------------------------- account health// A ThrottlingException must put the credential straight into cooldown. Before
// the typed branch existed it fell through to the default soft error, which only
// cools down after three consecutive failures, so the same throttled credential
// was picked again on the very next request.
func TestHandleAccountFailureCoolsDownThrottlingException(t *testing.T) {
	acct := config.Account{ID: "acc-1", Email: "a@example.com", Enabled: true}
	p := pool.NewTestPool(acct)
	h := &Handler{pool: p}

	if got := p.AvailableCount(); got != 1 {
		t.Fatalf("precondition: account should start available, got %d", got)
	}

	h.handleAccountFailure(&acct, &KiroUpstreamError{
		ExceptionType: "ThrottlingException", Message: "slow down",
	})

	if got := p.AvailableCount(); got != 0 {
		t.Fatalf("a throttled credential must be cooled down immediately, available=%d", got)
	}
}

// The counterpart: a novel exception is a soft failure. One occurrence must not
// take the credential out of rotation, or a single upstream blip empties the pool.
func TestHandleAccountFailureKeepsAccountForSoftException(t *testing.T) {
	acct := config.Account{ID: "acc-2", Email: "b@example.com", Enabled: true}
	p := pool.NewTestPool(acct)
	h := &Handler{pool: p}

	h.handleAccountFailure(&acct, ErrEmptyUpstreamResponse)

	if got := p.AvailableCount(); got != 1 {
		t.Fatalf("one empty response must not remove the account, available=%d", got)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
