# Kiro-Go credit/usage audit and verified production fixes

## Scope and current result

Target: `https://kiro-go.hermesgate.app/v1`, served by
`cloudflare/worker.gateway.js`, **not** the Go server.

The reported row recorded **42.131581 Cr**, approximately **237,360 input /
99 output tokens**, status 200. Later rows had lower charges. The historical
logs do not retain the raw metering stream, exact prompts, cache counters, or
per-attempt costs. They cannot establish why this specific request was expensive.

**Correction to the initial audit:** assertions that this was definitely a cache
miss above a 200k pricing threshold, that every agent turn missed 100%, that
there were no internal retries, or that the changes would save 12–20× were not
supported. Live experiments showed cheaper repeat requests even with the old
translator. Missing cache counters mean **unknown**, not a proven cache miss.
There is no verified Kiro credit-to-token price formula or cache TTL in this audit.

The code uses upstream metering (plus previously metered failed attempts), not a
local retail multiplier: `calculateCredits()` returns zero. Correct arithmetic at
that seam does **not** establish correctness of every downstream ledger/mirror.

## Confirmed bugs fixed in the Worker

### 1. Catalog/model usage did not deduplicate logical request IDs

`/settle` and per-key `/usage` already deduplicated IDs. The catalog usage
mutation did not receive an ID and incremented `modelUsage.credits` each time.
Its model total is a floor for the charged balance. Replaying the same usage
write could therefore inflate spend even when settlement itself was idempotent.

Changes:

- Pass the same logical `requestId` into the catalog usage mutation.
- Keep a bounded ring of 2,000 `(key ID, request ID)` markers, separate from
  customer-visible keys and from settlement markers.
- Commit catalog counters and the marker together in one storage write.
- Serialize catalog operations within the Durable Object to avoid concurrent
  read/modify/write lost updates.
- Do not increment the peer usage overlay for a duplicate catalog mutation.
- Keep no-ID callers backward-compatible; their calls remain additive.

Reproduced on the actual `ApiKeyQuota` source in local **workerd/SQLite-backed
Durable Objects**, using isolated diagnostic state, not production balances:

| Operation | Old code | Fixed code |
|---|---:|---:|
| Same 0.25-Cr usage request submitted twice | 0.50 Cr / 2 requests | 0.25 Cr / 1 request |
| Then 20 distinct concurrent 0.01-Cr requests | — | 0.45 Cr / 21 requests total |

This proves the replay vulnerability and the fix. It does **not** prove that a
replay occurred in the user's historical traffic. The bounded ring is not a
permanent immutable request ledger; replays after eviction remain a limitation.
Global KV stats and health counts are diagnostic aggregates, not exactly-once
financial records.

### 2. Client input usage was constant or missing

Before the fix, a real production request had:

- OpenAI JSON: `prompt_tokens: 20`.
- Anthropic JSON: `input_tokens: 20`.
- OpenAI SSE: no usage chunk despite `stream_options.include_usage: true`.
- Anthropic SSE: initial input 0 and no final input count.
- The count-tokens route independently estimated 2,262 tokens for its context.

A client relying on response usage could substantially underestimate context
size and delay compaction. This is a confirmed reporting defect; the exact effect
on any specific client's compaction policy was not measured.

Changes:

- Use upstream token counts when available and otherwise the existing
  request-size estimate, rather than a hardcoded 20/0.
- Honor OpenAI `stream_options.include_usage` with a final usage chunk.
- Include estimated/actual input usage in Anthropic streaming events.
- Read `metricsEvent` token data in addition to `metadataEvent`.
- Round the accumulated output text once instead of rounding each SSE fragment.
- Keep raw token availability separate from fallback display counts, so logs
  retain `tokensEstimated: true` when upstream supplied no counts.

These estimates never determine credits; no cache-hit token counts are invented.

### 3. Historical tool exchanges changed representation on every turn

The old sanitizer removed old `toolUses` (including arguments) and converted old
`toolResults` into prose. A current result also changed from empty content to a
`.` placeholder only when entering history. This is information loss and prefix
instability, but **does not imply all earlier prefix cache blocks are invalid**.

Changes:

- Preserve complete adjacent tool pairs with unique, non-reused IDs and a
  matching current tool specification.
- Keep fallback narration for damaged historical pairs or removed tool specs.
- Make the current/history empty-content placeholder consistent.
- Normalize Claude historical tool names the same way as current tool specs.
- Reject duplicate, extra, partial, or undeclared **current** results locally with
  400, instead of conflating malformed results with assistant-only prefill.
- Preserve the pre-existing assistant-prefill behaviour when no results exist.

An ad-hoc source probe went from dropped old calls / changed result content to
preserved calls / stable content. A malformed duplicate result was accepted by
the old builder and rejected with 400 by the fixed builder.

### 4. Smart routing followed changing remaining-quota leaders

