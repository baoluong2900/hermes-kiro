# Admin panel: real-time quota, channel status, 24h/7d error windows

Date: 2026-09-13
Scope: `web/` (admin SPA), `proxy/` (Go backend), `cloudflare/worker.gateway.js` (edge worker that actually serves kiro-go.hermesgate.app)

## What was asked

Three additions to the admin panel at `https://kiro-go.hermesgate.app/admin`:

1. **API-key quota must update in real time** — numbers had to stop needing an F5.
2. **A channel status view** — see per-key/per-account request health (which ping is failing).
3. **24h and 7d windows** for those numbers.

## Root cause of "số không nhảy" (numbers don't move)

Two separate facts, and the first is the one that mattered:

- **The frontend never re-fetched.** `web/app.js` polled only `/status` (the summary bar)
  every 10s. The Accounts list had *no* auto-refresh at all, and the API Keys list had an
  opt-in checkbox that defaulted **off** (`kiro_apikeys_auto !== '1'`). So the visible
  quota numbers sat frozen until a manual reload.
- The worker's `/admin/api/api-keys` GET read only the KV catalog. That KV read sits behind
  a ~60s edge cache, so even a re-fetch could serve a stale balance.

Fix: a 5s poller in `init()` that refreshes whichever tab is on screen (accounts / api-keys /
channels), independent of the opt-in checkboxes, skipping while a modal is open so a poll
cannot clobber in-progress edits. The worker's API-key list now also overlays the per-key
Durable Object (strongly consistent) and exposes `reserved`, `tokensIn`/`tokensOut`, `live`.

Note: measured directly, the worker's API list was **already** returning fresh numbers —
`getApiKeys()` reads the strongly-consistent catalog DO, not the lagging KV mirror. The
frontend never asking again was the actual cause. The DO overlay is additive (in-flight
holds, split token counters, explicit live flag), not the fix for staleness.

## Channel status

New admin tab (`data-tab="channels"`), backed by:

- **Go**: `GET /admin/api/channels` → `apiGetChannels` in `proxy/handler.go`. Aggregates the
  in-memory request-log ring buffer per `AccountID` into 1h/24h/7d windows (total, ok, err,
  error rate, average latency, error-code histogram) plus a `last` ping record.
- **Worker**: per-account hourly-bucket health ledger in the `ApiKeyQuota` Durable Object
  (`/account-health`), written from `recordRequestStats` for every attributed request, and
  surfaced via `GET /admin/api/channels`.

The Durable Object exists because the KV log is capped at 500 entries — on a busy gateway
that is well under a day, far too short to answer a 7-day question. Hourly counters are tiny,
so 7 days of them are kept and pruned on write.

Honesty guard: the Go side aggregates the same 500-entry ring buffer, so when that buffer
covers less than 24h the response sets `sampleWindowLimited: true` and the UI shows a warning
rather than presenting a short sample as a true 7-day rate.

## Bug found and fixed while building this

When **every** account fails, the terminal error was logged with an **empty** `accountId`
at 6 sites (4 in `proxy/handler.go`, 2 in `proxy/responses_handler.go`), so the channel that
failed could never be identified — precisely the case channel status exists to surface.

Fix: track `lastAccountID` through each retry loop and pass it to the terminal
`recordFailureWithDetails`. Pre-existing in `HEAD`, not introduced by this work.

## Verification (all against the real code, not descriptions)

| Suite | Result |
| --- | --- |
| Go build + `go vet` + `go test ./...` | PASS, all packages ok |
| Cloudflare worker suites (repo's own, 11 files) | **174 pass / 0 fail** |
| Feature checks, worker (`/tmp/verify_channels.mjs`) | **32/32 GREEN** |
| Feature checks, API-key live overlay (`/tmp/verify_apikeys_live.mjs`) | **12/12 GREEN** |
| UI integration, real DOM + live server (`/tmp/uitest/ui_channels.mjs`) | **33/33 GREEN** |
| Real-time poller, live DOM (`/tmp/uitest/ui_realtime.mjs`) | **6/6 GREEN** (+3 accounts, +2 keys, +2 channels polls in 12s idle) |
| Attribution fix, structural + negative control | **14/14 GREEN** |

Negative controls (each reverts the fix in a scratch copy and must go red):

- worker health ledger + `/channels` route → 5/5 red pre-fix
- API-key live overlay → 3/3 red pre-fix
- Go attribution → 6 empty-accountId logs restored, still compiles

The live-DOM run proves the anti-F5 behaviour directly: with no user action the page issued
+3 `/accounts`, +2 `/api-keys`, +2 `/channels` requests in 12 idle seconds.

## Concurrency note

`cloudflare/worker.gateway.js` was being rewritten ~1KB/s by parallel sessions during this
work; it is untracked by git. One mid-session read caught it in a transient syntactically
broken state (a literal `***` where an expression belonged), which made all 11 worker suites
fail with `SyntaxError`. That was resolved by the sibling session; all suites are green
against the current file. My changes to it survived their rewrites intact (verified by marker
count after the churn).

## Not done

Deployment. `cloudflare/` is entirely untracked and production's last deploy
(2026-09-05) predates the current working tree, which also holds other sessions' in-flight
work. A `wrangler deploy` from here would ship all of it, so this needs an explicit decision.
