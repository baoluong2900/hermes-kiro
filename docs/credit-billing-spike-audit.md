# Audit: request credit deduction spikes then self-corrects (`ksk_...` keys)

Reported symptom: in the Cloudflare gateway dashboard ("Lịch sử Requests gần
nhất"), a request against `ksk_<redacted-key-id>` is briefly
debited 50-70 credits, then the balance corrects down to the real (correct)
charge a moment later.

Scope note: `ksk_...` is the Cloudflare Worker gateway's own account-credential
prefix (`cloudflare/worker.gateway.js`), not the Go binary's API-key format
(Go generates `sk-...`, see `config/apikeys.go:237-241`). This audit is
entirely about `cloudflare/worker.gateway.js` — a second, independently
deployed gateway living in this repo alongside the Go server, routed at
`kiro-go.hermesgate.app` / `kiro.hermesgate.app` per
`cloudflare/wrangler.kiro.jsonc`. The Go server's own credit-hold code
(`proxy/credit_holds.go`) is architecturally sound (hold-then-settle,
TTL-reclaimed, single mutex) and is not implicated here.

## System under audit

`ApiKeyQuota` Durable Object in `worker.gateway.js` (~line 903+) backs every
API key's live balance. Three endpoints touch the same stored `used` value on
every completed request, in this order:

1. `/reserve` — admission hold, checked against `used + reserved + amount`.
2. `/settle` — `used = min(limit, storedUsed + charge)` (additive, capped).
3. `/usage` (called from `recordRequestStats` step 0, right after settle) —
   maintains a **separate** monotonic accumulator `stats.credits = prev.credits
   + inc.credits`, then sets `used = max(storedUsed, stats.credits, usedFloor)`.

Every one of `handleClaudeMessages` (`/v1/messages`), `handleOpenAIChat`
(`/v1/chat/completions`), and `handleDirectKiroProxy` (native Kiro CLI passthrough)
calls `settleApiKeyQuota(...)` immediately followed by `recordRequestStats(...)`
for the same finished request, feeding the *same* `credits` number into both
the additive `/settle` path and the additive-then-maxed `/usage` path.

## Root cause candidates, ranked by evidence strength

### 1. No idempotency guard on settle/usage (strongest lead)

Confirmed by search: nothing in `worker.gateway.js` computes or checks a
request-id / idempotency key before calling `settleApiKeyQuota` or
`recordRequestStats`. Both are fired from inside `ctx.waitUntil(...)` callbacks
(`streamClaudeResponse`'s `pump`, `handleDirectKiroProxy`'s `meterTask`).
Cloudflare Workers does not guarantee `waitUntil` callbacks run exactly once
under all conditions (isolate eviction/retry, duplicate invocation on
transient errors). If a settle+usage pair fires twice for one logical
request:

- `/settle`'s `used = storedUsed + charge` is **additive per call** — a
  duplicate call really does double-debit `used` (not just a display
  artifact).
- The following `/usage` call's `stats.credits` also accumulates twice, but
  its own contribution to `used` is only via `max(...)`, so it does not
  independently redouble the same charge.

If a second, correct read later comes from `meteredCreditsUsed =
sumModelUsageCredits(matched.modelUsage)` (deterministic, since-only,
accumulate-by-model — see `/check` handler, ~line 7479) or from the KV
`creditsUsed` snapshot re-synced by the periodic catalog mutation, the
dashboard's `combinedCreditsUsed()` can transiently show the inflated `used`
figure from the DO before the next poll reconciles it against the
`modelUsage`-derived floor — matching "spikes to 50-70, then drops to the
correct number."

**Fix**: pass the log entry's `id` (already generated at
`normalizedLogEntry.id`) as an idempotency key into `/settle`, and have the DO
persist a small ring of recently-settled request ids, short-circuiting a
repeat call for the same id instead of re-adding the charge.

### 2. Retry/fallback amplification (real cost, not a bug, but explains "50-70 credits" magnitude)

`callKiroResilient` (`worker.gateway.js:743`) walks up to 3 model candidates
per account (`MODEL_FALLBACK_CHAIN`, e.g. `claude-opus-5` → `claude-sonnet-5`
→ `gpt-5.6-sol`), and the outer account loop in `handleClaudeMessages` retries
across every pool account. `owedCredits` (`totalChargeFor`, ~line 7067)
correctly accumulates real upstream metering from every failed attempt before
the attempt that finally succeeds. A single logical `/v1/messages` call that
fails against 2-3 accounts before succeeding legitimately owes for all of
those attempts' metering — this is intentional (a failed-but-metered attempt
must not be free), but it means the "true cost" of a request can genuinely be
several times a single successful call's own metering. This is not itself the
spike-then-correct bug, but it is why the "correct" final number can already
look large, and it compounds candidate #1 if a retried settle also duplicates.

### 3. `KIRO_KV` / `KIROPOOL_KV` — same underlying namespace ID

`cloudflare/wrangler.kiro.jsonc:22-31` binds both:

