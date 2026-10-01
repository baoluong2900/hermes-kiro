# Accessibility & Structural Audit — `web/index.html`

Scope: static markup of `web/index.html` (827 lines) only. Dynamic content injected by
`/admin/app.js` into containers such as `#accountsList`, `#apiKeysList`, `#logsList`,
`#channelsList`, `#modalBody`, etc. is **out of scope** and not verified here.

Convention note (respected throughout): controls that carry `data-i18n-aria-label`,
`data-i18n` (visible text), or `data-i18n-title` get their accessible name/text at runtime
and are **not** flagged as nameless. A standing caveat is recorded in "Suspected / resilience".

---

## CONFIRMED findings (ranked by severity)

### C1 — Form inputs with no programmatic label (HIGH)
Each control below has no associated `<label for=…>`, is not wrapped by a `<label>`, and has
no `aria-label` / `data-i18n-aria-label`. A `placeholder` is **not** an accessible name.
Screen-reader users get no field name.

| Control | Line | Current fallback |
|---|---|---|
| `#pwdField` | 71 | placeholder only; label L68 is detached |
| `#filterSearch` | 233 | placeholder only |
| `#apiKeyTraceSelect` | 272 | none; label L270 detached |
| `#externalBaseUrl` | 359 | placeholder; label L358 detached |
| `#externalApiKey` | 363 | placeholder; label L362 detached |
| `#externalDefaultModel` | 367 | placeholder; label L366 detached |
| `#externalOpusModel` | 371 | placeholder; label L370 detached |
| `#externalSonnetModel` | 375 | placeholder; label L374 detached |
| `#externalHaikuModel` | 379 | placeholder; label L378 detached |
| `#thinkingSuffix` | 392 | placeholder; label L391 detached |
| `#openaiThinkingFormat` | 397 | none; label L396 detached |
| `#claudeThinkingFormat` | 405 | none; label L404 detached |
| `#preferredEndpoint` | 418 | none; label L417 detached |
| `#newPassword` | 442 | placeholder; label L441 detached |
| `#proxyType` | 506 | none; label L505 detached |
| `#proxyHost` | 516 | placeholder; label L514 detached |
| `#proxyPort` | 517 | placeholder only; **no label at all** |
| `#proxyUsername` | 523 | placeholder; shares detached label L521 |
| `#proxyPassword` | 525 | placeholder; shares detached label L521 |
| `#apiKeyForm_name` | 750 | placeholder; label L749 detached |
| `#apiKeyForm_expiryPreset` | 755 | none; label L754 detached |
| `#apiKeyForm_expiryDate` | 762 | **no label, no placeholder** |
| `#apiKeyForm_creditLimit` | 767 | label L766 detached |
| `#apiKeyShowValue` | 788 | **no label, no placeholder** (readonly display field) |

### C2 — `<label>` elements with no `for=` and not wrapping their control (HIGH)
These are the detached labels that cause C1. The label text exists but is not programmatically
tied to any control. Fix by adding `for="…"` (or wrapping the control).

| Label line | Visually labels | Target control |
|---|---|---|
| 68 | password field | `#pwdField` (71) |
| 270 | trace select | `#apiKeyTraceSelect` (272) |
| 358 | base URL | `#externalBaseUrl` (359) |
| 362 | API key | `#externalApiKey` (363) |
| 366 | default model | `#externalDefaultModel` (367) |
| 370 | opus model | `#externalOpusModel` (371) |
| 374 | sonnet model | `#externalSonnetModel` (375) |
| 378 | haiku model | `#externalHaikuModel` (379) |
| 391 | thinking suffix | `#thinkingSuffix` (392) |
| 396 | openai format | `#openaiThinkingFormat` (397) |
| 404 | claude format | `#claudeThinkingFormat` (405) |
| 417 | preferred endpoint | `#preferredEndpoint` (418) |
| 441 | new password | `#newPassword` (442) |
| 505 | proxy type | `#proxyType` (506) |
| 514 | proxy host | `#proxyHost` (516) / `#proxyPort` (517) |
| 521 | proxy auth | `#proxyUsername` (523) / `#proxyPassword` (525) |
| 749 | key name | `#apiKeyForm_name` (750) |
| 754 | expiry | `#apiKeyForm_expiryPreset` (755) |
| 766 | credit limit | `#apiKeyForm_creditLimit` (767) |

Correctly associated labels (for reference, **not** issues): L78 `for="rememberPwd"`,
L538 `for="proxyBulkInput"`, and the wrapping labels at L203, 219, 254, 312, 337, 350, 427,
454, 462, 469, 639.

