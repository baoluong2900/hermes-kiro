# CSS Quality Audit — `web/styles.css`

Scope: duplicate selectors, overridden/dead rules, and unused (dead) class selectors.
Method: `read_file` + `search_files` only. Usage verified against the two consumers
of this stylesheet — `web/index.html` and `web/app.js` (app.js builds DOM from
`className` string literals, so it was grepped as well). `web/index-legacy.html`
carries its own inline `<style>` and is **not** a consumer of `styles.css`; its
matches were excluded.

File length: 3888 lines. A block of appended "late overrides" lives at lines
~3800–3888 and is the source of most override findings below.

---

## 1. CONFIRMED — rules fully/partially overridden later (earlier declarations are dead)

Later rules of equal specificity appearing further down the file win. The listed
earlier declarations never take effect.

| # | Selector | Earlier rule | Overridden by | Dead declaration(s) |
|---|----------|--------------|---------------|---------------------|
| 1 | `#logoutBtn, #logoutBtn:hover` | **311–316** (`background: var(--destructive); color:#fff; border-color: var(--destructive)`) | **3850–3858** (neutral: `--background`/`--muted`, `--foreground`, `--border`) | Entire 311–316 block — the red/destructive logout styling is fully replaced by the neutral treatment. |
| 2 | `.model-item` | **2670–2679** (`display:grid; grid-template-columns:1fr auto`) | **3646–3655** (`display:flex; align-items:center; gap:0.625rem`) | `display`, `grid-template-columns`, grid-specific `gap` at 2670 are dead; layout is flex. |
| 3 | `.model-name` | **2680–2684** (`font-family: var(--font-mono)`, weight 500) | **3682–3688** (no mono; adds `color`, `line-height`, `word-break`) | `font-family: var(--font-mono)` at 2681 is dead — model names render in sans, not mono. |
| 4 | `.help-block` | **3268–3277** (card look: `background: var(--muted)`, `border:1px solid`, `border-radius`, `padding:0.75rem 0.875rem`) | **3828–3838** (note look: `background:transparent`, `border:0`, `border-left:2px`, `border-radius:0`, different padding/line-height) | The entire 3268 visual treatment (filled muted box) is dead; renders as a left-border note. |
| 5 | `.card-title` | **375–379** (`font-size:0.9375rem`) | **3809–3813** (`font-size:1rem`, adds `letter-spacing`) | `font-size:0.9375rem` at 376 is dead. |
| 6 | `.form-group label` | **635–641** (`font-weight:500`) | **3814–3819** (`font-weight:600`, adds `letter-spacing`) | `font-weight:500` at 638 is dead. |
| 7 | `.card-header` | **366–374** (`padding-bottom:1rem`) | **3844–3847** (`padding-bottom:0.875rem`, new `margin-bottom`) | `padding-bottom:1rem` at 371 is dead. |

Note on #2/#3: `.model-item` is emitted from two different DOM shapes in app.js —
a flat 3-child form (app.js:1414–1417) and a nested form (app.js:4479–4481). Both
now resolve to the flex definition at 3646; the earlier grid definition no longer
applies to either.

---

## 2. CONFIRMED — true duplicate (identical) rule

| Selector | Occurrences | Note |
|----------|-------------|------|
| `.help-block:last-of-type` | **3278–3280** and **3839–3841** | Both declare only `margin-bottom:1.25rem`. Second is fully redundant. |

---

## 3. CONFIRMED — dead CSS (class absent from BOTH `index.html` and `app.js`)

Each was grepped against both consumer files (and confirmed not produced by any
`className` string in app.js). Only self-references inside `styles.css`
(e.g. its own media queries) remain.

| Selector | Defined at | Evidence |
|----------|-----------|----------|
| `.model-badge--text` | **3717** | Only `--image` (app.js:4484) and `--thinking` (app.js:4483) are emitted; `--text` never is. |
| `.stat-sep` | **1268** (+ media override 1304) | No match in index.html or app.js. |
| `.success-emoji` | **3323** | No match in index.html or app.js. |
| `.toolbar-divider` | **3133** (+ media override 3202) | No match in index.html or app.js. `.toolbar-spacer` sibling is a separate selector (not audited as dead). |
| `.microsoft-security-note` | **2366** | No match in either consumer. Sibling `.microsoft-callback-note` IS used (app.js:2987), so this is not a false negative from a shared prefix. |

---

## 4. Reviewed and NOT flagged (intentional / additive / responsive)

These repeat in the selector list but are **not** defects — recorded so they are not re-flagged:

- `html, body` (144) vs `body` (158) vs `body.modal-open` (162): additive, different property sets.
- `select` (398 base) vs `select` (437 appearance) vs `select:focus` (420) vs `select.custom-select-native` (444): additive / distinct selectors.
- `.footer-link:focus-visible` (955 grouped hover+focus) vs (960 outline-only): additive.
- `.tab.active` (814) vs (3804 adds `font-weight`) vs media (3464): additive + responsive.
- `.field-hint-offset` (204 `margin-left`) vs (3821 grouped type styles): additive.
- All `@media` re-declarations (e.g. `.stat-card`, `.btn`, `.container`, `.rule-body`, footer selectors): intentional responsive overrides — out of scope per instructions (responsive/overflow is a separate agent's job).

---

## Ranked summary (highest-confidence first)

1. **`#logoutBtn` destructive block (311–316) dead** — fully overridden by 3850–3858. *(override, confirmed)*
2. **`.help-block` card styling (3268–3277) dead** — fully overridden by 3828–3838. *(override, confirmed)*
3. **`.model-item` grid layout (2670) dead** — overridden by flex at 3646. *(override, confirmed)*
4. **`.model-name` mono font (2681) dead** — overridden at 3682. *(override, confirmed)*
5. **`.card-title` font-size (376), `.form-group label` weight (638), `.card-header` padding (371) dead** — overridden at 3809/3814/3844. *(override, confirmed)*
6. **`.help-block:last-of-type` duplicated** — 3278 ≡ 3839. *(duplicate, confirmed)*
7. **Dead classes**: `.model-badge--text` (3717), `.stat-sep` (1268), `.success-emoji` (3323), `.toolbar-divider` (3133), `.microsoft-security-note` (2366). *(unused, confirmed)*

### Scope caveat (suspected, not exhaustively verified)
The dead-class list covers the candidates that surfaced during the duplicate/override
pass; it is **not** a full per-selector sweep of all ~250 selectors. A complete dead-CSS
census would require grepping every class token against both consumers individually.
Everything listed above was individually verified against `index.html` and `app.js`.
