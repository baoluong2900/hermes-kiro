# Why the Kiro pool burns credits: no cache on agent tool turns (2026-10-27)

Follow-up to `credit-overcharge-investigation-2026-10-22.md` and
`credit-charge-42cr-cache-miss-audit.md`. Question: does Kiro-Go cache prompts at all,
and why does the pool cost more than 9router did?

> **Runtime note:** since the 2026-10-27 cutover, `kiro-go.hermesgate.app` is the **Go server**
> on Render (`kiro-go-n4p9.onrender.com`, `/health` version 1.1.5). It is no longer the
> Cloudflare Worker. The historical log analysis (10-21 → 10-27 15:54) is Worker-era data from
> the now-frozen KV. The "Production" probes below went to the Render Go server. The Worker
> builder was used only offline and for the direct-upstream payload A/B.

## Short answer

- **The gateway stores no prompt cache, and it can't.** The only cache that reduces
  credits is Kiro's (AWS) server-side prefix cache. The gateway's job is to send a
  byte-stable, append-only prefix to the same account. The Worker payload builder does this (verified
  below). The Render Go server measured the same −47% on text turns. The Go server's `promptCacheTracker`
  (`proxy/cache_tracker.go`) only *simulates* `cache_read_input_tokens` for Claude
  clients. It saves nothing.
- **Kiro only discounts text turns.** When the current message carries `toolResults`
  (every step of an agent loop), Kiro bills the full context again. This happens with
  random or fixed `conversationId` and with both the Kiro-Go and 9router payload shapes.
  Agent sessions therefore cost roughly the full context size on every step.
- The big historical spend (10-21: 1,638 Cr in one day) was one
  `opus-5.5-thinking-agentic` session at 225k–277k tokens: about 45–52 Cr per step at
  the >200k rate (~0.19 Cr/1k vs ~0.10 below 200k). The rate stayed flat no matter the
  gap or account. Since 10-23, the logs show almost no successful heavy traffic
  (10-23: 3.3 Cr; 10-27: 1.5 Cr).

## Measurements (all live, metered `meteringEvent` credits)

Production (Render Go server), OpenAI route, `claude-sonnet-4.6`, master key:

| Probe | fresh | exact repeat | +1 turn | +2 turns |
|---|---:|---:|---:|---:|
| ~80k text conversation | 0.328 | 0.173 | 0.173 | 0.173 |
| ~228k text conversation | 0.936 | 0.493 | 0.493 | — |
| ~79k → 97k tool loop (each step = tool result) | 0.344 | — | 0.378 | 0.410 |

Text turns get about 47% off. Tool turns grow linearly with context, so they get no
discount.

Direct to Kiro upstream (Worker `callKiro`, one local-pool account, ~30k context):

| Variant | T0 | T1 | Hit? |
|---|---:|---:|---|
| Worker payload, T0 exact repeat | 0.210 | 0.133 | yes (repeat) |
| Worker payload, +1 tool pair | 0.210 | 0.211 | **no** |
| `content: "Tool results provided."` (9router placeholder) | 0.225 | 0.244 | no |
| `origin: AI_EDITOR` (9router origin) | 0.222 | 0.232 | no |
| 9router `openaiToKiroRequest` + `x-session-id` | 0.208 | 0.213 | no |
| T0 tool-current → T1 **text** current (X) | 0.201 | 0.115 | **yes** |
| T0 text-current → T1 **tool** current (Y) | 0.187 | 0.199 | **no** |

Real agent loop: the model's own `toolUses` are replayed, plus a new tool result each
step (~30k context).

| conversationId | step0 | step1 | step2 | step3 |
|---|---:|---:|---:|---:|
| random per request (old Worker) | 0.200 | 0.182 | 0.189 | 0.196 |
| fixed for the loop (9router w/ session) | 0.198 | 0.182 | 0.189 | 0.197 |

The payload builder was also checked offline. Turn N's `history` is a strict prefix of
turn N+1's `history`, and the old current tool result becomes the new history entry
unchanged (`buildOpenAIKiroPayload`). The Worker is prefix-stable. The miss is upstream
behaviour, and no field the gateway controls changed it.

## What this means

- Agent workloads (OpenCode/Claude Code/Hermes tool loops) pay about
  `context_size × rate` per step on any gateway. A session's total cost grows with steps
  × context. Above 200k input, the Opus 5.5 rate doubles.
- The levers are context size and model choice, not caching:
  1. Keep sessions under 200k. The Go server advertises `context_window: 1_000_000` for
     Claude ≥4.6 (upstream `tokenLimits` / `largeContextWindow`; the old Worker forced 1M
     via `FORCED_CONTEXT_WINDOW`; 9router advertises 1M too), so auto-compacting clients never compact before the 2× tier.
     Option (needs operator OK): advertise 200k for Claude, or reject
     estimated input > ~195k with `context_length_exceeded` so clients compact.
  2. Use cheaper models for long tool loops. From the 10-22 table: opus-4.6 is
     ~0.39× opus-5.5 per token, and sonnet-4.x is cheaper still.
- Defects already fixed and deployed on 10-22 that did inflate cost: opus-4.6 folded to
  4.7, silent `gpt-5.6-sol` fallback, account ping-pong, and the history rewrite. None of
  these can be measured in post-fix traffic yet, because there has been no heavy
  successful traffic since.

## Why some gateways "show cache" and others do not

Raw Kiro event stream (fresh vs exact repeat, repeat billed −47%) contains only
`assistantResponseEvent` + `meteringEvent {unit, usage}`. There is **no** `metricsEvent`,
`cacheReadInputTokens` or `contextUsageEvent`, so no gateway can read a real Kiro cache count.

- Original Kiro-Go (Go, since `c5e6d42`): `promptCacheTracker` computes
  `cache_read/creation_input_tokens` locally from the client's `cache_control` markers.
  These are simulated numbers. Credits are unaffected.
- 9router: reads `metricsEvent.cacheReadInputTokens` if Kiro ever sends it. A local
  9router instance (isolated `DATA_DIR`, the exported Rhys account imported via
  `/api/oauth/kiro/import`) ran the same 4-step tool loop (46k→57k tokens, `x-session-id`)
  and logged `cached_tokens: 0` on every row. Its `cost` column is its own USD price
  table, not Kiro credits.
- Render Go server (current prod): same `promptCacheTracker`. `/v1/messages` (Anthropic)
  shows simulated cache counters, while `/v1/chat/completions` (OpenAI, used by the
  `kr/...` clients) reports none. The old Worker reported none on either route.
- Real caching is the same for all of them: text turns about −47%, tool turns about 0%.

## Not established

- Kiro's internal cache placement (why a tool-result current misses while a text
  current hits). Only black-box behaviour was measured, on `claude-sonnet-4.6`. Opus may
  differ.
- Whether 9router was actually cheaper for the same workload. Its usage DB is
  corrupted (`database disk image is malformed`) and holds no Kiro connections now. Its
  payload shape misses the cache the same way.

Probe cost: about 10 Cr in total (production master key + one local-pool account).
Scripts are in `~/.hermes/cache/scratch/kcache2/` (`cache_probe.py`, `tool_probe.py`,
`raw_ab.mjs`, `nr_ab.mjs`, `loop_ab.mjs`). Credentials were read in memory only.
