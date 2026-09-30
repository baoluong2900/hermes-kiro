package proxy

import (
	"kiro-go/config"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newTestHolds gives each test its own ledger so parallel packages/tests never
// share the process-global map.
func newTestHolds() *creditHolds {
	return &creditHolds{byKey: make(map[string][]creditHold)}
}

// TestCreditHoldsUnlimitedKeyNeverBlocked proves a key with CreditLimit == 0 is
// treated as unlimited: reserve always admits, takes no hold, and the release is
// a harmless no-op.
func TestCreditHoldsUnlimitedKeyNeverBlocked(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "unlimited", Key: "sk-unlimited", Enabled: true, CreditLimit: 0})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	holds := newTestHolds()

	// Even far more requests than any small limit could admit must all pass.
	for i := 0; i < 1000; i++ {
		release, ok := holds.reserve(created.ID)
		if !ok {
			t.Fatalf("unlimited key was refused on request %d", i)
		}
		if got := holds.reservedCredits(created.ID); got != 0 {
			t.Fatalf("unlimited key must never take a hold, got reserved=%v", got)
		}
		release(0)
	}
}

// TestCreditHoldsEmptyApiKeyNeverBlocked covers the legacy single-key /
// unauthenticated path where no per-key ID is attached: it must not be gated.
func TestCreditHoldsEmptyApiKeyNeverBlocked(t *testing.T) {
	holds := newTestHolds()
	release, ok := holds.reserve("")
	if !ok {
		t.Fatal("empty apiKeyID must always be admitted")
	}
	release(0)
}

// TestCreditHoldsReleaseReturnsCredit proves a hold is returned when a request
// fails (release is called), so the next request sees the freed credit and is
// admitted rather than blocked by a leaked hold.
func TestCreditHoldsReleaseReturnsCredit(t *testing.T) {
	mustInitConfig(t)
	// Limit fits exactly one outstanding 0.01 hold: used(0)+reserved+0.01 must
	// stay <= 0.01, so a second concurrent hold would breach it.
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "one", Key: "sk-one", Enabled: true, CreditLimit: defaultCreditReservation})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	holds := newTestHolds()

	release1, ok := holds.reserve(created.ID)
	if !ok {
		t.Fatal("first request must be admitted")
	}
	// A second concurrent request must be refused while the first hold is live.
	if _, ok := holds.reserve(created.ID); ok {
		t.Fatal("second concurrent request must be refused while the ceiling is held")
	}
	// The failed request returns its hold...
	release1(0)
	if got := holds.reservedCredits(created.ID); got != 0 {
		t.Fatalf("release must free the hold, got reserved=%v", got)
	}
	// ...and now a fresh request fits again.
	release2, ok := holds.reserve(created.ID)
	if !ok {
		t.Fatal("after release the ceiling must admit a new request")
	}
	release2(0)
}

// TestCreditHoldsReleaseIsIdempotent proves calling release more than once (as
// a belt-and-suspenders defer might in refactors) frees exactly one hold and
// never steals a concurrent request's hold.
func TestCreditHoldsReleaseIsIdempotent(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "idem", Key: "sk-idem", Enabled: true, CreditLimit: 1.0})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	holds := newTestHolds()

	releaseA, ok := holds.reserve(created.ID)
	if !ok {
		t.Fatal("A must be admitted")
	}
	releaseB, ok := holds.reserve(created.ID)
	if !ok {
		t.Fatal("B must be admitted")
	}
	// Double-release A: must drop only A's hold, leaving B's intact.
	releaseA(0)
	releaseA(0)
	if got := holds.reservedCredits(created.ID); got != defaultCreditReservation {
		t.Fatalf("double release must free exactly one hold, got reserved=%v want %v", got, defaultCreditReservation)
	}
	releaseB(0)
	if got := holds.reservedCredits(created.ID); got != 0 {
		t.Fatalf("both holds should now be freed, got reserved=%v", got)
	}
}

// TestCreditHoldsExpiredHoldIsReclaimed proves a hold whose settle/release never
// ran (aborted stream, crashed goroutine) does not lock credit forever: once it
// is older than holdTTL it is reclaimed and a new request is admitted.
func TestCreditHoldsExpiredHoldIsReclaimed(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "expire", Key: "sk-expire", Enabled: true, CreditLimit: defaultCreditReservation})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	holds := newTestHolds()

	// Simulate a leaked hold: admitted but its release never runs, and it is
	// backdated beyond the TTL as if the request died long ago.
	if _, ok := holds.reserve(created.ID); !ok {
		t.Fatal("leaked request must have been admitted")
	}
	holds.mu.Lock()
	leaked := holds.byKey[created.ID]
	if len(leaked) != 1 {
		holds.mu.Unlock()
		t.Fatalf("expected exactly one leaked hold, got %d", len(leaked))
	}
	leaked[0].at = time.Now().Add(-holdTTL - time.Minute)
	holds.byKey[created.ID] = leaked
	holds.mu.Unlock()

	// The reclaim happens on the next reserve: the expired hold no longer counts.
	release, ok := holds.reserve(created.ID)
	if !ok {
		t.Fatal("an expired hold must be reclaimed so a new request is admitted")
	}
	if got := holds.reservedCredits(created.ID); got != defaultCreditReservation {
		t.Fatalf("only the new live hold should remain, got reserved=%v", got)
	}
	release(0)
}

