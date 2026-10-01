# web/app.js — DOM-building render audit (HTML-escaping + inline layout)

Scope: every `innerHTML`-assembling render function in `web/app.js` (4581 lines).
Method: static read of all render/`*Html`/`*Card`/badge helpers and their inputs.
No source was modified — findings only.

## Verdict

Escaping of **string** data is consistent across the whole file. Every
server/user string that reaches `innerHTML` text is wrapped in `escapeHtml()`,
and every value placed inside a quoted attribute uses `escapeAttr()`. I found
**no case** of `escapeHtml` being misused in attribute position, and **no raw
unescaped string** reaching the DOM. So there is no live stored/reflected XSS or
quote-break in the current code.

The real, confirmed issues are: (1) two log-table renderers that have **drifted**,
(2) a cluster of interpolations that skip `escapeHtml` and are **safe only because
the helper happens to return a number** (fragile), (3) inline `width:` styles built
two different ways, and (4) one hardcoded, non-escaped-path English string.

Ranked CONFIRMED first, then SUSPECTED/fragile.

---

## CONFIRMED

### C1 — Duplicated log-table renderers have drifted
- `renderLogs` — `web/app.js:787` (table build starts `:813`)
- `refreshApiKeyTrace` inner renderer — `web/app.js:2184` (called from `:2145`)

Both hand-build an identical `<table class="logs-table">` with byte-for-byte
copies of `statusCell`, `ipCell`, `detailCell`, and `tokensVal`. They have
already diverged, which is the drift the task asked to flag:

- Row cap: trace loops `filtered.slice(0, 100)` (`:2193`); `renderLogs` loops the
  full `filtered` with **no cap** (`:825`). A fix/perf change to one misses the other.
- Columns: `renderLogs` has 10 cols incl. `API Key`/`Endpoint`/`Account`
  (`:817`,`:818`,`:820`); trace has 7 cols and omits those (`:2187`–`:2191`).
- Summary: trace summary adds Tokens + Credits (`:2174`–`:2175`); `renderLogs`
  summary has only total/success/errors (`:797`–`:799`).

Risk: any escaping or formatting fix to one table silently fails to apply to the
other. Recommend extracting a shared `logRowCells(l)` + `logStatusCell(l)` helper.

### C2 — Hardcoded, non-`t()` string in `renderAccounts` shared-credential badge
- `web/app.js:1084`

```
(a.linkedCredentialCount > 1 ? '<span class="badge badge-info" title="Gateway usage is shared across credentials for this Kiro account">Shared account · ' + a.linkedCredentialCount + ' credentials</span>' : '')
```

Two problems vs. the rest of the file: the `title=` and body text are **hardcoded
English** (every other badge routes through `t(...)`), and `a.linkedCredentialCount`
is interpolated raw. It is a server-sent number so there is no injection today, but
it is the one badge that bypasses both i18n and the escape convention. Route the
text through `t()` and wrap the count with the normal numeric formatter.

### C3 — Inline `width:` styles built two inconsistent ways
- Account usage bars: `web/app.js:1104` and `:1110`
  `... style="width:' + usagePct + '%"` — uses the **raw float** `usagePct`
  from `quotaBarPercent` (`:1015`), e.g. `width:73.33333333%`.
- Generic bar helpers: `web/app.js:2044`→`:2046` (`usageBar`) and
  `web/app.js:2261`→`:2265` (`channelWindowBars`) — these round/clamp first
  (`Math.max(2, parseFloat(pct))`, `Math.max(2, rate)`).

All widths are numerically derived and clamped 0–100, so no injection and no gross
misalignment. The confirmed inconsistency: `:1104`/`:1110` emit long-decimal widths
and, unlike the helpers, apply **no `Math.max(2, …)` floor**, so a tiny non-zero
percent renders a hairline fill while the helpers show a 2% minimum. Also note
`:1104`/`:1110` set `style="width:…"` inline *and* carry `data-usage-pct`, which
`applyUsageBars` (`:1006`, called at `:1121`) re-reads to set `el.style.width`
again — the width is written twice. Harmless but redundant; pick one path.

---

## SUSPECTED / fragile (safe today, breaks if a helper ever returns a string)

These interpolate directly into `innerHTML` **without** `escapeHtml`, relying on the
callee returning a pure number/locale-formatted number. Correct now, but one future
edit to any helper (e.g. returning `'N/A <sup>?</sup>'`) turns each into an injection
or layout break.

- `renderAccounts` stat values — `web/app.js:1115`, `:1116`
  `'>' + formatAccountTokens(a) + '<'` / `'>' + formatAccountCredits(a) + '<'`
  (helpers at `:1026`, `:1036` — return `toLocaleString`/`toFixed` or `'—'`).
- `renderAccounts` usage text — `web/app.js:1105`, `:1111` (`.toFixed()` numerics, unescaped).
- `renderAccounts` request count — `web/app.js:1114` (`a.requestCount || 0`, raw).
- Log detail credits cell — `web/app.js:837` and the trace twin `:2207`
  `Number(l.credits).toFixed(4)` interpolated raw.
- `channelStatus` code badges — `web/app.js:2340` `escapeHtml(code) + ': ' + n`
  (`n` is a raw count), and stat values at `:2353`–`:2356` (`formatNumber(...)` raw).
- `detailItem` numeric args — e.g. `web/app.js:1352` (`a.weight||0` as input `value=`),
  `:1374`, `:1377`, `:1384`–`:1388`. `detailItem` itself (`:1329`) *does* `escapeHtml`
  its value, so these are fine; listed only because the inputs are unescaped numerics.

Recommendation: either `escapeHtml()` these for defense-in-depth, or add a comment
contract that the helper returns a plain number.

---

## Confirmed-correct (spot-checked, no action needed)

- Attribute escaping is right everywhere: `title=`/`value=`/`placeholder=`/`aria-label=`/
  `data-*`/dynamic `class=` all use `escapeAttr` — e.g. `:830`, `:835`, `:1075`,
  `:1104` (`data-usage-pct`), `:1345`, `:2118`, `:2203` (`err-badge--`+`escapeAttr`),
  `:2331`, `:2734`, `:2741`, `:2774`, `:2952`, `:4055`, `:4363`.
- `escapeHtml` is **never** used inside a quoted attribute (grep: 0 hits).
- All string body text is escaped: `l.model`/`l.endpoint`/`l.error` (`:835`,`:848`,`:849`),
  `c.region` (`:2348`), `m.id`/`m.description` (`:1415`,`:1417`,`:4481`),
  `item.keyMasked`/`item.name` (`:2097`,`:2098`), emails via `escapeHtml(getDisplayEmail(...))`
  (`:1077`,`:1603`,`:2346`,`:3890`).
- SVG strings (`:1067`–`:1069`, `MODEL_SVGS` `:4382`) and `_svgStyle` (`:4381`) are
  static literals — safe to inline unescaped.

Note: `web/app.js:2770` (`apikey:` entry of `METHOD_ICONS`) shows as `apikey: *** fa-key'`
in the reader — a display redaction of the literal, not a code defect; the value is a
static Font Awesome class, not interpolated data.
