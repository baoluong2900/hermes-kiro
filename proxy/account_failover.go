package proxy

import (
	"errors"
	"kiro-go/config"
	"kiro-go/logger"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxAccountRetryAttempts = 3

// errNoAvailableAccounts is logged when the pool yields no eligible account
// before any upstream call. Previously this 503 left no request-log entry, so
// an operator saw a healthy-looking pool and a silent outage.
var errNoAvailableAccounts = errors.New("No available accounts (every enabled account is cooling down, exhausted, or has an expired token)")

// noAvailableAccountsRetryAfter is the Retry-After hint sent with the 503 the
// pool returns when it has nothing to route to.
//
// Without it clients treat the 503 as a transient blip and retry immediately:
// an exhausted pool produced bursts of four identical requests within six
// seconds per client, which is pure log noise since not one of them can
// succeed until an account recovers. A minute is short enough that a pool that
// recovers quickly (a cooldown expiring) is picked up promptly, and long enough
// to stop the hammering.
const noAvailableAccountsRetryAfter = "60"

// sendNoAvailableAccounts writes the pool-empty 503 for a client.
//
// The reason travels to the client, not just to the request log. The two used
// to disagree — the log said "every enabled account is cooling down, exhausted,
// or has an expired token" while the caller saw a bare "No available accounts"
// — so whoever was reading the client side could not tell an exhausted quota
// from a gateway bug without shell access to the host.
func (h *Handler) sendNoAvailableAccounts(w http.ResponseWriter, kind string) {
	w.Header().Set("Retry-After", noAvailableAccountsRetryAfter)
	switch kind {
	case endpointKindOpenAI:
		h.sendOpenAIError(w, http.StatusServiceUnavailable, "server_error", errNoAvailableAccounts.Error())
	default:
		h.sendClaudeError(w, http.StatusServiceUnavailable, "api_error", errNoAvailableAccounts.Error())
	}
}

const (
	endpointKindClaude = "claude"
	endpointKindOpenAI = "openai"
)

const (
	defaultQuotaCooldown       = time.Hour
	minQuotaCooldown           = 10 * time.Second
	maxQuotaCooldown           = 24 * time.Hour
	emptyResponseModelCooldown = 30 * time.Second
)

// upstreamQuotaError carries the upstream Retry-After hint across the API-call
// boundary so account selection can observe it instead of hammering the same
// credential on every incoming Claude CLI request.
type upstreamQuotaError struct {
	endpoint   string
	retryAfter string
	retryFor   time.Duration
}

func (e *upstreamQuotaError) Error() string {
	if e == nil || e.endpoint == "" {
		return "quota exhausted"
	}
	return "quota exhausted on " + e.endpoint
}

func retryAfterDuration(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultQuotaCooldown
	}

	var duration time.Duration
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		duration = time.Duration(seconds) * time.Second
	} else if retryAt, err := http.ParseTime(value); err == nil {
		duration = retryAt.Sub(now)
	} else {
		return defaultQuotaCooldown
	}

	if duration < minQuotaCooldown {
		return minQuotaCooldown
	}
	if duration > maxQuotaCooldown {
		return maxQuotaCooldown
	}
	return duration
}

func retryAfterHeader(err error) string {
	var quotaErr *upstreamQuotaError
	if errors.As(err, &quotaErr) {
		if quotaErr.retryFor > 0 {
			seconds := int64((quotaErr.retryFor + time.Second - 1) / time.Second)
			return strconv.FormatInt(seconds, 10)
		}
		return strings.TrimSpace(quotaErr.retryAfter)
	}
	return ""
}

func upstreamErrorHTTPStatus(err error) int {
	if err == nil {
		return http.StatusServiceUnavailable
	}
	// A modeled exception frame already knows its own status. Checked before the
	// string heuristics below so throttling does not fall through to a blanket
	// 502, which clients treat as transient and retry immediately.
	if ue, ok := AsUpstreamError(err); ok {
		return ue.StatusCode()
	}
	msg := err.Error()
	switch {
	case isQuotaErrorMessage(msg):
		return http.StatusTooManyRequests
	case isAuthErrorMessage(msg):
		return http.StatusUnauthorized
	default:
		return http.StatusBadGateway
	}
}

func setRetryAfterHeader(w http.ResponseWriter, err error) {
	if w == nil {
		return
	}
	if value := retryAfterHeader(err); value != "" {
		w.Header().Set("Retry-After", value)
	}
}

func isQuotaErrorMessage(msg string) bool {
	msg = strings.ToLower(msg)
	return strings.Contains(msg, "429") || strings.Contains(msg, "quota")
}

func isOverageErrorMessage(msg string) bool {
	msg = strings.ToLower(msg)
	return strings.Contains(msg, "402") && strings.Contains(msg, "overage")
}

func isSuspensionErrorMessage(msg string) bool {
	msg = strings.ToLower(msg)
	// Covers both "temporarily is suspended" (REST/IDE) and the CLI runtime's
	// "User ID is temporarily suspended" word order, plus the underscore form.
	return strings.Contains(msg, "temporarily_suspended") ||
		strings.Contains(msg, "temporarily is suspended") ||
		strings.Contains(msg, "temporarily suspended") ||
		strings.Contains(msg, "account suspended")
}