// TestCreditHoldsSettleDoesNotDoubleCount proves the ledger's release does not
// itself touch the persistent per-key counters — it only frees the in-process
// hold. The real charge is booked exactly once, by RecordApiKeyUsage, exactly
// as the handlers do it. If release double-counted, CreditsUsed would end up
// above the single recorded charge.
func TestCreditHoldsSettleDoesNotDoubleCount(t *testing.T) {
	mustInitConfig(t)
	created, err := config.AddApiKey(config.ApiKeyEntry{Name: "settle", Key: "sk-settle", Enabled: true, CreditLimit: 10.0})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	holds := newTestHolds()

	release, ok := holds.reserve(created.ID)
	if !ok {
		t.Fatal("must be admitted")
	}
	// The handler books the real metered charge exactly once via RecordApiKeyUsage.
	const realCharge = 2.5
	if err := config.RecordApiKeyUsage(created.ID, 100, realCharge); err != nil {
		t.Fatalf("RecordApiKeyUsage: %v", err)
	}
	// Settling passes the same real charge, but that must NOT add to the balance
	// again — the ledger only frees the hold.
	release(realCharge)

	got := config.GetApiKeyEntry(created.ID)
	if got == nil {
		t.Fatal("key vanished")
	}
	if d := got.CreditsUsed - realCharge; d > 1e-9 || d < -1e-9 {
		t.Fatalf("charge must be booked exactly once: got CreditsUsed=%v want %v", got.CreditsUsed, realCharge)
	}
	if got.RequestsCount != 1 {
		t.Fatalf("exactly one delivered request expected, got %d", got.RequestsCount)
	}
	if r := holds.reservedCredits(created.ID); r != 0 {
		t.Fatalf("hold must be freed after settle, got reserved=%v", r)
	}
}

// TestCreditHoldsConcurrentCeilingHolds is the core test. It fires many parallel
// requests at a key with a small credit limit, running the full admission ->
// charge -> settle lifecycle each admitted request goes through in the handlers,
// and asserts:
//   - the recorded credit total never exceeds the limit, and
//   - some requests were refused (by the reservation ledger).
//
// Before the reservation ledger existed, every goroutine read the same stale
// pre-request balance, all passed the one-shot auth check, and the recorded
// total blew far past the ceiling. With reservations, outstanding holds are
// counted at admission so concurrent requests cannot all slip through.
//
// Each admitted request charges exactly the hold amount, so the admission
// invariant used + reserved + hold <= limit directly bounds the recorded total:
// every refusal here is produced by the reservation ledger itself, not by any
// out-of-band re-check.
func TestCreditHoldsConcurrentCeilingHolds(t *testing.T) {
	mustInitConfig(t)

	const (
		chargePerReq    = defaultCreditReservation // 0.01: hold == real charge
		maxSuccesses    = 30                        // limit admits exactly this many
		creditLimit     = maxSuccesses * chargePerReq
		totalGoroutines = 500 // far more than can fit, to force refusals
	)
	created, err := config.AddApiKey(config.ApiKeyEntry{
		Name: "ceiling", Key: "sk-ceiling-concurrent", Enabled: true, CreditLimit: creditLimit,
	})
	if err != nil {
		t.Fatalf("AddApiKey: %v", err)
	}
	holds := newTestHolds()

	var admitted int64
	var refused int64

	var wg sync.WaitGroup
	wg.Add(totalGoroutines)
	for i := 0; i < totalGoroutines; i++ {
		go func() {
			defer wg.Done()
			release, ok := holds.reserve(created.ID)
			if !ok {
				atomic.AddInt64(&refused, 1)
				return
			}
			atomic.AddInt64(&admitted, 1)
			// Simulate the upstream call + settle window. The charge is booked
			// exactly once (as the handler does via RecordApiKeyUsage), and the
			// hold is freed exactly once via the deferred release. Holding the
			// reservation across the charge is what keeps a concurrent burst
			// from all reading the same pre-charge balance.
			defer release(chargePerReq)
			_ = config.RecordApiKeyUsage(created.ID, 10, chargePerReq)
		}()
	}
	wg.Wait()

	got := config.GetApiKeyEntry(created.ID)
	if got == nil {
		t.Fatal("key vanished")
	}
	// The ceiling must hold: recorded credit never exceeds the limit.
	if got.CreditsUsed > creditLimit+1e-9 {
		t.Fatalf("ceiling breached: recorded CreditsUsed=%v exceeds limit=%v (admitted=%d refused=%d)",
			got.CreditsUsed, creditLimit, admitted, refused)
	}
	// Some requests must have been refused by the reservation ledger; otherwise
	// the ceiling was never actually exercised.
	if refused == 0 {
		t.Fatalf("expected the reservation ledger to refuse some requests, admitted=%d", admitted)
	}
	// And some must have succeeded, proving we did not deadlock or reject all.
	if admitted == 0 {
		t.Fatalf("expected some requests to succeed, refused=%d", refused)
	}
	// No holds may leak once everything has settled.
	if r := holds.reservedCredits(created.ID); r != 0 {
		t.Fatalf("no holds may remain after all requests settle, got reserved=%v", r)
	}
	t.Logf("admitted=%d refused=%d finalCreditsUsed=%v limit=%v", admitted, refused, got.CreditsUsed, creditLimit)
}
