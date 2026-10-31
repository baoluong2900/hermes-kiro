# AGENTS.md — Kiro-Go (Hermes-Kiro)

Kiro-Go turns Kiro accounts into an OpenAI (`/v1/chat/completions`, `/v1/responses`) and Anthropic (`/v1/messages`) compatible API, with a multi-account pool, OAuth/SSO/API-key auth, credit/quota accounting, and a web admin panel at `/admin`. There are two runtimes in this repo: the **Go server** (root) and a **Cloudflare Worker edge gateway** (`cloudflare/worker.gateway.js`) that reimplements the gateway in JS and serves the same `web/` assets.

## Layout
- `main.go` — entrypoint; loads config, inits logger, pool, `proxy.NewHandler()`.
- `proxy/` — HTTP handlers, Kiro upstream client (`kiro.go`, `kiro_api.go`), OpenAI/Claude translation (`translator.go`), Responses API (`responses_*.go`), failover/circuit/throttle, credit holds, web search. `handler.go` is ~6.5k lines and owns routing + admin API.
- `auth/` — Builder ID, IAM Identity Center, Microsoft SSO, GitHub social login, OIDC, SSO tokens.
- `config/` — JSON config (`config.go`), API keys, outbound proxy routing. `pool/` — account pool. `logger/` — leveled logger.
- `web/` — admin SPA (vanilla JS `app.js`, `index.html`, `styles.css`, vendored Tailwind/FontAwesome) with i18n in `web/locales/{en,vi,zh}.json`.
- `cloudflare/` — Worker (`worker.gateway.js`, ~10k lines), `wrangler.kiro.jsonc`, `*.test.mjs` suites, `mutation_test.py`.
- `docs/` — audit/investigation write-ups (`*-audit.md`); add new findings here.

## Dev environment
- Go module `kiro-go` (go.mod says 1.21; Docker builds with golang:1.23). Only external dep: `github.com/google/uuid`. Node ≥ 22 for worker tests (no package.json; uses `node:test`).
- Run from the repo root — static files are served via relative paths (`http.ServeFile(w, r, "web/...")`).
- Env vars: `CONFIG_PATH` (default `data/config.json`), `ADMIN_PASSWORD` (overrides config; default password is `changeme`), `LOG_LEVEL` (overrides config log level).
- Local dev config on port 8008: `CONFIG_PATH=data/config.dev-8008.json ./kiro-go`. Default config listens on `0.0.0.0:8080`.

## Build & test
- Build: `go build -o kiro-go .`
- Vet: `go vet ./...`
- Go tests: `go test ./...` (or one package: `go test ./proxy/ -run TestName`)
- Worker tests (one file per run): `node --test cloudflare/quota.test.mjs`; all: `for f in cloudflare/*.test.mjs; do node --test "$f"; done`
- Mutation checks (revert each fix, expect red): `python3 proxy/mutation_test.py`, `python3 cloudflare/mutation_test.py`
- Docker: `docker-compose up -d` (maps `./data` → `/app/data`, port 8080). CI (`.github/workflows/docker.yml`) only builds/pushes the multi-arch image — it does not run tests, so run them locally.
- Worker deploy (only when asked; needs Cloudflare auth): `cd cloudflare && npx wrangler deploy --config wrangler.kiro.jsonc`

## Conventions
- Commits: Conventional Commits with scope — `feat(worker): …`, `fix(auth): …`, `fix(routing): …`, `fix(admin-ui): …`.
- Go tests live beside source as `<file>_test.go`, one file per behaviour/regression (e.g. `translator_truncate_test.go`, `upstream_error_test.go`). Test-only seams are exported `…ForTest` setters in `auth/testhooks.go` that return the previous value for restore.
- Worker tests import a temp copy of `worker.gateway.js` with an appended `export const __internals = {…}`; if a test needs a new internal function, add it to that list in the test file — the worker itself only exports the default handler and the `ApiKeyQuota` Durable Object.
- Each regression test states the symptom it guards against in a comment header; keep that style.
- Go and Worker implement parallel features (model throttle, upstream error mapping, token refresh, context window, quota). When fixing gateway behaviour, check whether the other runtime needs the same fix.
- Older code has Chinese comments; new comments are English.
- UI strings go through i18n (`t('key')` in `app.js`, `data-i18n` in HTML). Add every new key to all three locale files — they are kept at identical key sets.
- Config changes made in the admin panel persist via `config.Save()` to the active config file (mode 0600).

## Pitfalls
- `data/` is gitignored and holds live account tokens, API keys and proxy credentials (`data/config.json`, `data/config.dev-8008.json`). Never print, commit, or paste its contents; don't hand-edit it while the server is running (it is rewritten on save).
- Root binaries (`kiro-go`, `kiro-go-src`, `kiro-go-run`, `kiro-go.bak-*`) and `logs/` are local artifacts, gitignored — don't commit or rely on them being current; rebuild instead.
- Root `test_*.py`, `add_*.py`, `start_*.sh`, `*.patch` are gitignored scratch files that may contain real keys — not part of the project.
- `cloudflare/wrangler.kiro.jsonc` is the source of truth for KV/Durable Object bindings; the KV ID in `cloudflare/README.md` is stale.
- `SSE` streams rely on `WriteTimeout: 0` in `main.go`; don't add a write timeout.
- Auth tests: the global auth HTTP client caches proxy env on first use — use `auth.SetGlobalAuthClientForTest` with `Proxy: nil` when testing against `httptest` servers.
- Anthropic clients must use the base URL without `/v1`; OpenAI clients use `…/v1` (see `cloudflare/README.md`).
