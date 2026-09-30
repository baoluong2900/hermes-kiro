package proxy

import (
	"kiro-go/config"
	"math"
	"sync"
	"time"
)

// creditHolds closes the concurrent-admission hole in the per-API-key credit
// ceiling.
//
// THE HOLE
// The credit check in authenticate reads CreditsUsed, compares it to
// CreditLimit, and admits the request. Usage is only written back after the
// request finishes. N concurrent requests therefore all read the same
// pre-request balance, all pass the check, and together blow far past the
// ceiling: a key with 0.1 credits left could admit dozens of parallel requests
// and end up hundreds of credits over.
//
// THE FIX (modelled on the Cloudflare worker's ApiKeyQuota Durable Object)
// Admission places an in-process "hold" against the key. A request is admitted
// only if CreditsUsed + sum(outstanding holds) + this request's hold stays
// under CreditLimit. Because the hold is recorded the instant a request is
// admitted, the (N+1)th concurrent request sees the first N holds and is
// refused. The hold is released (on failure with nothing metered) or settled
// (replaced by the real metered charge, which the existing RecordApiKeyUsage /
// RecordApiKeyPartialUsage calls persist) on every exit path.
//
// WHY THE proxy PACKAGE
// The ledger is consulted from authenticate (proxy) and settled from the
// handlers (proxy). It reads config.GetApiKeyEntry to learn the live
// CreditsUsed/CreditLimit but the config package never needs to know holds
// exist. Placing it in config would invert that dependency for no benefit and
// risk an import cycle if config ever needed proxy types; placing it in proxy
// keeps the one-way proxy -> config dependency intact. The Go server is a
// single process, so a mutex-guarded map is sufficient — no external store.
type creditHolds struct {
	mu    sync.Mutex
	byKey map[string][]creditHold
}

// creditHold is a dated reservation. Dating each hold (rather than keeping a
// single running total, as an earlier worker design did) is what lets a leaked
// hold expire on its own: the worker learned that streaming clients disconnect
// constantly and their settlement never runs, so an undated running total only
// ever grew and permanently locked credit. A hold whose settle/release never
// ran is reclaimed once it is older than holdTTL.
type creditHold struct {
	amount float64
	at     time.Time
}

const (
	// defaultCreditReservation is the hold placed at admission. We do not yet
	// know the real cost of a request when we admit it (upstream meters only
	// after it runs), so we reserve a small fixed amount purely to gate
	// concurrency. Settlement replaces it with the true metered charge. This
	// mirrors the worker's DEFAULT_CREDIT_RESERVATION.
	defaultCreditReservation = 0.01

	// holdTTL bounds how long a hold can lock credit before it is reclaimed as
	// leaked. It must be longer than the slowest realistic upstream call so a
	// legitimately slow-but-alive request is never reclaimed out from under
	// itself. The handlers give their HTTP clients a 10-minute ceiling
	// (see proxyExternalClaude: `clientTimeout := 10 * time.Minute`), and a
	// request can retry across up to maxAccountRetryAttempts (3) accounts, so a
	// single admitted request can legitimately stay in flight for a good while.
	// 15 minutes sits comfortably above that worst case while still ensuring a
	// hold from a request that died without settling frees its credit in a
	// bounded, human-noticeable window rather than forever. (The worker used
	// 5 minutes for a single non-retrying edge call; we pick a larger value
	// because our upstream ceiling is 10 minutes and requests can retry.)
	holdTTL = 15 * time.Minute
)

var globalCreditHolds = &creditHolds{byKey: make(map[string][]creditHold)}

