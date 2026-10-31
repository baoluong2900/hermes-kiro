# Kiro-Go: silent 503 "No available accounts" with quota remaining (2026-10-31)

## Symptom

`/v1/models` returned 200 for a valid API key, but every `/v1/chat/completions`
(`auto`, Sonnet) returned HTTP 503 `{"error":{"message":"No available accounts","type":"server_error"}}`
in ~0.3s. The admin dashboard showed accounts with quota left and no error logs.

## Root cause

- Pool had 10 accounts, **1 enabled** (PRO, 1771/5000 used). `/admin/api/status` showed
  `accounts: 10, available: 0` — the only enabled account was in an **in-memory pool
  cooldown** (`pool.cooldowns`), so `GetNextForModelExcluding` returned nil on the first
  attempt and the handler hit the `lastErr == nil` branch.
- That branch sent the 503 **without** calling `recordFailureWithDuration`, so the request
  log (last 500 entries) was 100% `success` and the account's persisted `errorCount` stayed 0.
  Nothing in the UI explained the outage.
- With `sequential` routing and a single enabled account, any upstream throttle/429 applies
  `defaultQuotaCooldown` (1h) and the whole gateway 503s until it expires.

Which upstream error triggered the cooldown was not recoverable from the admin API (only the
Render container stdout `[AccountFailover]` lines would show it).

## Live remediation

`POST /admin/api/accounts/<id>/test` on the enabled account → upstream replied `ok` →
`pool.RecordSuccess` cleared the cooldown → `available: 1`; both `auto` and
`claude-sonnet-5.5` returned HTTP 200 `PONG`. No accounts were enabled/disabled, no keys touched.

## Source changes (deployed)

- `proxy/account_failover.go`: `errNoAvailableAccounts` sentinel.
- `proxy/handler.go`, `proxy/responses_handler.go`: all six `lastErr == nil` 503 sites now
  call `recordFailureWithDuration(..., "", errNoAvailableAccounts, ...)` so the outage appears
  in request logs / channel health (Claude sites log only when the CLI-proxy fallback did not
  take over). `classifyError` maps it to `errorType: "pool"` rather than `quota`.
- `pool/account.go`: `CooldownUntil(id)`; `apiGetAccounts` exposes `cooldownUntil` (unix, 0 if none).
- `web/app.js`: enabled account in cooldown shows a "Cooling down Nm" badge instead of "Active";
  key `accounts.coolingDown` added to en/vi/zh.

Verified locally with a zero-account fixture on :8097: `/v1/chat/completions`, `/v1/messages`,
`/v1/responses` all 503 and each now writes an `error … pool` log entry.

## Deploy

- Image `ghcr.io/baoluong1120/kiro-go-render:poolcooldown-202610312325`
  (`sha256:0e7d845b2f096f35cb0490ae6973ab2227d6245f86d7547a13ca0613e7a32a64`), built from the
  repo `Dockerfile` (includes pinned cloudflared + entrypoint; tunnel unchanged).
- Render deploy `dep-dbj1d6oae00c73cv26qg` → `live` at 16:26:34Z. `/health` 200, `auto` and
  Sonnet `PONG` on `kiro-go.hermesgate.app`, admin API returns `cooldownUntil`.
- Rollback: redeploy `ghcr.io/baoluong1120/kiro-go-render:tunnel-202610311856` (keeps tunnel).

## Remainder / risk

- Single enabled account = single point of failure. Three disabled accounts have headroom
  (POWER 2730/10000, PRO 80/5000, PRO 1282/5000); enabling at least one removes the 1h
  cluster-wide outage mode. Not done here — they were deliberately disabled.
- The UI badge only refreshes on account list reload; it does not count down live.
- Image was built from the current working tree (includes other uncommitted Go/UI edits that
  were already in the previous `pool30`/`tunnel` images). No commit/push performed.