```json
{ "binding": "KIRO_KV",     "id": "5424d2f4fef6454ca8e2c54993a7107f" },
{ "binding": "KIROPOOL_KV", "id": "5424d2f4fef6454ca8e2c54993a7107f" }
```

Identical KV namespace ID under two different binding names. The peer-overlay
logic (`getPeerKeyOverlay`, `incrementPeerOverlay`, `combinedCreditsUsed`) is
explicitly designed to add a **separate cluster's** delta on top of the local
total (`/check` and `reserveApiKeyQuota` both call
`combinedCreditsUsed(localUsed, peerOverlay)`). The `peerDelta()` guard
(`overlay.mode !== "delta"` → zero) exists specifically because an earlier
incident double-counted a lifetime peer snapshot (documented inline: "Pter
2650+2269 = 4920 against a 3000 limit"). With both `source="kirogo"` and
`source="kiropool"` resolving to the *same* KV namespace, the peer overlay
keys (`overlay:kiropool:key:<id>`) and the local catalog keys
(`config:api_keys` under the `kirogo` source) live side by side in one
namespace — not directly colliding by key name, but it removes the intended
isolation between "this cluster's ledger" and "the other Kiro-Pool worker's
independently-managed ledger" that the design comment at line 1750-1751
assumes (`"KiroPool remains a direct KV view because that namespace is managed
by another Worker"`). If this is not the intended production topology (i.e.
if a separate `kiro-pool-proxy` worker is supposed to own a distinct KV
namespace), any accidental write from this worker under `source=kiropool`
would land in the same store this worker also reads as `kirogo` — worth
confirming directly against the Cloudflare dashboard's real namespace IDs, as
`wrangler.kiro.jsonc` alone cannot prove whether this is a copy-paste
placeholder or the actual deployed config.

**This needs verification against the live Cloudflare account** (not just the
committed jsonc) before treating it as confirmed; flagging it here because it
is the most structurally suspicious finding and directly touches the peer-
overlay code path that adds numbers on top of a key's own balance.

## What was not the cause

- Go server's `creditHolds` (`proxy/credit_holds.go`): correct hold/release
  design, single mutex, TTL-bounded, no double-settlement path — not involved,
  since `ksk_` keys don't touch this code.
- `calculateCredits()` in the worker: deliberately returns `0` and always
  defers to upstream's real `meteringEvent.usage` — not an inflated local
  estimate.
- `estimateCreditReservation()` / the `/reserve` hold: capped at `1` credit
  max (`MAX_CREDIT_RESERVATION`), far too small to produce a 50-70 credit
  spike on its own.

## Fix applied

Settlement is now idempotent per logical request. A `requestId` is generated
once per client request (before the account/model retry loop, so retries share
it) and threaded into every charged exit path.

What changed in `cloudflare/worker.gateway.js`:

- `settleApiKeyQuota(..., requestId)` and `pushApiKeyLiveUsage(..., requestId)`
  forward the id to the DO.
- The DO keeps a bounded ring of settled ids (`SETTLED_ID_LIMIT = 2000`, same
  pattern as the existing `accountUsage.seen` array). `/settle` and `/usage`
  each dedupe under their own namespaced key (`settle:<id>` / `usage:<id>`) so
  the two legs of one request cannot shadow each other.
- A replayed `/settle` returns `{duplicate:true}` with the unchanged balance
  instead of re-adding the charge. A replayed `/usage` skips the additive half
  (so the sticky `used = max(storedUsed, stats.credits, ...)` cannot be pinned
  permanently high) but still runs the idempotent max() correction.
- `recordRequestStats` reuses the caller's request id as the log row id, so a
  replayed settlement produces the same row identity and `/check`'s
  signature-based dedup collapses the two copies into one.
- `/sync` with `clearStats` also clears `settledIds`; `/reset` already does
  `deleteAll()`. This stops a stale ring from suppressing a future legit charge.
- Callers that pass no `requestId` keep the previous additive behaviour exactly
  (backward compatible).

Verified by a throwaway harness (not committed) covering 12 scenarios:
replayed settle charges once; replayed usage counts once and keeps `used` at
the single charge; settle+usage for one request both apply without shadowing;
two distinct requests both charge; the no-requestId path stays additive; reset
clears the ring; the ring stays bounded at 2000. All passed. The existing
`cloudflare/*.test.mjs` suite (174 tests) and the Go build/vet/tests pass.

Remaining items (not fixed):

1. Confirm in the Cloudflare dashboard whether `KIRO_KV` and `KIROPOOL_KV` are
   really the same namespace in production, or whether `wrangler.kiro.jsonc`
   has a stale/copy-pasted id that doesn't match what's actually bound.
2. Consider structured logging of `{requestId, reservation, settleCharge,
   priorUsed, newUsed, statsCreditsAfter}` on every `/settle` and `/usage` call
   so a future spike can be diagnosed from request-id-correlated numbers.
3. Retry/fallback amplification (candidate #2) is intentional cost accounting,
   not a bug — no change recommended, but it is why a "correct" final charge
   can legitimately exceed one successful call's own metering.

