// Package proxy is the core proxy layer for the Kiro API.
// It handles streaming API calls to the Kiro backend and parses AWS Event Stream responses.
package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"kiro-go/config"
	"kiro-go/logger"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// Endpoint configuration (auto-fallback on quota exhaustion).
type kiroEndpoint struct {
	URL       string
	Origin    string
	AmzTarget string
	Name      string
}

var kiroEndpoints = []kiroEndpoint{
	{
		URL:       "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		Origin:    "AI_EDITOR",
		AmzTarget: "",
		Name:      "Kiro IDE",
	},
	{
		URL:       "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
		Origin:    "AI_EDITOR",
		AmzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		Name:      "CodeWhisperer",
	},
	{
		URL:       "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		Origin:    "AI_EDITOR",
		AmzTarget: "AmazonQDeveloperStreamingService.SendMessage",
		Name:      "AmazonQ",
	},
}

// kiroCLIEndpoint is the headless / API Key path used by Kiro CLI:
// POST https://runtime.{region}.kiro.dev/ with AWS JSON 1.0 protocol.
var kiroCLIEndpoint = kiroEndpoint{
	URL:       "https://runtime.us-east-1.kiro.dev/",
	Origin:    "KIRO_CLI",
	AmzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
	Name:      "Kiro CLI",
}

// Global HTTP clients, swappable at runtime to apply proxy reconfiguration without restart.
var kiroHttpStore atomic.Pointer[http.Client]
var kiroRestHttpStore atomic.Pointer[http.Client]

// proxyClientCache caches http.Client instances keyed by proxy URL for per-account proxy support.
var proxyClientCache sync.Map

func init() {
	InitKiroHttpClient("")
}

// GetClientForProxy returns an http.Client configured for the given proxy URL.
// If proxyURL is empty, returns the global kiro HTTP client.
func GetClientForProxy(proxyURL string) *http.Client {
	if proxyURL == "" {
		return kiroHttpStore.Load()
	}
	if cached, ok := proxyClientCache.Load(proxyURL); ok {
		return cached.(*http.Client)
	}
	client := &http.Client{
		// No Timeout: this client serves SSE streams (see buildKiroTransport).
		Transport: buildKiroTransport(proxyURL, true),
	}
	proxyClientCache.Store(proxyURL, client)
	return client
}

// GetRestClientForProxy returns a rest http.Client (30s timeout) for the given proxy URL.
// If proxyURL is empty, returns the global kiro REST HTTP client.
func GetRestClientForProxy(proxyURL string) *http.Client {
	if proxyURL == "" {
		return kiroRestHttpStore.Load()
	}
	cacheKey := "rest:" + proxyURL
	if cached, ok := proxyClientCache.Load(cacheKey); ok {
		return cached.(*http.Client)
	}
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: buildKiroTransport(proxyURL, false),
	}
	proxyClientCache.Store(cacheKey, client)
	return client
}

// ResolveAccountProxyURL returns the stable outbound proxy for this account.
func ResolveAccountProxyURL(account *config.Account) string {
	return config.AccountProxyURL(account)
}

// streamResponseHeaderTimeout bounds how long we wait for the upstream to send
// response headers. Once headers arrive the stream may run arbitrarily long, so
// no overall deadline is applied to streaming clients (see buildKiroTransport).
const streamResponseHeaderTimeout = 2 * time.Minute

// buildKiroTransport constructs an HTTP Transport with optional outbound proxy support.
//
// streaming selects the timeout policy. Streaming responses (SSE) must not carry
// an overall deadline: http.Client.Timeout covers reading the response body, so
// any cap would sever a healthy in-progress stream mid-token. Instead we bound
// only the wait for response headers and let idle connection reaping handle
// dead peers.
func buildKiroTransport(proxyURL string, streaming bool) *http.Transport {
	t := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   50,
		IdleConnTimeout:       15 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    false,
		ForceAttemptHTTP2:     true,
	}
	if streaming {
		t.ResponseHeaderTimeout = streamResponseHeaderTimeout
	}
	if proxyURL != "" {
		if u, err := url.Parse(proxyURL); err == nil {
			t.Proxy = http.ProxyURL(u)
			// Proxied connections cannot negotiate HTTP/2.
			t.ForceAttemptHTTP2 = false
		}
	} else {
		t.Proxy = proxyFromCurrentEnvironment()
	}
	return t
}

func proxyFromCurrentEnvironment() func(*http.Request) (*url.URL, error) {
	httpProxy := firstProxyEnv("HTTP_PROXY", "http_proxy")
	httpsProxy := firstProxyEnv("HTTPS_PROXY", "https_proxy")
	allProxy := firstProxyEnv("ALL_PROXY", "all_proxy")
	noProxy := firstProxyEnv("NO_PROXY", "no_proxy")

	return func(req *http.Request) (*url.URL, error) {
		if req == nil || req.URL == nil || shouldBypassEnvProxy(req.URL.Hostname(), noProxy) {
			return nil, nil
		}

		rawProxy := ""
		switch strings.ToLower(req.URL.Scheme) {
		case "https":
			rawProxy = firstNonEmpty(httpsProxy, allProxy)
		case "http":
			rawProxy = firstNonEmpty(httpProxy, allProxy)
		default:
			rawProxy = allProxy
		}
		if rawProxy == "" {
			return nil, nil
		}
		return parseEnvProxyURL(rawProxy)
	}
}

func firstProxyEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func parseEnvProxyURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	return url.Parse(raw)
}

