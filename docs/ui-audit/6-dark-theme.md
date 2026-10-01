# UI Audit 6 — Dark Theme & Color-Contrast Correctness

Scope: `web/styles.css` (3888 lines), cross-checked against `web/app.js` (theme logic) and `web/index.html` (DOM attributes). Findings only — no source modified.

## How theming actually works (the key fact)

- Theme is applied by toggling the **`.dark` class on `<html>`** — `app.js:401` `root.classList.toggle('dark', resolved === 'dark')`.
- `app.js:402` sets `root.dataset.themePref` → attribute **`data-theme-pref`** (note the `-pref` suffix).
- `app.js:404` sets `data-theme` **only on `.theme-toggle` buttons**, as a visual-state hint for the toggle icon. `index.html:55,130` confirm `data-theme="system"` lives on the toggle buttons, not on `<html>`/`<body>`.
- `<html>` carries only `lang` + the `.dark` class + `data-theme-pref`. **No element that is an ancestor of page content ever has `data-theme="dark"`.**

Consequence: any rule written as `[data-theme="dark"] .component` is a descendant selector whose ancestor match never exists outside the toggle button. These rules are **dead CSS**. The correct, working convention in this file is `.dark .component` (used correctly at lines 1640, 2582, 2586, 2591).

---

## CONFIRMED findings (ranked by severity)

### C1 — Dark-mode overrides use the wrong selector `[data-theme="dark"]` → dead CSS (HIGH)
All intended dark treatments for status/error chips never apply.

| Line | Rule |
|------|------|
| 1405 | `[data-theme="dark"] .log-status--success { background:#052e16; color:#86efac; }` |
| 1406 | `[data-theme="dark"] .log-status--error { background:#450a0a; color:#fca5a5; }` |
| 1421 | `[data-theme="dark"] .err-badge--quota { background:#451a03; color:#fde68a; }` |
| 1422 | `[data-theme="dark"] .err-badge--auth { background:#450a0a; color:#fca5a5; }` |
| 1423 | `[data-theme="dark"] .err-badge--suspended { background:#450a0a; color:#fca5a5; }` |
| 1424 | `[data-theme="dark"] .err-badge--overage { background:#431407; color:#fdba74; }` |
| 1425 | `[data-theme="dark"] .err-badge--profile { background:#1e1b4b; color:#a5b4fc; }` |

Root cause: selector/convention mismatch (`[data-theme="dark"]` vs the actual `.dark` class on `<html>`). The "good pattern" cited near line 1396 is itself broken for the same reason.
Effect: in dark mode the light pastel definitions below (C3) win instead. They set both `background` and `color`, so text stays legible — this is a **visual inconsistency / dead-code bug**, not a raw text-contrast failure. Fix is mechanical: change the 7 selectors to `.dark .log-status--… / .dark .err-badge--…`.

### C2 — `--border-color` is referenced but never defined → always falls back to `#333` (MEDIUM)
- `styles.css:181` `.proxy-inventory-row` → `border-bottom: 1px solid var(--border-color, #333);`
- `--border-color` is defined nowhere (the token is `--border`: `#e4e4e4` light / `#242424` dark). Repo-wide the string appears exactly once — this usage.
Effect: the border is hard-wired to `#333` in both themes. In **light** mode that is a heavy dark-gray line on a light surface (wrong; should track `--border #e4e4e4`). In dark mode `#333` happens to sit near `--border #242424`, so the bug is masked. Fix: use `var(--border)`.

### C3 — `.badge-power` background `#111827` disappears into dark surfaces (MEDIUM)
- `styles.css:716` `.badge-power { background:#111827; color:#fff; border-color:#111827; }`
- `#111827` (near-black) sits on `--card #090909` / `--background #000000` in dark mode. The pill shape has almost no separation from the surface (white text remains readable, but the chip stops reading as a chip). No dark override exists.

### C4 — `.badge` family: hardcoded colors, zero token use, no dark adaptation (LOW–MEDIUM)
`styles.css:660–723` — `.badge`, `.badge-success`, `-warning`, `-info`, `-muted`, `-error`, `-banned`, `-suspended`, `-free`, `-pro`, `-proplus`, `-power`, `-trial` all set literal `background`/`color:#ffffff`/`border-color` with no `var()` and no `.dark` override.
- Self-contained saturated-bg + white text ⇒ text contrast is fine in both themes, so most are cosmetic/token-hygiene issues.
- Notable literals: `.badge` default `#525252` (660), `.badge-info #2563eb` (676, duplicates `--info` intent), `.badge-power #111827` (716 — see C3). These ignore the theme tokens entirely and won't shift between themes.

### C5 — `.batch-count` hardcoded `#2563eb` / `#ffffff`, non-adaptive (LOW)
- `styles.css:3153–3154` `background:#2563eb; color:#ffffff;` with no token and no dark override.
- Contrast is fine (white on blue) in both themes; purely non-adaptive. Should use `var(--info)` / `var(--info-foreground)`.

### C6 — `#logoutBtn` hardcoded `color:#ffffff` (LOW / token hygiene)
- `styles.css:314` sets `color:#ffffff` while `background:var(--destructive)`.
- `--destructive-foreground` is `#ffffff` in both themes, so the result is functionally identical today; it is a hardcode that should be `var(--destructive-foreground)` for consistency. Note dark `--destructive #ff5b5b` with white text is a lower (but still acceptable) contrast pairing.

---

## Cleared (checked, NOT bugs) — so they aren't re-flagged

- `styles.css:1535–1536, 1544–1545` `#000` inside `.login-meta::before` — these are stops of a `mask-image` linear-gradient. The color only supplies mask alpha; it is never painted. Not a theme/contrast issue.
- `styles.css:1158, 1167` `var(--success, #0f766e)` — `--success` is defined for both themes; the fallback is inert and harmless.
- `styles.css:1420` `.err-badge--unknown { background:var(--muted); color:var(--muted-foreground); }` — correctly tokenized, adapts automatically.
- Working `.dark` overrides at 1640 / 2582 / 2586 / 2591 — correct convention, no action.

---

## Undefined-token sweep (task part 2)

Every `var(--…)` in `styles.css` resolves to a token defined in `:root` (6–59), `.dark` (61–96), or the `@theme` bridge (99–130) — **except** `--border-color` (C2). That is the only undefined custom-property reference in the file.

## Summary

- **Confirmed, highest impact:** C1 (7 dead `[data-theme="dark"]` rules — entire intended dark styling of log/error chips never applies) and C2 (undefined `--border-color`, wrong border in light mode).
- **Confirmed, surface-contrast:** C3 (`.badge-power #111827` vanishes on dark surfaces).
- **Confirmed, non-adaptive / hygiene:** C4 (badge family), C5 (batch-count), C6 (logout button).
- Shared root cause for C1: component dark overrides must use `.dark .selector`, not `[data-theme="dark"] .selector`.
