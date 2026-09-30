# Model mapping audit — no silent model substitution

Date: 2026-10-01 · Repo: Kiro-Go (`proxy/translator.go`, `proxy/handler.go`)

## Requirement

A model the operator selects must be the model that runs. No silent substitution to
another model, and no runtime fallback to a different model.

## How it was checked

Three sources compared:

1. the **live upstream catalog** — `GET /admin/api/accounts/{id}/models` per enabled
   account (this is Kiro's own `ListAvailableModels`, the authority on what is served),
2. the **advertised list** — `GET /v1/models`,
3. the actual `MapModel()` result of every id, evaluated by calling the real translator.

## What was wrong

The static `modelAliases` table folded ids that the upstream **still serves**. Six live
ids were being silently replaced:

| selected | actually ran |
|---|---|
| `claude-opus-4.6` | `claude-opus-4.7` |
| `claude-opus-4.5` | `claude-opus-4.7` |
| `claude-sonnet-4.6` | `claude-sonnet-5` |
| `claude-sonnet-4.5` | `claude-sonnet-5` |
| `claude-sonnet-4` | `claude-sonnet-5` |
| **`claude-haiku-4.5`** | **`claude-sonnet-5`** (different family) |

`/v1/models` also advertised `gpt-4o`, `gpt-4`, `claude-opus`, `opus`, `kimi-k3-free`
which are not upstream ids and were remapped to `claude-sonnet-5` / `claude-opus-5`.

## Fix

- Every id present in the live catalog now maps to **itself**.
- `gpt-4o` / `gpt-4` / `kimi-k3-free` removed from the advertised list.
- Bare `opus` / `claude-opus` removed from the advertised list (they were ambiguous and
  pointed at opus-5); they still resolve for legacy callers but are not offered.
- Ordering note: matching is `strings.Contains`, first match wins, so a longer id must
  precede any id it contains. The dated snapshot `claude-sonnet-4-20250514` now precedes
  `claude-sonnet-4`, otherwise the shorter entry shadows it and the snapshot falls through
  verbatim.

Legacy shims remain ONLY for ids genuinely absent from the catalog (`claude-3-*`,
`claude-sonnet-4-20250514`, `claude-opus`, `opus`, `gpt-4*`). None of those is advertised,
so a caller selecting from `/v1/models` cannot hit one by accident.

## Verification

- `go test ./...` PASS, `go vet ./...` clean, build OK. Ten `TestParseModelAndThinking`
  expectations were updated: they asserted the old fold-away behaviour.
- Re-ran the audit against the deployed binary: **no live id is substituted**
  (sections A/B/C empty), and live calls echo what was selected:
  `claude-sonnet-4.6`, `claude-opus-4.5`, `claude-haiku-4.5`, `claude-opus-5.5` all
  returned HTTP 200 with `model` equal to the requested id.

## Known limitations (not fixed)

- This table is still **static**. If the catalog changes for a different deployment of
  credentials, it can drift again. The robust design is to resolve aliases against the
  live `ListAvailableModels` cache and refuse to substitute a name the catalog serves;
  that is a larger change and was not made.
- `auto` is resolved upstream, so it is not a fixed model by design.
- `reasoning_effort` / `thinking` in an OpenAI-style body are **not** honored: the
  request struct has no such field and the thinking path keys only off the `-thinking`
  model suffix. A caller sending `reasoning_effort: "high"` on a non-suffixed model gets a
  non-thinking run — which can read as "the model got dumber".

## FIXED — `reasoning_effort` was dropped (the "Opus 5.5 feels dumb" report)

Hermes reaches Kiro-Go over the OpenAI chat API (`api_mode: chat_completions`) and its
requests carry `reasoning_effort: "high"`. `OpenAIRequest` had no field for that key, so
the value was discarded and the model ran **without** its thinking path — which looks like
a worse model than the one selected.

Change:

- `proxy/translator.go` — added `ReasoningEffort string \`json:"reasoning_effort,omitempty"\``
  to `OpenAIRequest`.
- `proxy/handler.go` (`handleOpenAIChat`) — when the model name has no `-thinking` suffix
  and `reasoning_effort` is non-empty, enable the thinking path.

Proof (same prompt, `claude-opus-5.5`, measured `reasoning_content` length):

| request | reasoning_chars |
|---|---|
| no `reasoning_effort` | 0 |
| `reasoning_effort: "high"` | 55 |
| model `…-thinking` | 56 |

So a requested effort now behaves like the `-thinking` suffix. Limit: Kiro-Go can only turn
the thinking path on or off — it does not map `low`/`medium`/`high` to a strength level, and
how much the upstream model actually reasons is Kiro's.