func shouldBypassEnvProxy(host, noProxy string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	noProxy = strings.ToLower(strings.TrimSpace(noProxy))
	if host == "" || noProxy == "" {
		return false
	}
	if noProxy == "*" {
		return true
	}
	for _, entry := range strings.Split(noProxy, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		entry = strings.TrimPrefix(entry, ".")
		if host == entry || strings.HasSuffix(host, "."+entry) {
			return true
		}
	}
	return false
}

// InitKiroHttpClient initializes (or reinitializes) the HTTP clients used for Kiro API requests.
func InitKiroHttpClient(proxyURL string) {
	// No overall Timeout: this client streams SSE responses whose duration is
	// bounded by the model's output, not by the clock.
	client := &http.Client{
		Transport: buildKiroTransport(proxyURL, true),
	}
	kiroHttpStore.Store(client)

	restClient := &http.Client{
		Timeout:   30 * time.Second,
		Transport: buildKiroTransport(proxyURL, false),
	}
	kiroRestHttpStore.Store(restClient)
}

// ==================== Request Structs ====================

// KiroPayload is the top-level request body sent to the Kiro API.
type KiroPayload struct {
	ConversationState struct {
		AgentContinuationId string `json:"agentContinuationId,omitempty"`
		AgentTaskType       string `json:"agentTaskType,omitempty"`
		ChatTriggerType     string `json:"chatTriggerType"`
		ConversationID      string `json:"conversationId"`
		CurrentMessage      struct {
			UserInputMessage KiroUserInputMessage `json:"userInputMessage"`
		} `json:"currentMessage"`
		History []KiroHistoryMessage `json:"history,omitempty"`
	} `json:"conversationState"`
	ProfileArn      string           `json:"profileArn,omitempty"`
	InferenceConfig *InferenceConfig `json:"inferenceConfig,omitempty"`

	// ToolNameMap maps sanitized tool names (sent to Kiro) back to the
	// original names supplied by the client. Used to restore original names
	// in tool_use responses so the client can match them to its tool registry.
	// Not serialized to the Kiro API request body.
	ToolNameMap map[string]string `json:"-"`
}

type KiroUserInputMessage struct {
	Content                 string                   `json:"content"`
	ModelID                 string                   `json:"modelId,omitempty"`
	Origin                  string                   `json:"origin"`
	Images                  []KiroImage              `json:"images,omitempty"`
	UserInputMessageContext *UserInputMessageContext `json:"userInputMessageContext,omitempty"`
}

type UserInputMessageContext struct {
	Tools       []KiroToolWrapper `json:"tools,omitempty"`
	ToolResults []KiroToolResult  `json:"toolResults,omitempty"`
}

type KiroToolWrapper struct {
	ToolSpecification struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		InputSchema InputSchema `json:"inputSchema"`
	} `json:"toolSpecification"`
}

type InputSchema struct {
	JSON interface{} `json:"json"`
}

type KiroToolResult struct {
	ToolUseID string              `json:"toolUseId"`
	Content   []KiroResultContent `json:"content"`
	Status    string              `json:"status"`
}

type KiroResultContent struct {
	Text string `json:"text"`
}

type KiroImage struct {
	Format string `json:"format"`
	Source struct {
		Bytes string `json:"bytes"`
	} `json:"source"`
}

type KiroHistoryMessage struct {
	UserInputMessage         *KiroUserInputMessage         `json:"userInputMessage,omitempty"`
	AssistantResponseMessage *KiroAssistantResponseMessage `json:"assistantResponseMessage,omitempty"`
}

type KiroAssistantResponseMessage struct {
	Content  string        `json:"content"`
	ToolUses []KiroToolUse `json:"toolUses,omitempty"`
}

type KiroToolUse struct {
	ToolUseID string                 `json:"toolUseId"`
	Name      string                 `json:"name"`
	Input     map[string]interface{} `json:"input"`
}

type InferenceConfig struct {
	MaxTokens   int     `json:"maxTokens,omitempty"`
	Temperature float64 `json:"temperature,omitempty"`
	TopP        float64 `json:"topP,omitempty"`
}

// ==================== Stream Callbacks ====================

// KiroStreamCallback stream response callbacks
type KiroStreamCallback struct {
	OnText         func(text string, isThinking bool)
	OnToolUse      func(toolUse KiroToolUse)
	OnComplete     func(inputTokens, outputTokens int)
	OnError        func(err error)
	OnCredits      func(credits float64)
	OnContextUsage func(percentage float64)
}

// ==================== API Call ====================

func setPayloadProfileArnForAccount(payload *KiroPayload, account *config.Account) {
	if payload == nil {
		return
	}

	// API Key credentials must not carry IDE/profile semantics.
	if config.IsAPIKeyAccount(account) {
		payload.ProfileArn = ""
		return
	}

	payload.ProfileArn = strings.TrimSpace(payload.ProfileArn)
	if account != nil {
		if profileArn := strings.TrimSpace(account.ProfileArn); profileArn != "" {
			payload.ProfileArn = profileArn
		}
	}
}

// endpointsForAccount returns the upstream endpoint list for a credential.
// API Key accounts always use the CLI runtime protocol; OAuth accounts keep
// the configured preferred-endpoint fallback chain.
func endpointsForAccount(account *config.Account) []kiroEndpoint {
	if config.IsAPIKeyAccount(account) {
		return []kiroEndpoint{kiroCLIEndpoint}
	}
	return getSortedEndpoints(config.GetPreferredEndpoint())
}

// cliRuntimeURL builds the regional Kiro CLI runtime URL.
func cliRuntimeURL(account *config.Account) string {
	region := "us-east-1"
	if account != nil {
		if r := strings.TrimSpace(account.Region); r != "" {
			region = r
		}
	}
	return fmt.Sprintf("https://runtime.%s.kiro.dev/", region)
}

