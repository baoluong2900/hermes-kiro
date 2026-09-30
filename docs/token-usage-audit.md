# Kiro-Go token/credit usage audit

Scope: current working tree, Go proxy paths (`/v1/messages`, OpenAI chat, Responses). This is a source-level audit, not a measurement of a particular production account. The separately deployed Cloudflare Worker has its own ledger; see `docs/credit-billing-spike-audit.md` for that path.

## Confirmed findings

1. **Claude usage was silently capped at 15,000 input tokens (fixed).** `proxy/cache_tracker.go`'s `billedClaudeInputTokens` capped the uncached `input_tokens` field at 15,000, and four `OnContextUsage` handlers in `proxy/handler.go` also capped the context-percentage-derived input count. For example, a request consuming 60,000 input tokens with no cache could appear to a Claude client as 15,000, even while the upstream meter and the proxy's credit ledger charged the actual credit amount. This is *under-reporting*, not proof of duplicate charging. Removed these caps in both places. `cache_creation_input_tokens` and `cache_read_input_tokens` are still computed separately.

2. **Reported cache hits are local estimates, not proven Kiro cache discounts.** `proxy/cache_tracker.go` hashes client-side prompt prefixes and tracks them in process memory by account. `proxy/translator.go` converts the system blocks to plain text and does not transmit Anthropic `cache_control` to Kiro. Therefore, `cache_read_input_tokens` in a Claude response does not establish that Kiro billed fewer credits. Compare the upstream `meteringEvent.usage` and account quota before claiming a saving.

3. **Large contexts are forwarded repeatedly.** `proxy/translator.go` includes system priming, tool schemas, conversation history and current content; it only truncates once the serialized payload crosses a model-dependent byte ceiling (900 KiB at 200k context; proportionally larger for 1M). A byte limit is not a per-turn token budget. Agent clients replaying long tool output and history therefore process substantial input every turn. The `-thinking` path also prepends `ThinkingModePrompt` with a 200,000-character declared maximum, potentially increasing generated reasoning, though the actual billed impact requires upstream metering.

4. **Retries can amplify work.** `proxy/account_failover.go` allows up to three account attempts; `proxy/kiro.go` can try multiple IDE endpoint families and retries a recognized model-throttle rejection with short backoffs. Failed attempts can incur upstream usage. The stream parser sums `meteringEvent.usage` within an attempt (`proxy/kiro.go`), but account/endpoint-level metering across retries needs a production trace before asserting a concrete multiplier. API-key credentials instead use the CLI runtime endpoint, so they do not follow the same IDE endpoint list.

5. **Prompt filtering is opt-in.** The Claude Code system-prompt and environment-noise filters are guarded by persisted config flags (`config/config.go`). Without those flags, the full prompt is sent. Enabling filters changes model context/behavior; measure on representative requests first.

## Fix and verification

Removed all four 15,000-token clamps in `proxy/handler.go` and the uncached-input clamp in `proxy/cache_tracker.go`. Existing positive token estimates are still estimates when the upstream does not report exact counts. `go test ./...`, `go build ./...`, `go vet ./...`, and `git diff --check` passed. No new test files were created.

## To identify the actual production cause

Capture per-request **sanitized** metrics (not prompts, auth headers or tokens): endpoint family, selected model, attempt count, serialized payload bytes, upstream input/output token counts when present, context percentage, sum of `meteringEvent.usage`, returned client usage, and quota delta. Compare a fresh turn with a repeated warm turn using the same account and model. This separates large replayed context, retry cost, cache-display discrepancy and a real ledger discrepancy. Do not infer a precise savings or overcharge from source inspection alone.
