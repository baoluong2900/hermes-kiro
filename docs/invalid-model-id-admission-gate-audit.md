# `INVALID_MODEL_ID` 429s on `kr/claude-opus-*(low)` — audit and fix

Date: 2026-10-23 · Scope: `https://kiro-go.hermesgate.app` (Cloudflare Worker
`cloudflare/worker.gateway.js`, deployment `5ae35f5f`, live 10-22 17:35 +07)

## Symptom

22 of 171 logged requests failed with HTTP 429 and the detail
`Kiro throttled this model (upstream reported INVALID_MODEL_ID)`. Every failing
row was `kr/claude-opus-4.6(low)` / `kr/claude-opus-4.8(low)` /
`kr/claude-opus-5.5(low)`, from one API key ("Cha tin"), attributed to
`muhammad.hidayat030 +1` (i.e. both enabled accounts were tried). Durations
21.9–30.0 s. Successful rows in the same window used the same model ids on
`muhammad.hernando`.

## Step 1 — the key and the model catalog are healthy (live probes)

Probed production with the affected key:

| probe | result |
|---|---|
| `GET /v1/models` | 200, all 25 ids incl. `claude-opus-4.6/4.8/5.5` |
| haiku-4.5 / sonnet-4.5 / opus-4.6 / opus-4.8 / opus-5.5, 10-token prompt | 200 × 5 |
| opus-4.6, 10 671-token prompt | 200 |
| opus-4.8, 10 671-token prompt | 200 |
| opus-4.6 + `reasoning_effort: "low"`, 10 671 tokens | 200 |
| agent shape (system + 2 tools + 3 tool-call turns + stream), 40 000 tokens | 200 |
| 8 × concurrent `kr/claude-opus-4.6(low)` | 200 × 8 (3.8–25.7 s) |

So the model ids are live, the `kr/` prefix and `(low)` suffix resolve correctly,
effort fields are accepted, and large/streaming/tool-bearing payloads pass. The
model catalog is **not** the problem — the same conclusion the
`account-routing-sequential-audit.md` reached for the earlier 17:15–17:27 burst.

## Step 2 — the 22 failures were a real upstream per-credential throttle

Evidence, in order of strength:

1. **Duration signature.** 4 upstream attempts per account
   (`MODEL_REJECTION_BACKOFF_MS` = 700/2000/4500 ms jittered, ≈3.6–7.2 s of sleep
   plus a fast rejection per attempt) × 2 enabled accounts ≈ 11–18 s, matching the
   observed 21.9–30.0 s. A request that never reached upstream is either ~0.1 s
   (cooldown skip) or exactly 2 × 30 s = 60 s (gate denial). None of the 22 rows
   match those, so upstream *was* called and *did* reject.
2. **Model selectivity.** Only Opus (premium) failed; Sonnet/Haiku never did in
   that window. A dead model id would fail for every model.
3. **Symmetry.** Both enabled accounts (`acc-1` hernando 869.58/1000,
   `acc-2` hidayat 821.64/1000) rejected identically. `attemptedAccountIds`
   confirms the pool was walked, not that one bad account was pinned.
4. **Self-clearing.** The last failure was 23:48:41; the same key, same model and
   same account returned 200 at 01:03. Nothing was changed in between — no
   deploy, no account edit. A retired id does not come back.
5. **Only Opus with `(low)` effort and 12 k–93 k input tokens** — the highest
   token-volume traffic on the gateway, on the model class Kiro meters highest.

Conclusion: Kiro enforces a per-credential premium-model request/token budget and
reports it as `400 ValidationException / INVALID_MODEL_ID`. It is a rate limit,
not a catalog or mapping defect.

## Step 3 — the gateway bug it exposed (reproduced, then fixed)

The same 429 body was **also** produced for requests upstream never saw.
`callKiroResilient` fabricated the upstream signal:

```js
if (!permit || !permit.ok) {
  lastThrottle = { status: 400, text: JSON.stringify({ reason: "INVALID_MODEL_ID" }) };
  continue;
}
```

The comment directly above it even says *"Local admission pressure is not an
upstream INVALID_MODEL_ID signal"* — and then it stores exactly that signal.
With `MODEL_FALLBACK_CHAIN` empty there is one candidate, so the loop ends and
the client is told *"Kiro throttled this model (upstream reported
INVALID_MODEL_ID)"*. The cooldown-skip branch (`isCooledDown → continue`) and
the `lastThrottle === null` fallback produce the identical message.

**Reproduced live** — 30 concurrent `kr/claude-opus-4.6(low)` requests against
production:

```
concurrent=30 wall=63.3s
status codes: {200: 22, 429: 8}
  #0  HTTP 200   18.8s        #8  HTTP 429  62.6s  Retry-After=3
  #25 HTTP 200   21.2s        #28 HTTP 429  62.6s  Retry-After=3
  ...                          #6  HTTP 429  62.6s  Retry-After=3
```

8 requests failed after **exactly 62.6 s = 2 × 30 s admission deadline** — one
per enabled account, with **zero upstream calls**. The premium gate allows
`maxInFlight: 1` with `spacingMs: 1200` per credential, so any client firing more
than ~25 concurrent Opus requests exhausts the 30 s budget. An agent UI with
parallel chats or sub-agents hits this routinely.

This path had **no test coverage at all** (`grep "ok: false" *.test.mjs` → 0 hits
on `acquire`), which is how it survived. The cost is not the 429 itself — it is
that the log row is byte-identical to a genuine Kiro throttle, so the operator
debugs a phantom upstream rate limit and the client backs off a healthy model.

### Fix (`cloudflare/worker.gateway.js`)

* `callKiroResilient` now records **which** cause ended the loop —
  `lastThrottle` (real upstream), `lastAdmission` (this gateway's gate refused),
  `lastCooldown` (a real throttle is being deferred) — and returns
  `failure: { status, message, headers, kind }` instead of re-deriving a cause
  from the response body later.
* New `modelExhaustionFailure(cause)` keeps 429 in every case (the client's
  correct action is the same) but labels the cause:
  * `upstream_throttle` → unchanged wording, `Retry-After: 3`
  * `local_admission` → *"Gateway admission limit reached for … (local
    concurrency gate, not an upstream Kiro throttle — upstream was not called).
    Lower concurrency or retry in a few seconds."* `Retry-After: 2`
  * `local_cooldown` → *"Kiro throttled … moments ago; the gateway is holding
    that model for a short cooldown and did not call upstream again."*
* Both dispatch loops (`/v1/chat/completions`, `/v1/messages`) prefer
  `routing.failure` over `normalizeUpstreamFailure(400, errText)`. This also
  removes a latent regression: the old re-derivation matched the body text
  against `TRANSIENT_MODEL_REJECTION`, so a 429 whose body no longer contains
  `INVALID_MODEL_ID` would have been **downgraded to a 400**.
* `finishFailedRequest` writes `failureKind` into the log record.
* Dashboard (`web/app.js`, `web/styles.css`, `web/locales/*.json`): the Detail
  badge now renders the cause — red "Kiro throttle" vs blue "Gateway queue" vs
  amber "Cooldown", each with an explanatory tooltip. Legacy `errorType` rows are
  unchanged.

### Verification

* `node --test cloudflare/*.test.mjs` → **174 pass / 0 fail**.
* `node --check` + `wrangler deploy --dry-run` → clean bundle, 23 assets.
* Harness on the real worker source (`~/.hermes/cache/scratch/verify_fix.mjs`,
  not added to the repo): gate denial → `local_admission` with the honest message
  and **no** upstream call and **no** cooldown write; cooldown skip →
  `local_cooldown`; a genuine `INVALID_MODEL_ID` body still yields
  `upstream_throttle` with the original wording and `Retry-After: 3`; and the
  **real** premium gate (`acquireModelPermit` + real `ApiKeyQuota` DO) denies a
  second concurrent premium acquire, dispatching as `local_admission`.
* UI harness (`verify_ui.mjs`) runs the shipped `logFailureBadge` against all six
  row shapes and asserts class, label and tooltip.

## Not fixed — needs an operator decision

1. **Retry amplification.** One client request costs 4 upstream attempts per
   account × N enabled accounts — 8 full-payload upstream calls for this pool.
   Each re-send consumes the same per-credential budget the ramp is waiting on,
   so a throttle deepens itself and a 40 k-token retry storm is expensive. The
   ramp was deliberately sized in an earlier session; shrinking it is a
   cost/latency tradeoff, not a correctness fix.
2. **30 s admission deadline per account.** Worst case a client waits 60 s
   (2 accounts) and then gets a 429. Sharing one deadline across the pool walk
   would bound it at 30 s.
3. **Pool headroom.** Both enabled accounts sit at 82–87 % of a 1000-credit limit
   with `allowOverUsage: false`, so there is no third credential to fail over to.
   The two `idc` accounts (Rhys, jordan.lim) are disabled.

## Not deployed

The fix is committed to the working tree only. `git diff` shows
`cloudflare/worker.gateway.js`, `web/app.js`, `web/styles.css`,
`web/locales/{en,vi,zh}.json`. Production still runs `5ae35f5f`, which contains
the fabricated-throttle defect.