// transientModelRejectionPattern matches the 400 ValidationException Kiro sends
// instead of 429 when a premium model is throttled:
//
//	{"message":"Invalid model. Please select a different model to continue.",
//	 "reason":"INVALID_MODEL_ID"}
//
// The model id is provably valid — the identical request succeeds on an immediate
// retry, a burst of concurrent Opus 5 calls fails this way roughly a third of the
// time while the same burst on the gpt-5.6 tier never does, and spacing the calls
// out never fails at all. Surfacing it as a plain 400 tells clients the request
// was malformed and must not be retried, which is what made the premium models
// unusable under any concurrency.
var transientModelRejectionPattern = regexp.MustCompile(`(?i)INVALID_MODEL_ID|select a different model`)

func isTransientModelRejection(s string) bool {
	return transientModelRejectionPattern.MatchString(s)
}

// modelThrottleBackoffs is the retry ramp for the above. The throttle clears in
// well under a second, so a short bounded ramp recovers it without holding the
// caller's request open for long.
var modelThrottleBackoffs = []time.Duration{
	350 * time.Millisecond,
	900 * time.Millisecond,
	2 * time.Second,
}

// getSortedEndpoints returns endpoints ordered by user preference, with optional fallback.
func getSortedEndpoints(preferred string) []kiroEndpoint {
	fallback := config.GetEndpointFallback()

	var primary int
	switch preferred {
	case "kiro":
		primary = 0
	case "codewhisperer":
		primary = 1
	case "amazonq":
		primary = 2
	default:
		// "auto": Kiro first, then fallback to others
		return []kiroEndpoint{kiroEndpoints[0], kiroEndpoints[1], kiroEndpoints[2]}
	}

	if !fallback {
		// No fallback: only use the selected endpoint
		return []kiroEndpoint{kiroEndpoints[primary]}
	}

	// With fallback: selected first, then others in order
	result := []kiroEndpoint{kiroEndpoints[primary]}
	for i, ep := range kiroEndpoints {
		if i != primary {
			result = append(result, ep)
		}
	}
	return result
}

// sendKiroRequest builds and dispatches a single upstream attempt.
func sendKiroRequest(account *config.Account, reqBody []byte, ep kiroEndpoint, epURL string, isAPIKey bool) (*http.Response, error) {
	req, err := http.NewRequest("POST", epURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}

	host := ""
	if parsedURL, parseErr := url.Parse(epURL); parseErr == nil {
		host = parsedURL.Host
	}
	headerValues := buildStreamingHeaderValues(account, host)

	if isAPIKey {
		req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	} else {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "*/*")
	if ep.AmzTarget != "" {
		req.Header.Set("X-Amz-Target", ep.AmzTarget)
	}
	applyKiroBaseHeaders(req, account, headerValues)
	if !isAPIKey {
		req.Header.Set("x-amzn-kiro-agent-mode", "vibe")
	}
	// CLI captures use optout=false; IDE path keeps true.
	if isAPIKey {
		req.Header.Set("x-amzn-codewhisperer-optout", "false")
	} else {
		req.Header.Set("x-amzn-codewhisperer-optout", "true")
	}
	req.Header.Set("Amz-Sdk-Request", "attempt=1; max=3")
	req.Header.Set("Amz-Sdk-Invocation-Id", uuid.New().String())

	return GetClientForProxy(ResolveAccountProxyURL(account)).Do(req)
}

// sendKiroRequestWithModelRetry absorbs the throttle Kiro reports as a 400
// INVALID_MODEL_ID validation error (see transientModelRejectionPattern).
//
// The retry has to reuse the same endpoint and the same credential, because the
// throttle is per-account upstream state. The endpoint-fallback loop could not
// provide that: API Key credentials are pinned to the single Kiro CLI endpoint, so
// there was nothing to fall back to and every throttle reached the caller intact.
//
// Classifying the failure consumes the response body, so it is restored on the
// returned response and the caller reads it exactly as it did before.
func sendKiroRequestWithModelRetry(account *config.Account, reqBody []byte, ep kiroEndpoint, epURL string, isAPIKey bool) (*http.Response, error) {
	resp, err := sendKiroRequest(account, reqBody, ep, epURL, isAPIKey)
	if err != nil {
		return nil, err
	}

	for _, backoff := range modelThrottleBackoffs {
		if resp.StatusCode != http.StatusBadRequest {
			return resp, nil
		}

		errBody, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil || !isTransientModelRejection(string(errBody)) {
			resp.Body = io.NopCloser(bytes.NewReader(errBody))
			return resp, nil
		}

		logger.Warnf("[KiroAPI] Endpoint %s throttled the model as INVALID_MODEL_ID, retrying in %v", ep.Name, backoff)
		time.Sleep(backoff)

		resp, err = sendKiroRequest(account, reqBody, ep, epURL, isAPIKey)
		if err != nil {
			return nil, err
		}
	}

	return resp, nil
}