func isProfileUnavailableErrorMessage(msg string) bool {
	msg = strings.ToLower(msg)
	return strings.Contains(msg, "no available kiro profile")
}

func isAuthErrorMessage(msg string) bool {
	msg = strings.ToLower(msg)
	return strings.Contains(msg, "http 401") ||
		strings.Contains(msg, "http 403") ||
		strings.Contains(msg, "unauthorized") ||
		strings.Contains(msg, "forbidden") ||
		strings.Contains(msg, "authentication failed") ||
		strings.Contains(msg, "token invalid") ||
		strings.Contains(msg, "token expired") ||
		strings.Contains(msg, "invalid_grant") ||
		strings.Contains(msg, "access token expired") ||
		strings.Contains(msg, "refresh token expired")
}

func (h *Handler) disableAccount(account *config.Account, banStatus, banReason string) {
	if account == nil {
		return
	}

	if !account.Enabled && account.BanStatus == banStatus && account.BanReason == banReason {
		return
	}

	if err := config.SetAccountBanStatus(account.ID, banStatus, banReason); err != nil {
		logger.Warnf("[AccountFailover] Failed to disable %s: %v", account.Email, err)
		return
	}

	logger.Warnf("[AccountFailover] Disabled %s: %s", account.Email, banReason)
	h.pool.Reload()
}

func (h *Handler) disableAccountOverage(account *config.Account) {
	if account == nil {
		return
	}

	snap, fetchErr := FetchOverageStatus(account)
	if fetchErr != nil {
		logger.Warnf("[AccountFailover] Failed to refresh overage status for %s: %v", account.Email, fetchErr)
		return
	}
	if persistErr := PersistOverageSnapshot(account.ID, snap); persistErr != nil {
		logger.Warnf("[AccountFailover] Failed to persist overage snapshot for %s: %v", account.Email, persistErr)
		return
	}

	logger.Warnf("[AccountFailover] Refreshed overage status for %s after upstream overage limit error: %s", account.Email, snap.Status)
	h.pool.Reload()
}

func (h *Handler) handleAccountFailure(account *config.Account, err error) {
	h.handleAccountModelFailure(account, "", err)
}

func (h *Handler) handleAccountModelFailure(account *config.Account, model string, err error) {
	if account == nil || err == nil {
		return
	}

	errMsg := err.Error()

	// An exception frame carries its own classification, so use it rather than
	// pattern matching the message. Without this a ThrottlingException fell
	// through to the default branch and got no cooldown, so the same credential
	// was hammered on the very next request.
	if ue, ok := AsUpstreamError(err); ok {
		t := strings.ToLower(ue.ExceptionType)
		switch {
		case containsAny(t, "throttl", "toomanyrequests", "servicequota", "limitexceed"):
			h.pool.RecordErrorWithCooldown(account.ID, defaultQuotaCooldown)
		case containsAny(t, "accessdenied", "unauthorized", "forbidden", "expiredtoken", "invalidtoken"):
			h.disableAccount(account, "BANNED", "Authentication failed - token invalid or expired")
		default:
			// Includes EmptyUpstreamResponse: request/stream failure rather than
			// broken account credentials. Do not accumulate towards consecutive error
			// cooldown to prevent account pool starvation.
			if ue.ExceptionType == "EmptyUpstreamResponse" {
				logger.Warnf("[AccountFailover] Soft failure (%s) on %s, not incrementing account error count", ue.ExceptionType, account.Email)
				if model != "" {
					// Empty streams are transient, not evidence of an hour-long quota block.
					h.pool.RecordModelCooldown(account.ID, model, emptyResponseModelCooldown)
					logger.Warnf("[AccountFailover] Model %s cooled down on %s for %v due to empty upstream response", model, account.Email, emptyResponseModelCooldown)
				}
				return
			}
			// A request rejected on its own merits (e.g. 400 "Invalid tool use
			// format") fails on every account; counting it put the shared account
			// in cooldown and 503'd every other key ("No available accounts").
			if !ue.Retryable() {
				return
			}
			h.pool.RecordError(account.ID, false)
		}
		return
	}

	switch {
	case isOverageErrorMessage(errMsg):
		h.disableAccountOverage(account)
		h.pool.RecordError(account.ID, false)
	case isQuotaErrorMessage(errMsg):
		cooldown := defaultQuotaCooldown
		var quotaErr *upstreamQuotaError
		if errors.As(err, &quotaErr) {
			if quotaErr.retryFor > 0 {
				cooldown = quotaErr.retryFor
			} else {
				cooldown = retryAfterDuration(quotaErr.retryAfter, time.Now())
			}
		}
		h.pool.RecordErrorWithCooldown(account.ID, cooldown)
	case isSuspensionErrorMessage(errMsg):
		h.disableAccount(account, "BANNED", "AWS temporarily suspended - unusual user activity detected")
	case isProfileUnavailableErrorMessage(errMsg):
		// Profile ARN may be transiently unresolvable (upstream blip, stale token).
		// Treat as a soft failure: short cooldown so the next request rotates account,
		// but never auto-disable — operators can still investigate via warn logs.
		h.pool.RecordError(account.ID, false)
	case isAuthErrorMessage(errMsg):
		h.disableAccount(account, "BANNED", "Authentication failed - token invalid or expired")
	default:
		h.pool.RecordError(account.ID, false)
	}
}
