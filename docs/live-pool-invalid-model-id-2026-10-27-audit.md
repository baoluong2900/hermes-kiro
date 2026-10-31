# Live pool investigation: `INVALID_MODEL_ID`, 2026-10-27

## Scope and conclusion

Target: **https://kiro-go.hermesgate.app/admin**, the hosted Cloudflare Worker,
not the local Go daemon. Initial evidence was read at approximately 13:49 UTC+07.
The affected log snapshot exactly matches the user report: **327 retained rows,
195 successes, 132 errors (40.37%)**, covering October 21–27. These are retained
log counts, not the server's lifetime failure rate.

**Confirmed:** the deployed Worker conflates real upstream model rejections,
local concurrency admission failures, and local cooldown skips into the same
`429 / Kiro throttled this model (upstream reported INVALID_MODEL_ID)` message.
Its log records cannot distinguish those causes retrospectively.

**Also confirmed:** the affected API key, the `kr/` prefix, the `(low)` suffix,
Opus 4.6, and the first enabled Student account currently work through the real
chat route. Sequential minimal and approximately 18K-input streaming probes
returned actual assistant text and `X-Kiro-Actual-Model: claude-opus-4.6`.

**Not established:** the exact upstream reason for the two historical requests
at 13:17:25 and 13:33:17. Their 26,131 ms and 24,331 ms durations are consistent
with the upstream retry ramp and inconsistent with a complete 30-second
admission timeout alone. Duration is not a raw upstream trace, however. It does
not prove concurrent traffic, a provider-wide rate limit, token throttling, or
entitlement restrictions. No original request bodies or per-attempt upstream
records are retained in these rows.

## 1. Production identity and deployment drift

Read-only Cloudflare deployment discovery shows 100% traffic on version
`5ae35f5f-3708-458b-b766-5b00850d35a7`, created
`2026-10-22T10:35:16.273Z` (17:35 UTC+07).

Evidence was checked against **downloaded deployed Worker content**, not inferred
solely from the current checkout. Production `app.js` also lacks
`logFailureBadge` / `failureKind`, whereas the working tree contains the pending
cause-classification fix documented in `invalid-model-id-admission-gate-audit.md`.
The public `/health` endpoint returns HTTP 200. Unauthenticated
`/admin/api/status` correctly returns 401.

The historical audit is useful context, not proof of today's upstream conditions.
In particular, today's multi-day failure pattern should not be dismissed as a
short-lived burst merely because earlier probes recovered.

## 2. Exact original log counts

| Classification | Count | Notes |
| --- | ---: | --- |
| Success | 195 | Includes successes on multiple accounts over the retained period |
| 429, generic `INVALID_MODEL_ID` wording | 125 | No `failureKind` or raw upstream body retained |
| Cloudflare/upstream 520 | 2 | Body `error code: 520` |
| Invalid tool-result request, 400 | 1 | Tool results do not uniquely match the preceding declared calls |
| 500 without error detail | 4 | Older rows, separate observability gap |
| **Total** | **327** | Unique request IDs; zero duplicate IDs |

Of the 132 errors, **121 belong to key `Cha tin`**: 119 generic 429s and two
520s. Its displayed `kr/claude-opus-4.6(low)` model has 194 retained rows:
101 successes and 93 errors (91 generic 429s, two 520s).

The `muhammad.hidayat030… +1` label does not mean that only that account was used.
For 119 generic 429 rows, `attemptedAccountIds` is:

1. `acc-1-91040238` — muhammad.hernando
2. `acc-2-99af808b` — muhammad.hidayat030

The displayed account is the **last visited candidate**. A candidate can be
visited and skipped locally without an upstream call; this array is not a
network-attempt counter.

All 125 generic 429 rows have **zero recorded credits**. Their input token counts
are marked `tokensEstimated: true`: `16.5K / 0` does not prove Kiro accepted or
billed 16.5K tokens for that failed request. The other error classes include a
small recorded charge and must not be described collectively as all free.

### Recent chronology, before this investigation's probes

| Date, UTC+07 | Retained requests | Success | Error |
| --- | ---: | ---: | ---: |
| October 24 | 26 | 0 | 26 |
| October 25 | 33 | 0 | 33 |
| October 26 | 15 | 0 | 15 |
| October 27 | 13 | 2 | 11 |

Thus October 24–27 contains **87 rows, 85 errors, two successes**. Both successes
were on the API-key / Pro Max account, which is currently disabled:

| Time, October 27 | Actual model | Input / output, estimated | Recorded credits |
| --- | --- | ---: | ---: |
| 12:28:18 | claude-opus-4.6 | 14,577 / 793 | 0.653347 |
| 13:12:45 | claude-opus-4.6 | 15,472 / 818 | 0.685269 |

The two most recent failures then returned through the two Student candidates,
not this Pro Max account. This is a strong operational difference, but does not
by itself prove Student entitlement loss: the Student account subsequently
produced real successful chat responses during this investigation.