// CallKiroAPI calls the Kiro streaming API, trying each configured endpoint with automatic fallback.
func CallKiroAPI(account *config.Account, payload *KiroPayload, callback *KiroStreamCallback) error {
	originalProfileArn := ""
	if payload != nil {
		originalProfileArn = payload.ProfileArn
		defer func() {
			payload.ProfileArn = originalProfileArn
		}()
	}
	setPayloadProfileArnForAccount(payload, account)

	if _, err := json.Marshal(payload); err != nil {
		return err
	}

	// Debug: dump full payload for troubleshooting upstream rejections
	if payloadJSON, err := json.Marshal(payload); err == nil {
		logger.Debugf("[KiroAPI] Request payload: %s", string(payloadJSON))
	}

	// Wrap OnToolUse to restore original tool names for the client.
	if callback != nil && callback.OnToolUse != nil && len(payload.ToolNameMap) > 0 {
		originalOnToolUse := callback.OnToolUse
		nameMap := payload.ToolNameMap
		wrapped := *callback
		wrapped.OnToolUse = func(tu KiroToolUse) {
			if original, ok := nameMap[tu.Name]; ok {
				tu.Name = original
			}
			originalOnToolUse(tu)
		}
		callback = &wrapped
	}

	if payload != nil && strings.TrimSpace(payload.ProfileArn) == "" && !config.IsAPIKeyAccount(account) {
		if profileArn, err := ResolveProfileArn(account); err == nil {
			payload.ProfileArn = profileArn
		} else if isProfileArnResolutionSoftError(err) {
			logger.Debugf("[ProfileArn] Skipped profile ARN resolution for %s: %v", accountEmailForLog(account), err)
		} else {
			logger.Warnf("[ProfileArn] Failed to resolve profile ARN for %s: %v", accountEmailForLog(account), err)
		}
	}

	// Build endpoint list ordered by configuration / credential type.
	endpoints := endpointsForAccount(account)
	isAPIKey := config.IsAPIKeyAccount(account)

	var lastErr error
	longestRetryAfter := time.Duration(0)
	longestRetryAfterValue := ""
	for _, ep := range endpoints {
		// Update the origin field for the selected endpoint.
		payload.ConversationState.CurrentMessage.UserInputMessage.Origin = ep.Origin

		// Target the profile's data-plane region; endpoint URLs are declared for us-east-1.
		// API Key accounts use the CLI runtime host instead of IDE/Q hosts.
		epURL := regionalizeURLForProfile(ep.URL, account, payload.ProfileArn)
		if isAPIKey {
			epURL = cliRuntimeURL(account)
		}

		reqBody, _ := json.Marshal(payload)
		resp, err := sendKiroRequestWithModelRetry(account, reqBody, ep, epURL, isAPIKey)
		if err != nil {
			lastErr = err
			logger.Warnf("[KiroAPI] Endpoint %s failed: %v", ep.Name, err)
			continue
		}

		if resp.StatusCode == 429 {
			retryAfter := strings.TrimSpace(resp.Header.Get("Retry-After"))
			if cooldown := retryAfterDuration(retryAfter, time.Now()); cooldown > longestRetryAfter {
				longestRetryAfter = cooldown
				longestRetryAfterValue = retryAfter
			}
			resp.Body.Close()
			if len(endpoints) > 1 {
				logger.Warnf("[KiroAPI] Endpoint %s quota exhausted (429), trying next endpoint...", ep.Name)
			}
			lastErr = &upstreamQuotaError{endpoint: ep.Name, retryAfter: longestRetryAfterValue, retryFor: longestRetryAfter}
			continue
		}

		if resp.StatusCode != 200 {
			errBody, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			text := fmt.Sprintf("HTTP %d from %s: %s", resp.StatusCode, ep.Name, string(errBody))
			// A modeled exception in the body carries its own meaning. Typing it here
			// means "your request was invalid" reaches the client as 400 instead of
			// a blanket 502, which clients treat as transient and retry. Text is kept
			// verbatim so the existing message-based account-health checks still fire.
			if name := upstreamExceptionTypeFromBody(errBody); name != "" {
				lastErr = &KiroUpstreamError{
					ExceptionType: name,
					HTTPStatus:    resp.StatusCode,
					Text:          text,
				}
			} else {
				lastErr = fmt.Errorf("%s", text)
			}
			// Authentication errors and payment errors are not retried across endpoints.
			if resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 402 {
				return lastErr
			}
			logger.Warnf("[KiroAPI] Endpoint %s error: %v", ep.Name, lastErr)
			continue
		}

		err = parseEventStream(resp.Body, callback)
		resp.Body.Close()
		if err == ErrEmptyUpstreamResponse {
			logger.Warnf("[KiroAPI] Endpoint %s returned HTTP 200 with empty body/stream. Trying next endpoint...", ep.Name)
			lastErr = err
			continue
		}
		return err
	}

	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("all endpoints failed")
}

func accountEmailForLog(account *config.Account) string {
	if account == nil {
		return "<nil>"
	}
	return account.Email
}

// ==================== Upstream Exception Handling ====================

// KiroUpstreamError is a modeled error that arrived inside a 200 event stream.
//
// AWS event streams do not signal failures with an HTTP status: Smithy sends a
// frame carrying ":message-type: exception" plus ":exception-type: <MemberName>"
// and no ":event-type" at all. A parser keyed only on ":event-type" therefore saw
// an unknown frame and dropped it, and the stream then ended cleanly with no
// content. Callers received a well formed empty answer, which clients treat as a
// transient glitch and retry immediately — one upstream rejection turned into a
// tight retry loop.
type KiroUpstreamError struct {
	ExceptionType string
	Message       string
	// HTTPStatus is set when the exception arrived as a non-200 response rather
	// than as an in-stream frame. Upstream's own status is more authoritative
	// than classifying by exception name.
	HTTPStatus int
	// Text preserves the original error string. Existing callers pattern match on
	// phrases like "HTTP 401" and "quota", so replacing the message would break
	// account-health decisions that predate this type.
	Text string
}

func (e *KiroUpstreamError) Error() string {
	if e.Text != "" {
		return e.Text
	}
	if e.Message != "" {
		return fmt.Sprintf("%s: %s", e.ExceptionType, e.Message)
	}
	return e.ExceptionType
}