Without session affinity, small usage changes can move a conversation to another
account. Smart routing now uses stateless rendezvous ordering scoped to client key
ID, normalized model, and an explicit client session or first meaningful user
text. It is stable across edge isolates and candidate ordering. Explicit
round-robin/sequential behaviour and the native CLI path are unchanged.

Disabled credentials remain excluded. Exhausted credentials are placed last;
existing gates, cooldowns, and failover remain authoritative. This is a preference,
not an unconditional pin. It does not remember a successful fallback, and the
first-user heuristic can change after compaction. Stable account choice improves
reuse opportunity but does not guarantee a provider cache hit.

### 5. Stream logs hid the actual failure and fallback cost

Logs now retain `actualModel`, `retryCredits`, and the stream error message/status
instead of assigning every stream error a context-free 500. A charged error can
still represent real upstream work; it must not automatically be refunded or
classified as a client abort without evidence.

## Comparison with 9router

Read-only reference: `~/GitTool/9router/open-sse/`.

- `translator/concerns/kiroConversation.js` reconciles/validates adjacent tool
  pairs and preserves valid structure. This informed the narrow Worker fix.
- `utils/kiroSessionReplay.js` can freeze the first message for an explicit
  session, scoped to account/model/system prompt.
- `utils/sessionManager.js` deliberately generates an ephemeral Kiro identity
  when no usable client session exists.
- The translators also add current-time context. Account changes and reconstructed
  later turns can still change payload prefixes. **9router is not cache-immune.**
- Its general usage-history cost column cannot by itself establish Kiro credit
  consumption. Do not compare that USD estimate directly to metering credits.

Live Sonnet experiments used real metering events. Both random and fixed
conversation IDs produced approximately 0.072364 Cr initially and 0.038397 Cr on
repeats. A small tool-loop experiment reduced the incremental first-vs-repeat
premium with preserved history, but a longer tool-result A/B produced similar
aggregate costs (0.222922 vs 0.234400 Cr, with differing generated outputs).
These results do **not** demonstrate 12–20× savings, universal cache misses,
or the economics of the user's large Opus workload.

## Deployment and verification

Deployed Worker version: `8d485729-a18d-4135-bc41-f5e7e78cbe4b`.
Rollback version: `ee04203b-a2ae-4f45-867c-8cd8b15cf75a`.

The pre-existing uncommitted profile/quota changes were verified to be already
in production: the downloaded old Worker was byte-identical to the local
pre-fix Wrangler bundle. Those changes were preserved. No static assets changed.
The downloaded new Worker byte-matches the verified final build:
SHA-256 `347a270b319e3fdc7ca68d54b2d01717a29d4e309597f0f2a0412c26ef47f582`.

Verification performed:

- Existing Worker suite: **174 pass, 0 fail, 0 skipped**.
- Go binary build, `go vet ./...`, and existing `go test ./...`: pass.
- Wrangler local `/health`, dry-run bundle, and `git diff --check`: pass.
- Six real post-deploy completions covering OpenAI SSE/JSON and Anthropic
  SSE/JSON, including multi-turn tool history: HTTP 200 with nonempty replies.
- OpenAI SSE input usage: **2,318 / 2,614 / 2,910**; OpenAI JSON: **2,318**;
  Anthropic JSON and SSE: **2,327**. These are correctly exposed estimates for
  these probes, not exact tokenizer measurements.
- Read back all six rows through `/v1/check`: **0.230150 Cr** total, zero retry
  credits, one account for the shared session, and **zero reserved credits**.
- Duplicate current tool result: production HTTP **400**, read-back charge **0**.
- Unauthenticated `/v1/models`: **401**; `/health`: **200**.

One verification request hit a local `ECONNRESET`; only the remaining mode checks
were rerun, then all successful rows were read back. It was not counted as a
successful probe.

## Follow-up: why the same request cost more here than through 9router

The client behind `key-11` sends 9router-style model ids (`kr/claude-opus-4.6(low)`,
`kr/claude-opus-5.5-thinking-agentic(low)`). Comparing what each gateway actually
sends upstream, then metering identical prompts on the same Kiro account
(2026-10-22, ~9k-token prompt, one-word answer), found three cost defects.

### Metered price per model (same prompt, same account)

| modelId sent to Kiro | Credits | Note |
|---|---:|---|
| claude-haiku-4.5 | 0.0053* | *10-token prompt; live |
| claude-sonnet-4.5 / 4.6 | 0.0097* | live |
| claude-sonnet-5 | 0.1946 | |
| claude-opus-4.6 | **0.2254** | live, **31% cheaper than 4.7** |
| claude-opus-4.7 | 0.3257 | |
| claude-opus-5 | 0.3307 | |
| claude-sonnet-5.5 | 0.3785 | |
| claude-opus-5.5 | 0.5846 | |
| gpt-5.6-sol | **1.9716** | **6× opus-5, 10× sonnet-5** |