### C3 — `<label>` used as a section heading with no control (MEDIUM)
`<label>` carries labelling semantics; using it purely as a heading is incorrect and leaves a
label with no target. Use a heading/`<div>`/`<legend>` instead.

| Line | Text key | Note |
|---|---|---|
| 322 | `apiKeys.listTitle` | heads the `#apiKeysList` region, no control |
| 451 | `settings.builtinFilters` | group heading for toggle list |
| 479 | `settings.customRules` | group heading for rules list |

### C4 — Modal dialogs lack dialog semantics (MEDIUM)
All modal containers are plain `<div class="modal">` with no `role="dialog"` (or
`role="alertdialog"`), no `aria-modal="true"`, and no `aria-labelledby` pointing at their
`.modal-title`. Screen readers do not announce them as dialogs, and focus is not programmatically
scoped from the markup.

Lines: 690, 697, 704, 711, 719, 726, 740, 778, 799 (9 modals). Each already has a `.modal-title`
(e.g. `#modalTitle` L692, `#confirmTitle` L728, `#apiViewTitle` L802) that could serve as the
`aria-labelledby` target.

### C5 — Main application view has no heading structure (MEDIUM)
The only heading element in the document is the login `<h1>` at **L65** (inside `#loginPage`).
The entire authenticated app (`#mainPage`, L93–687) contains **zero** heading elements — every
section/card title uses `<span class="card-title">` / `<div class="stat-card-title">` instead of
`<h2>`/`<h3>` (e.g. L201, 250, 310, 335, 439, 554, 631). Result: no navigable heading outline
when logged in.

Heading-order sanity: no *skipped* levels exist (there is nothing below `h1`), so the defect is
*absence of hierarchy*, not an out-of-order jump.

### C6 — Document language mismatch (LOW)
`<html lang="zh">` (L2) but the markup contains hardcoded Vietnamese static text, so assistive
tech will mispronounce it. Affected static strings: L101 (`title=`), 348, 352, 354, 358, 362,
366, 382, 383. (Most other text is runtime-injected via i18n and respects the active language;
these are the hardcoded exceptions.)

---

## Checks that passed (no CONFIRMED issue)

- **Duplicate `id` attributes:** none in the static markup. All ~150 ids are unique.
  *Caveat:* `app.js` injects list rows into `#accountsList`, `#apiKeysList`, `#apiKeysTabList`,
  `#channelsList`, `#logsList`, `#proxyListRows`, and modal bodies — duplicate ids could be
  generated there, but that is outside this file.
- **`<img>` without `alt`:** none. All three images (L45, L98, L656) have `alt=""`
  (decorative), which is correct — the brand image at L45 sits inside a labelled
  `.brand` wrapper (L44), and L98/L656 are decorative logos.
- **Buttons / icon-only controls without an accessible name:** none confirmed. Every icon-only
  control supplies a name via `data-i18n-aria-label` (theme toggles L54/129; password toggle L72;
  copy buttons L567/579/591/605/619; view buttons L603/617; modal closes L693/700/707/714/722/729/
  744/782/803) or via `data-i18n` visible text (tabs L108–121, lang buttons L50/51/126/127, action
  buttons). Per the stated convention these are treated as named.

---

## Suspected (needs runtime / JS confirmation)

- **S1 — `#sourceSwitcher` (L101):** `<select>` with no `<label>`; relies solely on
  `title="Quản lý nguồn dữ liệu (Data source)"`. `title` is a weak accessible-name source and is
  not localized. Recommend a real label.
- **S2 — i18n name resilience:** many controls ship with literal `aria-label=""` plus
  `data-i18n-aria-label` (e.g. L49, 54, 72, 106, 125, 129, 567, 603). If `app.js` i18n fails to
  run, these resolve to an *empty* accessible name. Not a defect under normal operation; flagged
  as a resilience risk only.
- **S3 — Interactive non-semantic elements:** cannot confirm from HTML alone. `.modal` backdrops
  (C4 lines) and the `.api-code` spans (`#claudeEndpoint` L566, etc. — copied via adjacent
  buttons) are candidates for click handlers in `app.js`; if any `<div>`/`<span>` receives a click
  handler without `role`/`tabindex`/keyboard support it would be an issue. Needs `app.js` review.
- **S4 — Live regions:** `#proxyListStatus` (L545) correctly uses `role="status"`, but other
  dynamically-updated containers (`#channelsNotice` L300, `#batchCount` L224, stat values
  L151/164/177/187) have no live-region semantics; relevance depends on how JS updates them.