// StatusCode maps the upstream exception onto the HTTP status a client should see.
// Answering 502 for everything invites another retry, because clients treat 502
// as transient.
func (e *KiroUpstreamError) StatusCode() int {
	// Checked before HTTPStatus on purpose: upstream's own status for a throttled
	// model is 400, and that misreport is exactly what is being corrected. 429 is
	// the status clients know how to obey.
	if e.IsModelThrottle() {
		return http.StatusTooManyRequests
	}
	if e.HTTPStatus >= 400 && e.HTTPStatus < 600 {
		return e.HTTPStatus
	}
	t := strings.ToLower(e.ExceptionType)
	switch {
	case containsAny(t, "throttl", "toomanyrequests", "servicequota", "limitexceed"):
		return http.StatusTooManyRequests
	case containsAny(t, "accessdenied", "unauthorized", "forbidden", "expiredtoken", "invalidtoken"):
		return http.StatusUnauthorized
	case containsAny(t, "validation", "invalidrequest", "contentlengthexceed", "inputtoolong", "payloadtoolarge", "contextwindow"):
		return http.StatusBadRequest
	case containsAny(t, "serviceunavailable", "internalserver"):
		return http.StatusServiceUnavailable
	}
	return http.StatusBadGateway
}

// Retryable reports whether another account could plausibly succeed. A request
// upstream rejected on its own merits (oversized context, bad auth) is rejected
// identically everywhere, so retrying only burns the pool.
func (e *KiroUpstreamError) Retryable() bool {
	// A throttled model is worth another attempt even though it arrives typed as a
	// ValidationException, which the list below otherwise treats as permanent.
	if e.IsModelThrottle() {
		return true
	}
	t := strings.ToLower(e.ExceptionType)
	return !containsAny(t,
		"validation", "invalidrequest", "accessdenied", "unauthorized", "forbidden",
		"expiredtoken", "invalidtoken", "contentlengthexceed", "inputtoolong",
		"payloadtoolarge", "contextwindow")
}