A second pass on the sibling credential (same e-mail) returned opus rows at
47–73% of the first pass with identical ratios — the prompt cache is shared
across the two credentials and does work when the payload prefix is stable.

### Defect 1 — "retired" ids were silently upgraded to pricier models

`mapKiroModel` / `MODEL_ALIASES` folded opus-4.6 and opus-4.5 onto opus-4.7,
sonnet-4.5/4.6 and haiku-4.5 onto sonnet-5, with a comment claiming they were
retired. Live probes show all five still answer. 9router passes the id through
unchanged. Every `kr/claude-opus-4.6(low)` request from this user was therefore
billed at opus-4.7 rates (+44% per token) without the client asking for it.

Fix: the five ids are live in `VALID_KIRO_MODELS`, advertised on `/v1/models`,
and resolved exactly. Genuinely dead ids (`claude-sonnet-4`, `claude-opus-4.1`,
`*-thinking` upstream ids) still fold onto a live model.

### Defect 2 — the throttle fallback chain demoted onto the most expensive model

`MODEL_FALLBACK_CHAIN` ended every Claude chain (and started `auto`) with
`gpt-5.6-sol`. Under an `INVALID_MODEL_ID` throttle the gateway silently served
a model metered 3–6× higher than the one requested. Log row 15:09:19 shows it
happening: requested `kr/claude-opus-5.5(low)`, `actualModel: gpt-5.6-sol`,
~250k tokens, 18.42 Cr.

Fix (operator decision): **no model fallback at all.** `MODEL_FALLBACK_CHAIN` is
empty; the requested model is the only candidate. A throttled model still gets
the bounded same-model retry ramp on each pool account (~11 s/account), then the
client receives a normalized **429 + Retry-After** ("Kiro throttled this
model"); an empty stream on every account yields 503. No request is ever billed
for a model the client did not name. Verified on production: a real transient
Kiro throttle across all three accounts returned 429 in 33 s with no
`X-Kiro-Model-Fallback` header and no other model called (debug tail, since
removed); the same request minutes later returned 200 on the requested model.

### Defect 3 — effort / `(low)` was ignored

The Worker had no handling for the `(low)` suffix, `reasoning_effort`,
`reasoning.effort`, `output_config.effort` or `thinking.budget_tokens`; the
`thinking` argument of both payload builders was unused. 9router forwards these
as Kiro's native `additionalModelRequestFields` (`output_config.effort` for
Claude ≥ 4.6, `reasoning.effort` for GPT-5.6).

Fix: `requestedEffortLevel` + `kiroEffortRequestFields` emit the same fields,
only when the client asked for an effort explicitly. Verified accepted upstream
on opus-4.6/4.7/4.8/5/5.5, sonnet-5/5.5 and gpt-5.6-sol. On a short reasoning
prompt the effort level did **not** change credits measurably (0.17–0.24 Cr in
every variant), so this is a correctness fix; it is not claimed as a saving.

### What this does and does not explain

- The user's 2.6–4 Cr `opus-4.6(low)` rows at ~20–38k tokens were billed as
  opus-4.7; the same requests now go to opus-4.6.
- The 18.4 Cr row was a silent gpt-5.6-sol fallback; that path no longer exists.
- The 105 Cr row (`opus-5.5-thinking-agentic(low)`, ~142k tokens) is consistent
  with a full-price, uncached opus-5.5 context at the highest Claude rate, with
  hidden reasoning tokens not visible in the estimated output count. It is not
  attributable to a gateway multiplier; no evidence of replay was found.

Deployed Worker version: `59dd8c3f-227e-4d85-bf26-9611b014cf12` (previous
`5946e654…` still had a cheaper-model fallback chain; `ee04203b…` is the
pre-session baseline). Post-deploy:
`/v1/models` advertises the 4.x ids; `kr/claude-opus-4.6(low)` logs
`actualModel: claude-opus-4.6` at 0.016 Cr; `claude-haiku-4.5` at 0.0053 Cr.
Evidence: `~/.hermes/cache/scratch/kcache/{model-price,model-probe2,probe3,effort-ab-opus5,effort-ab-opus55,live-final}.txt`.

## Artifacts and remaining boundaries

Sanitized evidence is retained under
`~/.hermes/cache/scratch/kcache/`: `durable-object-replay-proof.json`,
`worker-suite-final.txt`, `production-review-before.json`,
`production-review-after.json`, `production-review-after-json.json`, and
`production-final-readback.json`. Source snapshots and `source-fix.diff` preserve
the before/after comparison; temporary credential dumps are removed after use.

No commits or pushes were made. No balances, quotas, or historical charges were
reset/refunded. Go translation was not changed because it does not serve the
supplied URL. Linked-account aggregate overcounting is a separate admin reporting
finding, not demonstrated as a per-key charge error. Explaining or refunding the
historical 42.131581-Cr row still requires correlated raw per-attempt metering /
cache data; the new logs improve that visibility but cannot reconstruct the past.
