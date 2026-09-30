# Kiro-Go Gateway on Cloudflare Workers

This Worker exposes a high-performance Edge Gateway for Kiro-Go:

- `GET /`: Public **Key Inspector** (quota balance, token usage, live stats)
- `GET /admin`: **Kiro-Go Admin Panel** (multi-account management, API keys, fallback settings, logs)
- `GET /health`: Health check
- `GET /v1/models`: Available models catalog
- `POST /v1/chat/completions`: OpenAI-compatible endpoint (SSE streaming & JSON)
- `POST /v1/messages`: Anthropic Claude-compatible endpoint
- Kiro CLI runtime protocol: `runtime.{region}.kiro.dev`, `tokentype: API_KEY`, AWS Event Stream
- Retry/failover across multiple `ksk_` credentials on transient failures and quota limits

Production domains:
- `https://kiro-go.hermesgate.app/v1` (primary)
- `https://kiro.hermesgate.app/v1` (same worker; bind this hostname as a Worker custom domain — a proxied origin CNAME yields Cloudflare 1016 HTML on `/admin/api`, which the Account Test modal cannot parse)

## Base URL per client family

The two client families disagree on who owns the `/v1` prefix:

| Client | Base URL | Why |
| --- | --- | --- |
| OpenAI-style (`/v1/chat/completions`) | `https://kiro-go.hermesgate.app/v1` | The client appends `/chat/completions` |
| Anthropic-style (Claude Code, Anthropic SDKs) | `https://kiro-go.hermesgate.app` | The client appends `/v1/messages` itself |

Giving an Anthropic client the `/v1` form produces `/v1/v1/messages`. The gateway
now collapses a repeated prefix, so either form works, but the table is the
intended configuration. Before that, the doubled prefix returned a bare
404 `Not Found` and Claude Code reported it as a generic connection failure.

### Claude Code

```bash
export ANTHROPIC_BASE_URL="https://kiro-go.hermesgate.app"
export ANTHROPIC_AUTH_TOKEN="ksk_..."      # sends Authorization: Bearer
# or: export ANTHROPIC_API_KEY="ksk_..."   # sends x-api-key
export ANTHROPIC_MODEL="claude-opus-4.8"
export ANTHROPIC_SMALL_FAST_MODEL="claude-sonnet-5"
claude
```

Both auth headers are accepted. `ANTHROPIC_SMALL_FAST_MODEL` is worth setting:
Claude Code otherwise picks a Haiku model for background work, and while that name
resolves, pointing it at a live model avoids relying on the alias table. For
sustained or highly parallel work prefer `gpt-5.6-sol` or `claude-sonnet-5` — Kiro
rate limits the Opus tier well before the credit allowance runs out.

Admin panel: `https://kiro-go.hermesgate.app/admin` (or `/admin` on `kiro.hermesgate.app` once the Worker route is attached)
Key Inspector: `https://kiro-go.hermesgate.app/`

KV Storage: `KIRO_KV` (ID: `2b4b0825b4cf46b38ef9c77b4463f413`)
Static assets: `../web`

Deploy from this directory:
```bash
npx wrangler deploy --config wrangler.kiro.jsonc
```

Hermes Agent provider configuration:
- API/base URL: `https://kiro-go.hermesgate.app/v1`
- Transport/API mode: `chat_completions`
- API key: your client API key (`kpp_...` or `sk-...`)
- Live model discovery: enabled