// IsModelThrottle reports whether upstream dressed a throttle up as a model
// validation failure. Both fields are inspected because the reason code arrives in
// the raw response body on the HTTP path and in Message on the in-stream path;
// ExceptionType only ever says "ValidationException" and cannot distinguish them.
func (e *KiroUpstreamError) IsModelThrottle() bool {
	return isTransientModelRejection(e.Text) || isTransientModelRejection(e.Message)
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// ErrEmptyUpstreamResponse marks a 200 event stream that carried no text, no
// tool call, no token count and no metering. That is not an answer, and
// forwarding it as an empty assistant turn is what makes clients spin.
var ErrEmptyUpstreamResponse = &KiroUpstreamError{
	ExceptionType: "EmptyUpstreamResponse",
	Message:       "upstream returned no content, tokens or metering",
}

// upstreamExceptionTypeFromBody pulls the Smithy exception name out of a non-200
// error body, e.g. {"__type":"com.amazon.kiro.runtimeservice#ValidationException"}.
// Returns "" when the body is not a recognisable modeled error.
func upstreamExceptionTypeFromBody(body []byte) string {
	var probe struct {
		Type string `json:"__type"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return ""
	}
	name := probe.Type
	if name == "" {
		name = probe.Code
	}
	if i := strings.LastIndexByte(name, '#'); i >= 0 {
		name = name[i+1:]
	}
	if !strings.HasSuffix(name, "Exception") {
		return ""
	}
	return name
}

// AsUpstreamError extracts a *KiroUpstreamError from an error chain.
func AsUpstreamError(err error) (*KiroUpstreamError, bool) {
	var ue *KiroUpstreamError
	if errors.As(err, &ue) {
		return ue, true
	}
	return nil, false
}

// ==================== Event Stream Parsing ====================

// minEventStreamFrameSize is the smallest legal AWS event-stream frame: the
// 12-byte prelude plus the 4-byte trailing CRC, with no headers and no payload.
const minEventStreamFrameSize = 16

// maxEventStreamFrameSize caps how large a single declared frame may be before
// it is treated as corruption. The prelude length is attacker-influenced in the
// sense that any mid-stream corruption or spliced connection produces an
// arbitrary 4-byte value, and that value was passed straight to make([]byte,
// totalLength-12) — a single bogus header could request up to 4 GiB and take the
// whole process down with an OOM. Real Kiro frames carry a handful of JSON
// deltas and stay far below 1 MiB, so 16 MiB leaves generous headroom while
// still bounding one allocation.
const maxEventStreamFrameSize = 16 * 1024 * 1024

// parseEventStream decodes an AWS binary Event Stream response body.
func parseEventStream(body io.Reader, callback *KiroStreamCallback) error {
	if callback == nil {
		callback = &KiroStreamCallback{}
	}

	// Read directly without bufio to avoid buffering latency in streaming responses.
	var inputTokens, outputTokens int
	var totalCredits float64
	var currentToolUse *toolUseState
	// Whether upstream actually produced anything. A 200 stream with no text, no
	// tool call, no tokens and no metering is not an answer, and passing it on as
	// an empty assistant turn is what makes clients retry in a tight loop.
	producedOutput := false

	// Usage reported by upstream is real cost the moment it arrives, but it used to
	// be handed to the caller only after the loop finished cleanly, so every
	// mid-stream read error discarded the metering and token counts accumulated so
	// far. The caller then saw credits == 0 and attributed nothing, making a broken
	// or cancelled stream free. Flush exactly once on every exit path instead.
	//
	// Deliberately excludes finishToolUse: emitting a half-parsed tool call to the
	// client on an error path would hand it malformed arguments. Only the
	// accounting callbacks are safe to run after a failure.
	flushed := false
	flushUsage := func() {
		if flushed {
			return
		}
		flushed = true
		if callback.OnCredits != nil && totalCredits > 0 {
			callback.OnCredits(totalCredits)
		}
		if callback.OnComplete != nil {
			callback.OnComplete(inputTokens, outputTokens)
		}
	}
	defer flushUsage()

	for {
		// Prelude: 12 bytes (total_len + headers_len + crc)
		prelude := make([]byte, 12)
		_, err := io.ReadFull(body, prelude)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		totalLength := int(prelude[0])<<24 | int(prelude[1])<<16 | int(prelude[2])<<8 | int(prelude[3])
		headersLength := int(prelude[4])<<24 | int(prelude[5])<<16 | int(prelude[6])<<8 | int(prelude[7])

		// A well-formed frame is at least 16 bytes (12-byte prelude + 4-byte
		// trailer CRC) and never exceeds maxEventStreamFrameSize. Declaring
		// anything outside that range means the stream is corrupt from here on.
		//
		// This used to `continue`, which is wrong in a way that silently eats the
		// rest of the answer: the short frame's body was still sitting unread in
		// the stream, so the next iteration read those leftover bytes as a
		// prelude, desynchronised, and every subsequent event decoded as garbage
		// or hit an unexpected EOF. The client had already received whatever text
		// streamed before the bad frame, so it looked like the reply was simply
		// cut off mid-sentence with no error. Returning surfaces it through the
		// caller's error path, which terminates the SSE envelope properly.
		if totalLength < minEventStreamFrameSize || totalLength > maxEventStreamFrameSize {
			logger.Warnf("[KiroAPI] malformed event-stream frame: totalLength=%d outside [%d,%d], aborting stream",
				totalLength, minEventStreamFrameSize, maxEventStreamFrameSize)
			return &KiroUpstreamError{
				ExceptionType: "MalformedEventStreamFrame",
				Message:       fmt.Sprintf("event-stream frame declared an impossible length (%d bytes)", totalLength),
			}
		}
		if headersLength < 0 || headersLength > totalLength {
			logger.Warnf("[KiroAPI] malformed event-stream frame: headersLength=%d exceeds totalLength=%d, aborting stream",
				headersLength, totalLength)
			return &KiroUpstreamError{
				ExceptionType: "MalformedEventStreamFrame",
				Message:       fmt.Sprintf("event-stream frame declared headers longer than the frame (%d > %d)", headersLength, totalLength),
			}
		}

		// Read the remaining message bytes.
		remaining := totalLength - 12
		msgBuf := make([]byte, remaining)
		_, err = io.ReadFull(body, msgBuf)
		if err != nil {
			return err
		}

		if headersLength > len(msgBuf)-4 {
			continue
		}

		frameHeaders := parseFrameHeaders(msgBuf[0:headersLength])
		eventType := frameHeaders[":event-type"]
		messageType := frameHeaders[":message-type"]
		exceptionType := frameHeaders[":exception-type"]
		if exceptionType == "" {
			exceptionType = frameHeaders[":error-code"]
		}
		payloadBytes := msgBuf[headersLength : len(msgBuf)-4]

		var event map[string]interface{}
		if len(payloadBytes) > 0 {
			if err := json.Unmarshal(payloadBytes, &event); err != nil {
				event = nil
			}
		}

		// Errors are not ":event-type" frames. Returning here rather than skipping
		// is the whole point: the deferred flushUsage still reports whatever
		// upstream already metered, so a failure that cost money is still billed.
		if messageType == "exception" || messageType == "error" || exceptionType != "" ||
			strings.HasSuffix(eventType, "Exception") {
			name := exceptionType
			if name == "" {
				name = eventType
			}
			if name == "" {
				name = "UpstreamException"
			}
			msg := frameHeaders[":error-message"]
			for _, field := range []string{"message", "Message", "errorMessage", "reason"} {
				if event == nil {
					break
				}
				if v, ok := event[field].(string); ok && v != "" {
					msg = v
					break
				}
			}
			logger.Warnf("[KiroAPI] upstream exception frame: %s: %s (headers: %v, payload: %s)", name, msg, frameHeaders, string(payloadBytes))
			return &KiroUpstreamError{ExceptionType: name, Message: msg}
		}

		if event == nil {
			continue
		}

		inputTokens, outputTokens = updateTokensFromEvent(event, inputTokens, outputTokens)

		// Dispatch by event type.
		switch eventType {
		// Both text streams are passed through verbatim. Kiro sends
		// assistantResponseEvent and reasoningContentEvent as pure incremental deltas
		// (verified against real upstream traffic), never as cumulative snapshots, and
		// never replays a chunk: ordering and at-most-once delivery are already
		// guaranteed by TCP, and a dropped stream is retried as a whole new request
		// rather than resumed.
		//
		// Do NOT reintroduce content-based de-duplication here. At the string level a
		// replayed chunk is indistinguishable from text that simply repeats itself, and
		// the wire protocol carries no sequence number or message id to tell them apart
		// (the AWS event-stream base spec defines none), so such a heuristic can only
		// guess -- and when it guesses wrong it silently eats real output. The previous
		// implementation turned "6666666666" into "666", "abababab" into "abab" and
		// "1833" into "183", on both streams.
		case "assistantResponseEvent":
			if content, ok := event["content"].(string); ok && content != "" {
				producedOutput = true
				if callback.OnText != nil {
					callback.OnText(content, false)
				}
			}
		case "reasoningContentEvent":
			if text, ok := event["text"].(string); ok && text != "" {
				producedOutput = true
				if callback.OnText != nil {
					callback.OnText(text, true)
				}
			}
		case "toolUseEvent":
			producedOutput = true
			currentToolUse = handleToolUseEvent(event, currentToolUse, callback)
		case "meteringEvent":
			if usage, ok := event["usage"].(float64); ok {
				totalCredits += usage
			}
		case "contextUsageEvent":
			if pct, ok := event["contextUsagePercentage"].(float64); ok {
				if callback.OnContextUsage != nil {
					callback.OnContextUsage(pct)
				}
			}
		}
	}

	if currentToolUse != nil {
		finishToolUse(currentToolUse, callback)
	}

	flushUsage()

	// Clean EOF but nothing came back. Report it so the caller can fail over or
	// return a real error status, instead of handing the client an empty turn.
	// Metering is checked too: if upstream charged for the request it did work,
	// even when the visible output was empty.
	if !producedOutput && outputTokens == 0 && totalCredits == 0 {
		logger.Warnf("[KiroAPI] upstream returned an empty response (no content, tokens or metering)")
		return ErrEmptyUpstreamResponse
	}

	return nil
}

func updateTokensFromEvent(event map[string]interface{}, currentInputTokens, currentOutputTokens int) (int, int) {
	candidates := []map[string]interface{}{event}
	collectUsageMaps(event, &candidates)

	inputTokens := currentInputTokens
	outputTokens := currentOutputTokens

	for _, usage := range candidates {
		if usage == nil {
			continue
		}

		if v, ok := readTokenNumber(usage,
			"outputTokens", "completionTokens", "totalOutputTokens",
			"output_tokens", "completion_tokens", "total_output_tokens",
		); ok {
			outputTokens = v
		}

		if v, ok := readTokenNumber(usage,
			"inputTokens", "promptTokens", "totalInputTokens",
			"input_tokens", "prompt_tokens", "total_input_tokens",
		); ok {
			inputTokens = v
			continue
		}

		uncached, _ := readTokenNumber(usage, "uncachedInputTokens", "uncached_input_tokens")
		cacheRead, _ := readTokenNumber(usage, "cacheReadInputTokens", "cache_read_input_tokens")
		cacheWrite, _ := readTokenNumber(usage, "cacheWriteInputTokens", "cache_write_input_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens")
		if uncached+cacheRead+cacheWrite > 0 {
			inputTokens = uncached + cacheRead + cacheWrite
			continue
		}

		total, ok := readTokenNumber(usage, "totalTokens", "total_tokens")
		if ok && total > 0 {
			candidateOutput := outputTokens
			if v, vok := readTokenNumber(usage,
				"outputTokens", "completionTokens", "totalOutputTokens",
				"output_tokens", "completion_tokens", "total_output_tokens",
			); vok {
				candidateOutput = v
			}
			if total-candidateOutput > 0 {
				inputTokens = total - candidateOutput
			}
		}
	}

	return inputTokens, outputTokens
}

// defaultContextWindow is the window assumed for models that neither upstream
// nor the version heuristic identifies as large-context.
const defaultContextWindow = 200_000

// largeContextWindow is the 1M-token window advertised by Claude 4.6+ / 5.x.
const largeContextWindow = 1_000_000

// getContextWindowSize returns the context window size (in tokens) for a model.
//
// The authoritative source is Kiro's ListAvailableModels response
// (tokenLimits.maxInputTokens), recorded per model when the models cache is
// refreshed. When upstream has not reported a limit yet (cold start, alias
// models, offline fallback list) the version heuristic below is used: the
// 1M-token window applies to Claude 4.6 and newer (sonnet-4.6, opus-4.6,
// opus-4.7, opus-4.8, opus-5 and later), while 4.5 and earlier (opus-4.5,
// sonnet-4.5, sonnet-4, haiku-4.5) use a 200K window.
//
// This value is used to convert the upstream contextUsagePercentage into an
// absolute input-token count and to size the request payload budget. An
// undersized window under-reports tokens, makes clients compact early, and
// truncates history that the model could still have accepted.
func getContextWindowSize(model string) int {
	if lim, ok := lookupModelLimits(model); ok && lim.maxInput > 0 {
		return lim.maxInput
	}
	if isLargeContextModel(model) {
		return largeContextWindow
	}
	return defaultContextWindow
}

// claudeVersionExtractor matches "claude-<family>-<major>[.<minor>]" (dot or
// dash form) and is used to classify 1M-window models by version. The minor
// component is optional so major-only identifiers such as "claude-opus-5"
// classify correctly instead of falling through to the 200K default.
//
// "fable" is included because claude-fable-5 also ships a 1M window; leaving the
// family out made it fall through to the 200K default.
var claudeVersionExtractor = regexp.MustCompile(`claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?`)

func isLargeContextModel(model string) bool {
	m := strings.ToLower(model)
	if match := claudeVersionExtractor.FindStringSubmatch(m); match != nil {
		major, errMaj := strconv.Atoi(match[1])
		if errMaj == nil {
			// 1M window for any major >= 5 (claude-opus-5, claude-opus-5.1, ...).
			if major > 4 {
				return true
			}
			// Within Claude 4.x the window depends on the minor version, so an
			// absent minor (claude-sonnet-4) is treated as 4.0 -> 200K.
			minor := 0
			if match[2] != "" {
				parsed, errMin := strconv.Atoi(match[2])
				if errMin != nil {
					return false
				}
				minor = parsed
			}
			return major == 4 && minor >= 6
		}
	}
	// Fallback substring checks for non-standard identifiers.
	for _, tag := range []string{"4.6", "4-6", "4.7", "4-7", "4.8", "4-8", "4.9", "4-9"} {
		if strings.Contains(m, tag) {
			return true
		}
	}
	return false
}

func collectUsageMaps(v interface{}, out *[]map[string]interface{}) {
	switch t := v.(type) {
	case map[string]interface{}:
		for k, child := range t {
			lk := strings.ToLower(k)
			if lk == "usage" || lk == "tokenusage" || lk == "token_usage" {
				if m, ok := child.(map[string]interface{}); ok {
					*out = append(*out, m)
				}
			}
			collectUsageMaps(child, out)
		}
	case []interface{}:
		for _, child := range t {
			collectUsageMaps(child, out)
		}
	}
}

func readTokenNumber(m map[string]interface{}, keys ...string) (int, bool) {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch n := v.(type) {
		case float64:
			return int(n), true
		case int:
			return n, true
		case int64:
			return int(n), true
		case json.Number:
			if parsed, err := n.Int64(); err == nil {
				return int(parsed), true
			}
		case string:
			if parsed, err := strconv.Atoi(n); err == nil {
				return parsed, true
			}
			if parsed, err := strconv.ParseFloat(n, 64); err == nil {
				return int(parsed), true
			}
		}
	}
	return 0, false
}

// ==================== Tool Use Handling ====================

type toolUseState struct {
	ToolUseID   string
	Name        string
	InputBuffer strings.Builder
	GeneratedID bool
}

func handleToolUseEvent(event map[string]interface{}, current *toolUseState, callback *KiroStreamCallback) *toolUseState {
	toolUseID := firstStringField(event, "toolUseId", "toolUseID", "tool_use_id", "id")
	name := firstStringField(event, "name", "toolName", "tool_name")
	isStop := firstBoolField(event, "stop", "isStop", "done")

	if toolUseID != "" && name != "" {
		if current == nil {
			current = &toolUseState{ToolUseID: toolUseID, Name: name}
		} else if current.ToolUseID != toolUseID {
			if current.GeneratedID && current.Name == name {
				current.ToolUseID = toolUseID
				current.GeneratedID = false
			} else {
				finishToolUse(current, callback)
				current = &toolUseState{ToolUseID: toolUseID, Name: name}
			}
		}
	} else if name != "" && current == nil {
		current = &toolUseState{ToolUseID: "toolu_" + uuid.New().String(), Name: name, GeneratedID: true}
	} else if name != "" && current != nil && current.Name != name {
		finishToolUse(current, callback)
		current = &toolUseState{ToolUseID: "toolu_" + uuid.New().String(), Name: name, GeneratedID: true}
	}

	if current != nil {
		if input, ok := event["input"].(string); ok {
			current.InputBuffer.WriteString(input)
		} else if inputObj, ok := event["input"].(map[string]interface{}); ok {
			data, _ := json.Marshal(inputObj)
			current.InputBuffer.Reset()
			current.InputBuffer.Write(data)
		}
	}

	if isStop && current != nil {
		finishToolUse(current, callback)
		return nil
	}

	return current
}

func finishToolUse(state *toolUseState, callback *KiroStreamCallback) {
	if state == nil || state.Name == "" || callback == nil || callback.OnToolUse == nil {
		return
	}
	if state.ToolUseID == "" {
		state.ToolUseID = "toolu_" + uuid.New().String()
	}
	var input map[string]interface{}
	if state.InputBuffer.Len() > 0 {
		json.Unmarshal([]byte(state.InputBuffer.String()), &input)
	}
	if input == nil {
		input = make(map[string]interface{})
	}
	callback.OnToolUse(KiroToolUse{
		ToolUseID: state.ToolUseID,
		Name:      state.Name,
		Input:     input,
	})
}

func firstStringField(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func firstBoolField(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		if v, ok := m[key].(bool); ok {
			return v
		}
	}
	return false
}

// extractEventType extracts the event type string from AWS Event Stream message headers.
// parseFrameHeaders decodes every string-valued prelude header of an AWS event
// stream frame.
//
// The previous implementation returned as soon as it matched ":event-type", so
// ":message-type" and ":exception-type" were never read. Exception frames carry
// those two and no ":event-type" at all, which made them indistinguishable from
// an unknown event and got them silently discarded.
func parseFrameHeaders(headers []byte) map[string]string {
	out := make(map[string]string, 4)
	offset := 0
	for offset < len(headers) {
		nameLen := int(headers[offset])
		offset++
		if offset+nameLen > len(headers) {
			break
		}
		name := string(headers[offset : offset+nameLen])
		offset += nameLen
		if offset >= len(headers) {
			break
		}
		valueType := headers[offset]
		offset++

		if valueType == 7 { // String
			if offset+2 > len(headers) {
				break
			}
			valueLen := int(headers[offset])<<8 | int(headers[offset+1])
			offset += 2
			if offset+valueLen > len(headers) {
				break
			}
			out[name] = string(headers[offset : offset+valueLen])
			offset += valueLen
			continue
		}

		// Skip other value types by their fixed byte widths.
		skipSizes := map[byte]int{0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16}
		if valueType == 6 {
			if offset+2 > len(headers) {
				break
			}
			l := int(headers[offset])<<8 | int(headers[offset+1])
			offset += 2 + l
		} else if skip, ok := skipSizes[valueType]; ok {
			offset += skip
		} else {
			break
		}
	}
	return out
}

func extractEventType(headers []byte) string {
	return parseFrameHeaders(headers)[":event-type"]
}