## 3. Pool and key state

Snapshot values, not a fresh upstream quota synchronization:

| Account | Auth / plan | Enabled | Stored used / limit |
| --- | --- | --- | ---: |
| muhammad.hernando | social / Student | yes | 870 / 1,000 |
| muhammad.hidayat030 | social / Student | yes | 821 / 1,000 |
| jordan.lim001 | IdC / Student | no | 675 / 1,000 |
| Rhys.Montgomery001 | IdC / Student | no | 675 / 1,000 |
| elizabethperezu677 | API key / Pro Max | no | 0 / 5,000 |

Routing is `sequential`; `allowOverUsage` is false. Only **two of five accounts**
are enabled. Their stored remaining allowance totals **309 credits**. The
large allowance on the disabled Pro Max account is not available to routing.
An `available: 2` status means enabled with stored quota remaining, not that a
model call has just passed.

Key `Cha tin` is enabled, has no expiry, and initially reports
`1,704.799234 / 2,000` credits used, **295.200766 remaining**, with no active
reservation. This is not a client credit-limit failure.

No account was enabled, disabled, reordered, or re-imported during this work.
No quota synchronization or secret changes were performed.

## 4. What is wrong in the deployed code

The actual deployed `callKiroResilient` has these paths:

- An active cooldown skips the candidate.
- A denied admission permit sets `lastThrottle` to a fabricated
  `{status: 400, text: JSON.stringify({reason: "INVALID_MODEL_ID"})}`.
- If no upstream throttle was captured, exhaustion still supplies the same
  fabricated `INVALID_MODEL_ID` body to the normalizer.
- The normalizer emits the same 429/message for all three cases.

A differential replay imported the downloaded deployed module and the current
working-tree module, injected one cause at a time, and counted `send` calls:

| Injected event | Upstream calls | Deployed result | Working-tree result |
| --- | ---: | --- | --- |
| Local admission denied | 0 | claims upstream `INVALID_MODEL_ID` | `local_admission` |
| Existing local cooldown | 0 | claims upstream `INVALID_MODEL_ID` | `local_cooldown` |
| Actual upstream 400 with `INVALID_MODEL_ID` | 1 | same generic message | `upstream_throttle` |

This is an isolated replay of the real implementations, not a production load
experiment. It proves the classification defect, not the exact cause of every
historical row.

Four historical generic 429s complete in only 199–255 ms. The 03:26:30 row today
follows another failed request at 03:26:11 and matches a cooldown skip rather
than the multi-second retry ramp. Both still show identical error text. The
other 429s, especially the two user-selected rows, must not all be relabeled as
local admission failures.

Production gate policy serializes each Opus model to one in-flight request per
account, with 1,200 ms start spacing, a 30-second per-account admission deadline,
and 30-second cooldown after a genuine upstream model rejection. The retry ramp
can make four upstream sends per account before moving to the next account.
This contributes latency and potential retry amplification. It does not prove
that user concurrency caused this incident.

The pending working-tree fix already introduces `modelExhaustionFailure`,
separates `local_admission` / `local_cooldown` / `upstream_throttle`, carries
`routing.failure` through both OpenAI and Anthropic dispatch, and renders the
cause in the web log. It is **not deployed**.

## 5. Live verification and its limitations

### Account test endpoint

Five sequential `/admin/api/accounts/:id/test-model` calls reported `ok: true`:
Opus 4.6 and Haiku 4.5 on both enabled Student accounts, and Opus 4.6 on the
disabled API-key account. Server-reported latencies were 587–3,471 ms.

**Caveat:** the deployed account probe contains
`const reply = textContent.trim() || "ok"`. It can therefore report success for
an empty HTTP-200 event stream. Those five UI-style checks alone are not
sufficient proof of actual model output. No conclusion relies on them alone.

### Real chat route, affected client key

Three **sequential**, low-output requests used the affected key in memory;
no credential was printed or written to the report. All returned actual `ok`
text and `X-Kiro-Actual-Model: claude-opus-4.6`:

| Shape | HTTP | Client wall time | Production log ID |
| --- | --- | ---: | --- |
| Base model, small prompt, non-stream | 200 | 6,792 ms | `4e4ba0fb-8332-496c-86a5-5d789d724575` |
| `kr/claude-opus-4.6(low)`, small prompt, non-stream | 200 | 3,952 ms | `824e60f3-efbf-4647-be0e-2f660f43f7b9` |
| Same decorated model, 69,209 characters of synthetic input, stream | 200 | 15,991 ms | `aed188a8-8668-47d9-854d-8128d9cc8e23` |

A read-back of `/admin/api/logs` verified all three as successful on
`acc-1-91040238`, with no model substitution. The streamed request records
**18,213 estimated input tokens / one output token**. Client wall time and
stored stream duration differ; the latter should not be treated as end-to-end
client latency.

