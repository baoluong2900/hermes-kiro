# Why single requests cost 40–105 credits (2026-10-22)

Scope: `kiro-go.hermesgate.app` (Cloudflare Worker `cloudflare/worker.gateway.js`).
Data: the 148 rows in KV `config:logs` (10-21 00:15 → 10-22 17:29), plus live probes
run today. Companion to `credit-charge-42cr-cache-miss-audit.md` (another session).

## Verdict

The **current** gateway does not inflate credits. Every check below passed. The
expensive rows are upstream Kiro metering for very large Opus 5.5 contexts, and the
largest single cost driver is crossing **200k input tokens**, where the per-token
price doubles.

## What was verified (current code)

| Seam | Method | Result |
|---|---|---|
| Metering events per response | Direct upstream calls (`metering-probe.mjs`): Sonnet 4.5 with ~1k output tokens, Opus 4.6 with and without `(low)` adaptive thinking | Exactly **1** `meteringEvent` each, so the gateway's `credits += usage` sum cannot double-count |
| Charge = upstream metering | Source: `calculateCredits()` returns 0; settle uses metered credits plus `owedCredits` from failed attempts only | 1:1 pass-through, no multiplier |
| Payload inflation | Real `buildOpenAIKiroPayload` on a 15-step tool conversation (`inflation.mjs`) | Payload is 1.004–1.010× the request size; all 15 tool pairs stay structured; no narration duplication |
| Prompt-cache reuse through the gateway | Six live requests via production per model (`cache-ab.mjs`), ~12.9k-token prompt | Opus 4.6 `(low)`: fresh 0.128, repeat 0.069, +1 turn 0.069, +2 turns 0.068, tool turn 0.132, tool +1 turn 0.071. Sonnet 4.5 shows the same pattern. Incremental turns get the cache discount (~45–50 %) |
| Silent model substitution | Source | `MODEL_FALLBACK_CHAIN` is empty, so only the requested model is ever called |

Probe cost: about 1.2 credits in total.

## Where key-11's 1,698.6 credits went (102 successful rows in the log window)

| | rows | credits |
|---|---:|---:|
| opus-5.5 (`kr/claude-opus-5.5*`) | 44 | 1,450.0 |
| opus-4.x | 58 | 248.6 |
| **rows with > 200k input tokens** | **25** | **1,164.9 (69 %)** |

Per-token price of opus-5.5 by context size (upstream metered credits ÷ estimated input):

| input tokens | n | median credits / 1k tokens |
|---|---:|---:|
| 50–100k | 9 | 0.105 |
| 100–160k | 10 | 0.098 |
| **200–300k** | **25** | **0.193** |

No rows fall between 160k and 200k, and the rate is clearly bimodal. Above 200k
the same model costs ~2× per token (the long-context tier). Billed at the <200k rate,
those 25 rows would have cost ~602 cr instead of 1,165. The 43–52 cr rows are all
in this group (225k–277k tokens).

Other contributors:

* Output and hidden thinking tokens are expensive. ~1k output tokens on Sonnet 4.5
  metered 0.225 cr, about 3× the cost of a 12.9k-token prompt. key-11 rows take
  40–135 s, which points to substantial hidden reasoning that the logged
  `outputTokens` estimate does not include.
* The cache discount needs the same account and a short gap between requests. In
  the log, 20 of key-11's 102 requests switched account: the remaining-quota
  ping-pong in "sequential" mode, fixed and deployed today (version 5ae35f5f). The
  big opus-5.5 calls are usually 5–10 min apart, interleaved with opus-4.6 calls,
  so the cache has often expired anyway.

## The 105-credit row (10-21 23:08) is an outlier and remains unexplained

`kr/claude-opus-5.5-thinking-agentic(low)`, ~141,865 input / 424 output tokens,
68 s, 105.05 cr. That is **0.741 cr/1k**, 7.6× the median for that size (similar
rows cost ~13.7 cr).

It ran on the deployment from 10-21 00:04, which still had the silent fallback
chain `opus-5.5 → opus-5 → sonnet-5 → gpt-5.6-sol` and logged neither `actualModel`
nor `retryCredits`. The most likely explanation is several metered attempts or a
substituted model inside one request. The log cannot prove it either way. Both
mechanisms are gone in the current code, and both fields are now logged, so a
repeat would be diagnosable.

## Recommended gateway guard (not implemented — needs an operator decision)

Reject requests whose estimated input exceeds a configurable limit (e.g.
`maxInputTokens: 195000`, per key or global, default off). Return an OpenAI
`context_length_exceeded` / Anthropic `prompt is too long` error. Agent clients
(Claude Code, OpenCode, Cline) react by compacting the conversation. This would have
blocked every request in the 2× tier above. The cost is that clients without
auto-compaction get a hard error instead of an expensive answer.

## Artifacts

`~/.hermes/cache/scratch/credit/`: `logs.json` (sanitized log snapshot),
`metering-probe.mjs`, `cache-ab.mjs`, `inflation.mjs`. No credentials are written
to disk; keys and tokens are read from KV in memory only.
