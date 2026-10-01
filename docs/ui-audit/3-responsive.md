# UI Audit 3 — Responsive / Overflow Risk (Kiro-Go admin UI)

Scope: `web/styles.css` (3888 lines) + `web/index.html`. Target viewport: narrow mobile (≤360px, with notes for 320px / iPhone-SE and the 721–820px tablet gap). Findings only — no source modified.

Breakpoints in play: `@media (max-width:760px)` (1 block), `(max-width:720px)` (5 blocks — the main mobile layer, incl. 3330+), `(max-width:640px)` (several), `(max-width:420px)`, `(max-width:380px)`, plus `(min-width:640px)` (rule-body). Anything whose fixed/min width is NOT reduced inside these blocks is a candidate for page-wide horizontal scroll.

Pre-existing fixes (NOT re-reported): `.logs-table td` nowrap + `.logs-list` dual-axis scroll; the mobile `.btn { white-space:normal; max-width:100% }` wrap rule at styles.css:3380.

---

## CONFIRMED — will overflow at/near 360px

### C1. `#apiKeyTraceSelect` pinned to 16rem (256px), no mobile reduction
- `web/index.html:272` — `<select ... class="w-64!" style="min-width:16rem;">`
- The inline `min-width:16rem` AND the `w-64!` utility (16rem, `!important`) both pin the control to **256px**. It lives in a `flex ... flex-wrap:wrap` row (index.html:271) inside `.form-group` → `.card`.
- `flex-wrap` only lets the sibling button drop below; it cannot shrink a single flex item under its own `min-width`. No `(max-width:720px)` rule targets this id (the 720 block only resizes `#filterSearch` / `#filterStatusSelect`).
- Math: at 360px vp, card content ≈ 360 − 32 (container `padding:0 1rem` at 3372) − ~40 (card padding) ≈ **288px** → 256px fits but tight. At 320px vp → ~248px available < 256px → **overflows the card and forces page h-scroll.** Confirmed on iPhone-SE-class widths; borderline at 360.

### C2. `#channelsWindowSelect` forced to 10rem inside a 3-col grid
- `web/index.html:292` — `<select ... class="w-40!" style="min-width:9rem;">` → effective width **10rem/160px** (`w-40!` width wins over the 9rem min).
- Sits in `.card-actions` (index.html:289). At `(max-width:720px)` `.card-actions` becomes `grid-template-columns: repeat(3, minmax(0,1fr))` (styles.css:3173-3176). The grid's `.card-actions > .btn { width:100% }` rule (3182) covers buttons, **but a `<select>` is not a `.btn`**, so it keeps its 160px `!important` width.
- At 360px vp a 1fr track ≈ 96px; the 160px select cannot shrink into it → **cell overflow / horizontal scroll.** Confirmed for the Channel Status tab header on all phone widths. (Same structural gap would bite any non-`.btn` fixed-width child dropped into `.card-actions`.)

---

## SUSPECTED — tablet-range or edge, not a clean ≤360 break

### S1. `.app-header-inner` default 3-col grid is unwrappable (721–~820px gap)
- `web/styles.css:1050-1058` — `grid-template-columns: auto minmax(0,1fr) auto`, `gap:2rem`, `padding:0 2rem`; `.topbar-actions` is `flex-wrap:nowrap; white-space:nowrap` (1063-1064).
- Mobile is safe: the `(max-width:720px)` block (3393) re-lays it to a 2-col `max-width:28rem` grid with stacked nav. But **between 721px and the point where auto brand + nowrap actions + 2×2rem gap + 2×2rem padding exceed the viewport**, there is no intermediate breakpoint — risk of clipping/scroll on small tablets / large phones in landscape. Not a ≤360 issue.

### S2. `.proxy-inventory-row > span` min-width 200px
- `web/styles.css:184` — `flex:1; min-width:200px; overflow-wrap:anywhere;`. Parent is `flex-wrap:wrap` (182), so spans stack; one 200px span fits ~288px content at 360. `overflow-wrap:anywhere` handles long tokens. Safe at 360, would break only below ~232px. Low risk, no breakpoint guarding it.

### S3. `.machine-id-row input` min-width 12rem (192px)
- `web/styles.css:2663`, parent `flex-wrap:wrap` (2659). Wraps to full width; 192px fits. Safe at 360; flagged only as an un-breakpointed fixed min.

### S4. `.input-row > input/textarea` min-width 8rem (128px)
- `web/styles.css:3316`, parent `flex-wrap:wrap` (3311). Fits comfortably. Lowest risk.

---

## CHECKED — safe (self-scrolling, overridden, or auto-collapsing)

- `.api-code` — `white-space:nowrap; overflow-x:auto` (styles.css:2542-2543) self-scrolls; mobile override to `normal`/`anywhere` at 3357-3363. Safe.
- `.api-endpoint-item` grid `minmax(9rem,13rem) minmax(0,1fr)` (2469) — min total ~160px; collapsed to `1fr` at 720 (3347). Safe.
- `.test-log-line` grid `5.25rem minmax(0,1fr)` (2837) — collapsed to `1fr` at 640 (2873). Safe.
- `.models-grid` / `.model-group-grid` / lines 3578, 3638, 3729 — all `auto-fill, minmax(1Xrem,1fr)` → collapse to single column when narrow. Safe.
- `.custom-select-filter { width:8rem }` (465) — overridden to `width:100%` at 720 (3230-3232). Safe.
- `.stats-grid` 4-col → 2-col at 640 (1196); `.container`/header/footer inners `max-width:1200px` with fluid padding. Safe.
- `.modal-content width:min(640px,90vw)` (1990) + 720 override to 90vw (3335). Safe.

---

## Recommended order of fix (confirmed only)
1. **C1** `web/index.html:272` — drop/relax the 16rem pin on `#apiKeyTraceSelect` for ≤720 (e.g. `width:100%; min-width:0`).
2. **C2** `web/index.html:292` + `styles.css:3173` — make `#channelsWindowSelect` (and generically `.card-actions > select`) `width:100%; min-width:0` inside the mobile `.card-actions` grid, mirroring the existing `.card-actions > .btn` rule.