The key's recorded charge increased by exactly **0.177604 credits**, equal to
the sum of the three new request log charges. Its reservation returned to zero.
The log grew from 327 to 330 rows. Enabled-account flags were read back unchanged.

These synthetic prompts do not reproduce the user's exact conversation,
system prompt, tool definitions, turn history, image attachments, original
concurrent traffic, or upstream conditions at the failure time. No stress burst
was sent. Successful probes demonstrate present functionality, not a proven
resolution of the historical intermittent failures.

## 6. Additional confirmed local diagnostic fixes

Only `cloudflare/worker.gateway.js` was edited in this investigation; all
pre-existing working-tree changes, including test files, were preserved.

1. **Unknown cause no longer fabricates an upstream rejection.**
   `modelExhaustionFailure({kind: "unknown"})` previously generated the same
   `INVALID_MODEL_ID` wording despite lacking upstream evidence. It now returns
   an explicitly uncertain retryable message with `kind: "unknown"`.
2. **Account probes no longer fabricate assistant text.**
   `probeAccount` now returns `ok: false` when no non-whitespace assistant text
   was produced, and preserves actual text on success.
3. **Pool-level evidence survives later local skips.**
   A real model rejection followed by a cooldown skip previously became
   `local_cooldown`, claiming no upstream call. A cooldown followed by HTTP 500
   also incorrectly retained the cooldown message. Both actual dispatch handlers
   now select structured outcomes, prioritize observed upstream evidence over
   local skips, and attribute the final row to the account providing that evidence.
4. **Raw upstream status and failure kinds survive exhaustion.**
   Two ordinary upstream 429s or 402s previously ended as generic 502s because
   their structured HTTP status was discarded. Both dispatchers now preserve
   status and `Retry-After`, and retain `upstream_empty` instead of dropping its
   cause when rebuilding the terminal failure.
5. **Queued admission respects newly recorded cooldown.**
   The initial cooldown check occurred before waiting for a model lease, and
   Durable Object acquire did not check cooldown. A queued caller could send
   during the preceding request's cooldown. Acquire now denies an active
   cooldown in the same operation that checks leases; the client helper returns
   `local_cooldown` so the pool can move on without another upstream call.

Before editing, inline probes reproduced these defects in the real source.
The initial seven ad-hoc checks cover empty/whitespace/text-bearing account
streams, unknown-cause honesty, and local/upstream classification. An additional
**17 ad-hoc checks passed** after the independent review: seven pooled-outcome
scenarios on each of the two actual handlers, active-cooldown admission,
newly recorded cooldown while queued (zero upstream sends), and recovery after
cooldown expiry. Network access was disabled for the isolated replay. No test
files were added or edited.

Validation:

- Existing Worker suites: **174 passed, zero failed**, across 11 files.
- `git diff --check`: clean.
- Web JS syntax check: passed.
- `go vet ./...`, `go test ./...`, and a scratch-output Go build: passed.
- `wrangler deploy --dry-run`: successful bundle with 23 assets; **no deployment**.

## 7. Remaining uncertainty and operational next steps

The independent review also found a **Go-only sibling inconsistency**:
`proxy/account_failover.go` classifies a message-based `INVALID_MODEL_ID`
`ValidationException` by exception type and increments generic account errors,
whereas `proxy/kiro.go` recognizes its message as a model-specific retryable
failure. This is not the runtime serving the public Worker and was left unchanged
to keep the production investigation isolated. It requires a separate bounded
Go failover change and verification, not a claim about today's hosted pool.

A 24-second duration must not be used as proof of `INVALID_MODEL_ID`: a mixed
sequence such as a slow upstream 500 followed by a cooldown skip can produce
that same old error message. Earlier duration-based audit conclusions are not
sufficient evidence of an upstream reason. The retry jitter ranges from half to
one-and-a-half times each base step, rather than providing a strict 7.2-second
upper bound per account.

1. Deploy the reviewed cause-classification / probe / cooldown corrections only after an
   explicit instruction to update this public server. The working tree also
   contains unrelated pending changes, so do not deploy it blindly.
2. If immediate capacity is needed, consider explicitly enabling the Pro Max
   API-key account that already handled two real requests today. Confirm current
   health and the intended billing/routing behavior before changing its disabled
   state. Do not silently substitute a different model.
3. Capture per-account attempt diagnostics on a recurrence: normalized cause,
   raw upstream HTTP status/reason, upstream request ID, retry count, admission
   wait, and a non-sensitive request-shape summary. Never retain bearer tokens
   or full customer prompts just to diagnose this error.
4. Until that evidence exists, keep traffic sequential and avoid increasing
   retry/concurrency settings as a speculative fix. The small enabled pool and
   retry ramp are capacity risks; they are not a proven explanation for all 85
   recent errors.

**No commit, push, account-state change, local-daemon restart, or production
Worker deployment was performed.**
