package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"kiro-go/config"
)

// throttleBody is what Kiro returns when it rate limits a premium model: a
// ValidationException whose reason is INVALID_MODEL_ID, not a ThrottlingException.
const throttleBody = `{"__type":"com.amazon.kiro.runtimeservice#ValidationException","message":"Invalid model. Please select a different model to continue.","reason":"INVALID_MODEL_ID"}`

// genuineValidationBody is a real client-side error and must never be retried.
const genuineValidationBody = `{"__type":"com.amazon.kiro.runtimeservice#ValidationException","message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`

// newThrottleTestServer stands up an upstream that fails the first
// failuresBeforeSuccess attempts with the given body, then answers with a valid
// event stream. A negative count fails every attempt. Returns the live attempt
// counter.
func newThrottleTestServer(t *testing.T, body string, failuresBeforeSuccess int) (*httptest.Server, *int) {
	t.Helper()

	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if failuresBeforeSuccess < 0 || attempts <= failuresBeforeSuccess {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(body))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{
			"content": "hi",
		}))
	}))
	t.Cleanup(server.Close)

	return server, &attempts
}

// redirectKiroTrafficTo points every upstream call at the test server and
// shortens the retry ramp so the suite does not sleep for real.
func redirectKiroTrafficTo(t *testing.T, server *httptest.Server) {
	t.Helper()

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

	originalBackoffs := modelThrottleBackoffs
	modelThrottleBackoffs = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { modelThrottleBackoffs = originalBackoffs })

	if err := config.Init(filepath.Join(t.TempDir(), "config.json")); err != nil {
		t.Fatalf("init config: %v", err)
	}
}

func apiKeyTestAccount() *config.Account {
	return &config.Account{AuthMethod: "api_key", KiroApiKey: "ksk_test", Region: "us-east-1"}
}

// The throttle clears on a retry against the same credential. This is the whole
// bug: an API Key account is pinned to a single endpoint, so the endpoint
// fallback loop had nothing to fall back to and the 400 reached the caller.
func TestCallKiroAPIRetriesModelThrottleOnSameEndpoint(t *testing.T) {
	server, attempts := newThrottleTestServer(t, throttleBody, 2)
	redirectKiroTrafficTo(t, server)

	if err := CallKiroAPI(apiKeyTestAccount(), &KiroPayload{}, nil); err != nil {
		t.Fatalf("a throttled model must recover on retry, got: %v", err)
	}
	if *attempts != 3 {
		t.Fatalf("expected 2 throttled attempts then a success, got %d attempts", *attempts)
	}
}

// A throttle that outlives the ramp must reach the client as 429. Reporting
// upstream's 400 tells the client its request was malformed and must not be
// retried, so the client abandons a model that works seconds later.
func TestCallKiroAPIModelThrottleSurfacesAsRateLimit(t *testing.T) {
	server, attempts := newThrottleTestServer(t, throttleBody, -1)
	redirectKiroTrafficTo(t, server)

	callErr := CallKiroAPI(apiKeyTestAccount(), &KiroPayload{}, nil)
	if callErr == nil {
		t.Fatal("expected an error once the retry ramp is exhausted")
	}

	wantAttempts := 1 + len(modelThrottleBackoffs)
	if *attempts != wantAttempts {
		t.Fatalf("expected %d attempts, got %d", wantAttempts, *attempts)
	}

	ue, ok := AsUpstreamError(callErr)
	if !ok {
		t.Fatalf("a modeled 400 must come back typed, got %T: %v", callErr, callErr)
	}
	if !ue.IsModelThrottle() {
		t.Fatalf("INVALID_MODEL_ID must be recognized as a throttle, got %q", callErr.Error())
	}
	if got := ue.StatusCode(); got != http.StatusTooManyRequests {
		t.Fatalf("client-visible status: got %d, want 429", got)
	}
	if !ue.Retryable() {
		t.Fatal("a throttle must stay retryable so another account can serve it")
	}
	if got := upstreamErrorHTTPStatus(callErr); got != http.StatusTooManyRequests {
		t.Fatalf("handler-facing status: got %d, want 429", got)
	}
}

// The retry is scoped to the throttle. A genuinely malformed request is rejected
// identically on every attempt, so retrying it only delays the answer.
func TestCallKiroAPIDoesNotRetryGenuineValidationError(t *testing.T) {
	server, attempts := newThrottleTestServer(t, genuineValidationBody, -1)
	redirectKiroTrafficTo(t, server)

	callErr := CallKiroAPI(apiKeyTestAccount(), &KiroPayload{}, nil)
	if callErr == nil {
		t.Fatal("expected an error")
	}
	if *attempts != 1 {
		t.Fatalf("a malformed request must be attempted once, got %d attempts", *attempts)
	}

	ue, ok := AsUpstreamError(callErr)
	if !ok {
		t.Fatalf("expected a typed upstream error, got %T: %v", callErr, callErr)
	}
	if ue.IsModelThrottle() {
		t.Fatal("REQUEST_BODY_INVALID must not be mistaken for a throttle")
	}
	if got := ue.StatusCode(); got != http.StatusBadRequest {
		t.Fatalf("client-visible status: got %d, want 400", got)
	}
	if ue.Retryable() {
		t.Fatal("a malformed request must not be retried across the pool")
	}
}
