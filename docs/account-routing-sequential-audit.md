# Account routing: "round-robin off" still spreads requests

Date: 2026-10-22 · Scope: Cloudflare edge gateway (`cloudflare/worker.gateway.js`, `kiro-go.hermesgate.app`)

## Symptom

Round-robin is off. The request log still shows the same API key landing on
`Rhys.Montgomery001@…` for the successful requests and on `muhammad.hernando@…`
for the failures (`Kiro throttled this model (upstream reported INVALID_MODEL_ID)`, 26–32 s each).

## Live state (read from KV `config:settings` / `config:accounts`)

| | value |
|---|---|
| `accountRoutingMode` / `strategy` | `sequential` / `sequential` |
| pool[0] muhammad.hernando | enabled, 868.37 / 1000 used → 131.6 remaining |
| pool[1] muhammad.hidayat030 | enabled, 821.58 / 1000 → 178.4 remaining |
| pool[2] jordan.lim001 | **disabled** |
| pool[3] Rhys.Montgomery001 | enabled, 675 / 1000 → **325 remaining** |

## Root causes

### 1. The worker's "sequential" is a remaining-quota sort, not sequential

`pickCandidates` (`worker.gateway.js` ~7210) has explicit branches only for
`round_robin` and `smart`. `sequential` falls through to:

```js
// Sort by smart quota strategy (highest remaining quota first)
return enabled.sort((a, b) => remB - remA);
```

The UI promises "Sends all requests to one account until its quota is exhausted
or encounters error/cooldown, then moves to the next", and the Go server
(`pool/account.go` `GetNextForModelExcluding`) implements exactly that via pool order.
The worker does not:

* Today Rhys is first only because it has the most quota left.
* As soon as two accounts' remaining quota is close, every request flips the
  leader — this is load-balancing, i.e. effectively round-robin.

Replay of the live snapshot (scratch probe, 60 requests at 2.5 cr each, hidayat
near-tied with Rhys):

| ordering | primary switches / 60 req | split |
|---|---|---|
| current "sequential" | **59** | hidayat 30 / Rhys 30 |
| proposed (pool order) | 1 (only when hernando ran out of quota) | hernando 53 / hidayat 7 |

### 2. Failed rows are attributed to the *last* account tried, not the only one

On pool exhaustion the log records `lastAccount` (`worker.gateway.js` ~5774 for
`/v1/chat/completions`, ~6405 for `/v1/messages`). The current candidate order is
`Rhys → hidayat → hernando`, so a request that failed on **all three** accounts is
logged as `muhammad.hernando`. That is why the failures look like they were routed to
a different account.

The duration confirms the full walk: per account `fetchWithModelRetry` runs 4
upstream calls with ~7.2 s of jittered backoff (700 + 2000 + 4500 ms) ≈ 9–10 s;
× 3 enabled accounts ≈ 27–30 s, matching the observed 26.4–32.5 s. The successful
requests on Rhys took ~2.5 s.

### 3. The throttle is real (not a bad model id)

The same `claude-opus-4.6` / `kr/claude-opus-4.6(low)` / `claude-sonnet-4.5` ids that
failed on all three accounts at 17:15–17:27 succeeded on Rhys at 17:26:51, 17:29:00,
17:29:04 and 17:29:51 (~2.5–3.7 s). That makes it a transient per-credential
INVALID_MODEL_ID throttle, as the message says, not a retired model id.

## Fix — applied and deployed 2026-10-22 17:35 (version 5ae35f5f)

1. `pickCandidates`: add an explicit `sequential` branch before the quota sort —
   pool order, quota-exhausted accounts moved to the back as failover only:

   ```js
   if (mode === "sequential") {
     const exhausted = (a) => !settings?.allowOverUsage && Number(a.usageLimit) > 0 &&
       Number(a.usageCurrent) >= Number(a.usageLimit);
     // Array.prototype.sort is stable, so ties keep pool order.
     return enabled.sort((a, b) => Number(exhausted(a)) - Number(exhausted(b)));
   }
   ```

   Model throttles still fail over to the next account per request, and
   `markModelCooldown` makes the next request skip the throttled account/model for
   30 s at zero cost — i.e. "move on after an error/cooldown", as documented.

2. Log attribution: collect the ids tried in both dispatch loops
   (`attempted.push(account.id)`), pass `attemptedAccountIds` through
   `finishFailedRequest` into the log record, and render
   `<last account> +N` with the full chain as a tooltip in `web/app.js`
   (Account column, `accountLabel(l.accountId)` ~line 940).

Note: with fix 1, pool[0] `muhammad.hernando` (131 cr left) becomes primary instead of
Rhys. Reorder the pool or disable accounts if a different primary is wanted.

3. `shouldTryNextAccount` also fails over on upstream **402** (credential out of
   credits). `usageCurrent` in KV only updates on a quota refresh, so the pinned
   primary can run dry upstream before KV notices; 402 used to fail fast and strand
   the request on the drained account. 429 / ThrottlingException / ServiceQuota were
   already failover statuses.

## Verification

* `node --test cloudflare/*.test.mjs`: 174 / 174 pass.
* Ad-hoc e2e probe (`~/.hermes/cache/scratch/routing/e2e.mjs`) drives the real
  `worker.fetch` handler with a 3-account pool using the live usage numbers and a mocked
  upstream: 7 / 7 pass. Run against the pre-fix code it fails 5 / 7. It reproduces the
  dashboard symptom: the success went to `rhys`, and the exhausted-pool failure was
  logged as `hernando`. With only the 402 change reverted, the 402 failover case fails
  (`402, 402`, stuck on hernando).
* Production: both custom domains serve the new `app.js` (`logAccountCell`) and
  `/health` returns 200.
