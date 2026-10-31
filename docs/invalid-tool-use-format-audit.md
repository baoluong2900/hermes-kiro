# 400 "Invalid tool use format" on claude-opus-5 / 5.5 (2026-10-31)

## Symptom
One client (key "Bui Thinh", OpenAI endpoint) failed intermittently with
`HTTP 400 from Kiro CLI: {"__type":"…#ValidationException","message":"Invalid tool use format.","reason":"REQUEST_BODY_INVALID"}`
while other keys on the same model/account succeeded. Not model-specific.

## Root cause
Kiro validates `toolUseId` as `[A-Za-z0-9_-]{1,64}`. The translators forwarded
client tool-call IDs verbatim into the active tool turn (`toolUses` +
`toolResults`). Clients that bridge OpenAI Responses IDs (`call_x|fc_y`) or
generate long IDs trip the validator only on turns that replay a tool call.

Reproduced live against Kiro:
| tool_call id | result |
|---|---|
| `call_abc123` | 200 |
| `call_abc\|fc_123` | 400 Invalid tool use format |
| `call_` + 120 chars | 400 Invalid tool use format |

## Fix
- Go `proxy/translator.go`: `normalizeToolUseID` — valid IDs pass through,
  others map deterministically to `tooluse_<sha256 prefix>`; applied to both
  OpenAI (`tool_calls[].id`, `tool_call_id`) and Claude (`tool_use.id`,
  `tool_result.tool_use_id`) paths, so call/result still pair.
- Worker `cloudflare/worker.gateway.js`: `normalizeToolUseId` (sync FNV hash),
  same four sites.

Verified after fix: pipe ID on claude-opus-5, 120-char ID, and Claude
`/v1/messages` pipe ID all return 200.

## Second bug: one bad client starved the whole pool
`handleAccountModelFailure` counted these 400s as account errors; 3 in a row
put the account in a 1-minute cooldown. Prod runs effectively on one account,
so every other key got 503 "No available accounts" while this client retried.
Fix (`proxy/account_failover.go`): non-retryable upstream errors
(`!ue.Retryable()`: validation, oversized input, …) no longer count against
the account.

## Deployment
Deployed 2026-10-31 16:44 as `ghcr.io/baoluong1120/kiro-go-render:tooluseid-202610311631`
(Render `srv-dbg8pimc6qcc73en05fg`, deploy `dep-dbirgqbbc2fs73b4h4q0`). Verified on
`kiro-go.hermesgate.app`: pipe ID, 120-char ID and Anthropic pipe ID all 200;
all 7 models 200.
