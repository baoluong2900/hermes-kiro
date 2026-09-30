# Hermes / Kiro-Go empty upstream response review

## Verdict

The prior fix is NOT a verified resolution. Existing tests and build pass, but replaying the real captured Hermes request still fails. This is reproducible without Hermes Desktop and on one fixed account.

## Evidence

- Captured request: `~/.hermes/sessions/request_dump_20261001_025335_a72ee5_20261001_030626_160332.json`.
- Actual HTTP path: POST `http://localhost:8080/v1/chat/completions`; Hermes received HTTP 502 with EmptyUpstreamResponse.
- Capture uses a system message, no developer messages, 6 messages and 24 tools. Developer-role support is a useful correction but cannot explain this particular captured failure.
- Exact replay: 502 in 17479 ms. Removing tools still failed (11835 ms).
- Minimal-message probes temporarily succeeded. Later even a plain Opus `Reply OK` failed, so early history/content correlations are inconclusive and must not be reported as causation.
- Direct Go probe calls the real translator and upstream client, using only the first enabled account and a private scratch config copy. No Desktop and no account rotation.
- Same captured conversation with Sonnet 5: upstream HTTP 200, 1730 body bytes, 72 text bytes, 0.12581260406301822 credits, 5446 ms.
- Same captured conversation with Opus 5: upstream HTTP 200, body length 0, clean EOF on Kiro IDE, CodeWhisperer and AmazonQ; 5371 ms total, no metering. Thus parser is not dropping response frames in this observed failure: no frames arrived.
- Bypassing the configured HTTP proxy in the isolated probe did not recover Opus.
- Adding agentTaskType/agentContinuationId did not recover the captured request. Experimental source addition was reverted; it was not deployed.
- `auto` and Sonnet 5 also succeeded via the existing local HTTP endpoint while Opus probes failed.

## Incorrect earlier conclusions

1. **0ms is not measured immediate disconnection.** `proxy/handler.go:2114-2115` passes constant zero to recordFailureWithDuration; OpenAI failure paths call this wrapper. The UI reflects missing duration instrumentation.
2. **No proof Opus 5.5 does not exist upstream.** Translator lines 36-41 currently substitute Opus 5 for explicit Opus 5.5 requests. This is a model downgrade, not proof of a fix. Catalog presence or returned model labels do not prove backend identity.
3. **No proof system/developer handling caused this capture.** The captured role is system.
4. **Fallback is only mitigation.** All configured endpoints can return empty, as seen in live logs and direct probes.
5. **Skipping cooldown is not recovery.** Empty failures no longer increment account error count; failures persist and repeated client retries can multiply upstream attempts.
6. **Single-account requirement was not applied to live configuration.** Read-only admin inspection showed both first and second accounts enabled. This review did not change their state. Isolated probes explicitly pinned the first account.
7. **Test success is not end-to-end success.** Existing suite, go vet and build pass, but captured request replay remains red.

## What is and is not established

Established: failure occurs on the Kiro-Go -> AWS/Kiro Opus path, even without Hermes Desktop, and manifests as an actual empty upstream HTTP 200 body. An account with usable Sonnet inference can fail Opus inference.

Not established: upstream internal reason (model capacity, model-specific throttle/entitlement, request-sensitive processing or another upstream behavior). No explicit quota/throttle/rejection response was received in these empty responses. Do not claim a permanent fix, ban, depleted credit or a particular upstream policy without evidence.

## Verification artifacts

- Sanitized HTTP probe outcomes: `~/.hermes/cache/scratch/kiro-review-probes.json`.
- Isolated executable probe: `~/.hermes/cache/scratch/kiro_review_main.go` (not a unit test).
- Private replay inputs remain in mode-0700 scratch directory `kiro-review-private`, with mode-0600 files; they contain credentials and must not be committed or shared.
- No test files were created or edited during this review. No live service restart or account-state changes during this review.

## Reconciliation with delayed subagent findings

The delayed five-agent batch does not establish an additional root cause. Claims about account-specific AWS worker assignment, capacity exhaustion, or token failures always producing a specific status are hypotheses, not measured facts. The direct parent probe observed `Content-Type: application/json`, not the event-stream content type asserted by one child. Different successes/errors in the same dashboard second cannot be linked as one retry chain without a request correlation ID; the main OpenAI handler logs terminal failure, not every pre-output failed account attempt. The child claiming full empty-response header logging describes an earlier intermediate edit: current `kiro.go:642` only logs endpoint fallback. Exception-frame header/payload logging is present at line 945. Never treat these stale summaries as the deployed state.

## Next corrective work

Instrument actual failure duration and sanitized upstream request IDs/status/body length. Capture model-specific availability under controlled spacing, keeping a single account pinned. Respect explicit model selection rather than silently replacing 5.5 with 5. Bound retry amplification and distinguish upstream-empty from unknown errors. Retain failures as failures rather than treating HTTP 200 alone as successful inference.