// reserveCredit attempts to admit a request against the given API key's credit
// ceiling, accounting for credit already used plus all outstanding holds.
//
// It returns (release, ok). When ok is true the caller MUST eventually call
// release exactly once — via defer, so no exit path (including panics and early
// returns) can skip it. Passing the real metered charge to release settles the
// hold at that charge (the persistent counters are updated separately by the
// existing Record* calls, so release only frees the in-process hold and never
// double-counts). Passing 0 simply frees the hold.
//
// When ok is false the request must be rejected: admitting it would breach the
// ceiling once outstanding concurrent holds are counted.
//
// Keys with CreditLimit == 0 are unlimited: no hold is taken, no throttling is
// applied, and the returned release is a no-op.
func (c *creditHolds) reserve(apiKeyID string) (release func(charge float64), ok bool) {
	noop := func(float64) {}
	if apiKeyID == "" {
		return noop, true
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Read the live balance while holding the ledger lock. Reading it outside
	// the lock would reopen the very race we are closing: two goroutines could
	// each snapshot the same CreditsUsed, then both take the lock in turn and
	// both admit. release() and the handler's RecordApiKeyUsage advance
	// CreditsUsed, and settlement always records the charge before releasing the
	// hold, so a reservation taken here sees every already-settled charge.
	entry := config.GetApiKeyEntry(apiKeyID)
	if entry == nil {
		// Unknown key: nothing to throttle here. Auth already validated it;
		// if it vanished mid-flight, do not block on a hold.
		return noop, true
	}
	// Unlimited keys are never held or throttled.
	if entry.CreditLimit <= 0 {
		return noop, true
	}

	holds := c.liveHoldsLocked(apiKeyID, time.Now())
	reserved := sumHolds(holds)

	// Round to 6 decimals before the ceiling comparison. Credits accumulate
	// through many small floating-point additions (each hold and each settled
	// charge), and the drift is enough to let a request slip in when
	// used+reserved+hold lands one ULP under the limit — admitting one charge
	// too many. The Cloudflare worker guards the same way with toFixed(6).
	if roundCredit(entry.CreditsUsed+reserved+defaultCreditReservation) > entry.CreditLimit {
		// Persist the reclaimed slice so an expired hold does not keep counting.
		c.byKey[apiKeyID] = holds
		return noop, false
	}

	h := creditHold{amount: defaultCreditReservation, at: time.Now()}
	c.byKey[apiKeyID] = append(holds, h)

	var once sync.Once
	release = func(_ float64) {
		once.Do(func() {
			c.dropHold(apiKeyID, h)
		})
	}
	return release, true
}

// liveHoldsLocked returns the non-expired holds for a key, having pruned any
// that are older than holdTTL. Callers must hold c.mu.
func (c *creditHolds) liveHoldsLocked(apiKeyID string, now time.Time) []creditHold {
	holds := c.byKey[apiKeyID]
	if len(holds) == 0 {
		return nil
	}
	live := holds[:0:0] // fresh backing array; never alias the stored slice
	for _, h := range holds {
		if h.amount > 0 && now.Sub(h.at) < holdTTL {
			live = append(live, h)
		}
	}
	return live
}

// dropHold removes a single matching hold. It matches on the exact hold
// identity (amount + timestamp) so releasing one request's hold never steals
// another concurrent request's live hold. A miss means the hold was already
// reclaimed by the TTL, in which case nothing is dropped.
func (c *creditHolds) dropHold(apiKeyID string, target creditHold) {
	c.mu.Lock()
	defer c.mu.Unlock()
	holds := c.byKey[apiKeyID]
	for i := range holds {
		if holds[i].at.Equal(target.at) && holds[i].amount == target.amount {
			holds = append(holds[:i], holds[i+1:]...)
			break
		}
	}
	if len(holds) == 0 {
		delete(c.byKey, apiKeyID)
		return
	}
	c.byKey[apiKeyID] = holds
}

// reservedCredits returns the sum of live holds for a key, pruning expired ones.
// Exposed for tests and diagnostics.
func (c *creditHolds) reservedCredits(apiKeyID string) float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	holds := c.liveHoldsLocked(apiKeyID, time.Now())
	c.byKey[apiKeyID] = holds
	if len(holds) == 0 {
		delete(c.byKey, apiKeyID)
	}
	return sumHolds(holds)
}

func sumHolds(holds []creditHold) float64 {
	var sum float64
	for _, h := range holds {
		sum += h.amount
	}
	return roundCredit(sum)
}

// roundCredit rounds a credit value to 6 decimal places to keep floating-point
// drift from accumulating across many small additions. Matches the worker's
// toFixed(6).
func roundCredit(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}
