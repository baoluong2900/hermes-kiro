package proxy

import (
	"errors"
	"fmt"
	"strings"
)

// InputTooLongError reports that the upstream refused the request because its
// input exceeds the model's context window.
//
// This is a deterministic, request-shaped rejection: retrying it on another
// endpoint or another account cannot help. The proxy deliberately does not trim
// history to dodge it (byte-based trimming silently dropped context and severed
// tool_use/tool_result pairs); instead the condition is surfaced to the client
// as HTTP 400 so the client can compact its own context and retry.
type InputTooLongError struct {
	Endpoint string
	Body     string
	// Message is the client-facing text, filled in by the handler once it knows
	// the model and the estimated input size (see markInputTooLong).
	Message string
}

func (e *InputTooLongError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("input too long: upstream %s rejected the request (CONTENT_LENGTH_EXCEEDS_THRESHOLD): %s",
		e.Endpoint, e.Body)
}

// IsInputTooLong reports whether err is an upstream context-window rejection.
func IsInputTooLong(err error) bool {
	var target *InputTooLongError
	return errors.As(err, &target)
}

// codeContextLengthExceeded is the OpenAI-vocabulary error code for an input
// that overflows the model's context window.
const codeContextLengthExceeded = "context_length_exceeded"

// inputTooLongMessage renders the client-facing message for an upstream
// context-window rejection. It mirrors Anthropic's own phrasing
// ("prompt is too long: N tokens > M maximum") because clients pattern-match
// that text to trigger their own context compaction and retry.
//
// estimatedTokens is the proxy's local estimate (the upstream does not report a
// count with the rejection). contextWindow is 0 when unknown.
func inputTooLongMessage(estimatedTokens, contextWindow int) string {
	if contextWindow <= 0 {
		if estimatedTokens > 0 {
			return fmt.Sprintf("prompt is too long: %d tokens > the maximum for this model", estimatedTokens)
		}
		return "prompt is too long: exceeds the maximum input tokens for this model"
	}
	if estimatedTokens > 0 {
		return fmt.Sprintf("prompt is too long: %d tokens > %d maximum", estimatedTokens, contextWindow)
	}
	return fmt.Sprintf("prompt is too long: exceeds the maximum of %d input tokens", contextWindow)
}

// isInputTooLongBody detects the upstream context-window rejection from an
// error response body. CONVERSATION_LIMIT_EXCEEDED reads as overflow too: the
// only lever the caller has is a smaller conversation, and the service has been
// seen attaching it to statuses other than 400 (402, 429).
func isInputTooLongBody(body string) bool {
	if strings.Contains(body, "CONTENT_LENGTH_EXCEEDS_THRESHOLD") ||
		strings.Contains(body, "CONVERSATION_LIMIT_EXCEEDED") {
		return true
	}
	return strings.Contains(body, "Input is too long") ||
		strings.Contains(body, "Input content length exceeds threshold")
}

// markInputTooLong reports whether err is a context-window rejection and, if
// so, fills in the client-facing message for model. Handlers stop failing over
// when it returns true: every account rejects the same bytes.
func markInputTooLong(err error, model string, estimatedTokens int) bool {
	var target *InputTooLongError
	if !errors.As(err, &target) {
		return false
	}
	if target.Message == "" {
		target.Message = inputTooLongMessage(estimatedTokens, getContextWindowSize(model))
	}
	return true
}

// clientErrorType picks the error type for a failed request: an oversized
// input is the caller's to fix, everything else is reported as fallback.
func clientErrorType(err error, fallback string) string {
	if IsInputTooLong(err) {
		return "invalid_request_error"
	}
	return fallback
}
