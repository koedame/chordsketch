# ChordSketch — Design System

**Version 1.0** · English-primary UI · Light theme · Editorial / Professional

ChordSketch is a library of chord sheets with lyrics for **ChordPro** and
**iReal Pro**. A tool for amateurs through professionals to search, edit,
and share music smoothly.

This document is the source of truth for color, typography, space, motion,
components, and tone. Implementation references the tokens defined in
`tokens.css`.

---

## 1. Brand

- **Mark** — A white quill on a crimson color field. It signifies the act
  of writing / inscribing and the symbolism of musical notation. The
  canonical asset is `assets/logo.svg` (vector, 180×180, `#BD1642`
  background); raster derivatives ship as `assets/logo-128.png` (VS Code
  extension icon) and `assets/logo-256.png` (high-DPI / Marketplace
  README headers).
- **Wordmark** — "ChordSketch" set in Noto Sans JP 700. The ja-JP
  localization name (romanized: "Koodo Suketchi") is documented in the
  locale resource file; it does not appear in default English UI surfaces.
- **Clearspace** — At least ¼ of the mark's height on every side. When
  paired with the wordmark, leave ≥ 24px between the two.
- **Minimum size** — 24px (mobile UI) / 32px (print).
- **Background** — Place the mark on white or `--ink-50` only. Never
  overlay it on crimson.

Crimson appears as a large color field **only inside the mark itself**.
Using crimson on large surfaces elsewhere in the product is prohibited.

---

## 2. Color

### 2.1 Crimson — the only accent

A deep red-violet crimson sampled from the logo. Reserved for primary
action, active state, chord symbols, and key signatures.

| Token | Hex | Use |
|---|---|---|
| `--crimson-50`  | `#FDF2F5` | Tint background, error-form wash |
| `--crimson-100` | `#FBE1E8` | Banner wash |
| `--crimson-300` | `#EC8AA3` | Hover accent |
| `--crimson-500` ★ | `#BD1642` | **Brand primary** |
| `--crimson-600` | `#A30F37` | Hover / pressed |
| `--crimson-700` | `#87092C` | Text on tint |
| `--crimson-900` | `#480418` | Dark mode accent |

★ = default (aliased as `--crimson`).

### 2.2 Ink — warm neutrals

Not pure gray. A faint red tint keeps it in harmony with crimson.

| Token | Hex | Role |
|---|---|---|
| `--ink-0`    | `#FFFFFF` | Surface |
| `--ink-50`   | `#FAFAF7` | Canvas (page background) |
| `--ink-100`  | `#F6F4F7` | Hover surface |
| `--ink-200`  | `#E8E6EA` | Hairline / subtle border |
| `--ink-300`  | `#D4D1D6` | Border |
| `--ink-500`  | `#8A8790` | Text-tertiary |
| `--ink-600`  | `#67646D` | Text-secondary |
| `--ink-700`  | `#44424A` | Text-strong (sub) |
| `--ink-1000` | `#0A0A0B` | Text-primary |

### 2.3 Semantic

| Token   | Surface   | Foreground | Use |
|---|---|---|---|
| success | `#E8F3EC` | `#1A6B3A`  | Save / sync complete |
| warning | `#FBF1D9` | `#8A5A07`  | Unsaved / caution |
| danger  | `#FBE1E8` | `#A30F37`  | Error / delete |
| info    | `#E6EEF7` | `#1F4F8A`  | Hint / notification |

### 2.4 Contrast

- Body text on background must meet WCAG AA (≥ 4.5:1).
- `--ink-1000` on `--ink-50` = 18.7:1 ✓
- `#fff` on `--crimson-500` = 6.2:1 ✓
- `--ink-500` is for supporting copy only; never use it for body text.

Ratios verified with the [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/).
Re-measure when a token's hex value changes.

---

## 3. Typography

UI text is sans-serif and monospace. The chart-rendering surface is
the one place a serif is allowed: iReal Pro charts use Source Serif 4
italic for `D.C.` / `D.S.` / `Fine` text marks and the chart header,
matching the engraved-feel of iReal Pro's own charts. Outside the
chart surface, no serifs.

| Family | Role | Weights |
|---|---|---|
| **Noto Sans JP**   | Japanese UI throughout, display | 400 / 500 / 700 / **900** |
| **Inter**          | Latin, numerals, eyebrow labels | 400 / 500 / 600 / 700 / 800 |
| **JetBrains Mono** | Code, ChordPro source, monospaced UI elements | 400 / 600 / **700** |
| **Roboto**         | Chord glyphs (`[G]`, `Am7`) and section letters in chart-rendering surfaces. Chosen for its stable Latin-numeric balance at small sizes. | 400 / 500 / 700 / 900 |
| **Source Serif 4** | iReal Pro chart text marks (`D.C.`, `D.S.`, `Fine`) and chart header. Italic-leaning, evokes engraved sheet music. *Chart surfaces only.* | 400 / 700 / 900 (italic 400) |
| **Bravura Text**   | SMuFL music glyphs — accidentals (♯ ♭), barlines, segno / coda, repeat dots. Used by `chordsketch-render-ireal` and the iReal Pro editor surface. | 400 |

Token aliases in `tokens.css`:
`--font-jp` = body, `--font-display` = display (Noto Sans JP 900),
`--font-latin` = Inter, `--font-mono` = JetBrains Mono,
`--font-chord` = Roboto, `--font-chart-serif` = Source Serif 4,
`--font-music` = Bravura Text (see [ADR-0014](docs/adr/0014-bravura-glyphs-as-svg-paths.md)).

### 3.1 Scale

| Role    | Family         | Weight | Size / Line | Tracking |
|---|---|---|---|---|
| Display | Noto Sans JP   | 900 | 60–72 / 1.05 | `-0.03em` |
| H1      | Noto Sans JP   | 700 | 48 / 53      | `-0.02em` |
| H2      | Noto Sans JP   | 700 | 36 / 40      | `-0.02em` |
| H3      | Noto Sans JP   | 700 | 30 / 36      | `-0.02em` |
| H4      | Noto Sans JP   | 700 | 24 / 32      | `-0.01em` |
| H5      | Noto Sans JP   | 600 | 18 / 26      | `0`       |
| Body    | Noto Sans JP   | 400 | 16 / 27      | `0`       |
| Small   | Noto Sans JP   | 400 | 13 / 22      | `0`       |
| Eyebrow | Inter          | 600 | 12 / 16      | `0`       |
| Mono    | JetBrains Mono | 600 | 14 / 26      | `0`       |
| Meta    | Inter          | 500 | 13 / 22      | `0` tabular-nums |

### 3.2 Chord-sheet typesetting (the heart of the product)

- Chord (`[G]`) = `--crimson-500` + Roboto 700 / 16px (`--font-chord`).
- Lyric = Noto Sans JP 400 / 16–18px.
- Chord and lyric are **stacked vertically** (`flex-direction: column`)
  inside a `.pair`, and `.pair` elements flow as `inline-flex`.
- Section labels (Verse / Chorus / Bridge) use the eyebrow style — no
  border or rule above; vertical rhythm is carried by `--sp-6` /
  `--sp-8` margins on the label.

---

## 4. Space

- **Baseline** — 4pt. Tokens: `--sp-1` (4) → `--sp-32` (128).
- **Radius** — Restrained. `--r-2` (4px / button) and `--r-3`
  (8px / card) carry most of the load. `--r-4` (12px) is reserved for
  modals.
- **Elevation** — Lines first (`--border` = `--ink-200`). Shadows are
  reserved for popovers (e2), modals (e3), and the command-palette
  overlay.
- **Borders are uniform.** A container's border is the same width on
  all four sides. Asymmetric thick borders (e.g., a 3 px crimson top
  border) are not used as an accent device. To call attention, swap
  the border color (e.g., `--crimson-500`) or reposition hierarchy —
  never one thick edge.
- **Container max-widths** — 1280px (app) / 720px (reading) /
  1080px (guides).
- **Grid** — 12 columns, 24px gutter.

---

## 5. Motion

- **Easing** — A single curve, `cubic-bezier(.2, .8, .2, 1)`
  (`--ease-out`). No bounce.
- **Duration** — `--dur-1` 120ms (hover/focus) / `--dur-2` 200ms
  (state) / `--dur-3` 280ms (dialog) / `--dur-4` 400ms (page).
- **`prefers-reduced-motion`** is honored — durations collapse to 0ms
  when set.

---

## 6. Components

Every component depends on tokens in `tokens.css`. Only the minimum
requirements are listed here; visual detail will live in
`design-system.html` and `preview/components-*.html` once
those artifacts are produced.

| Category   | Variants |
|---|---|
| Buttons    | primary / secondary / ghost / danger × sm / md / lg, icon-only, disabled |
| Forms      | input / select / textarea / segmented / checkbox / radio, focus = `--focus-ring` |
| Cards      | song / setlist / featured (uniform 1px `--crimson-500` border; surface, type, and other tokens unchanged) |
| Badges     | status (4 semantic + crimson + muted) / key (mono on ink-1000 or crimson) / genre (pill) |
| Avatars    | 24 / 28 / 36 / 48 px, stacked +N |
| Navigation | top nav 56px, tabs (underline + count) |
| Modal      | 12px radius, e3 elevation, footer `--ink-50` wash to demarcate |
| Table      | eyebrow header, tabular-nums, hover row = `--ink-50` |
| Toast      | `--ink-1000` base / success / danger / warning, action button uses inherited foreground + underline (no color shift) so contrast holds on every variant |
| Progress   | 6px bar / spinner / skeleton |

---

## 7. Voice & Tone

- **Audience** = capable musicians. Strip ornament; be precise.
- UI labels and headings are short noun phrases. System messages are
  declarative sentences. No filler words.
- Domain terms (Capo, Verse, Chorus, Bridge, ChordPro, iReal Pro) are
  **not translated**.
- Quotation marks: straight `"…"` only. Curly `“…”` and Japanese
  `「…」` appear only inside localized ja-JP strings, never in source.
- **No emoji.** Icons are line icons (1.5px stroke).
- Avoid exclamation marks. State errors plainly: what happened, and
  the next step.

| Avoid | Use |
|---|---|
| Oops! Couldn't save your song… 🥲 | Save failed. Check your connection. |
| Let's create a new song! | New song |
| Try adding your very first song now! | Add your first song |

---

## 8. Implementation

```html
<link rel="stylesheet" href="tokens.css">
```

```css
.btn-primary {
  background: var(--crimson);
  color: var(--fg-on-crimson);
  border-radius: var(--r-2);
  padding: var(--sp-2) var(--sp-4);
  font: 500 var(--fs-14)/1 var(--font-sans);
  transition: background var(--dur-1) var(--ease-out);
}
```

---

## 9. Related files

All design-system artefacts live under `design-system/` at the
repo root. Paths in this section are relative to `DESIGN.md`
itself (i.e. relative to the `design-system/` folder). The
brand-mark assets stay at the repo root because they are also
consumed by package READMEs and the VS Code Marketplace
listing — see `.claude/rules/package-documentation.md`.

The runtime playground at `packages/playground/` consumes this
design system as both an end-user evaluation surface (try the
parser / renderer live in a browser) and a developer test surface
(exercise every wasm export, every render format, every input
format). Any new component or token that lands here must be
mirrored to `packages/ui-web/src/style.css`,
`packages/ui-irealb-editor/src/style.css`, and the `--cs-*` block
in `packages/react/src/styles.css` — those three are the runtime
copies that actually paint the playground UI and any
`@chordsketch/react`-consumer's host. Class names used in
`design-system/ui_kits/web/editor.html` (`.topnav`, `.toolbar`,
`.tool-group`, `.segmented`, `.pane`, `.pane-head`, `.status`,
`.btn` + variants) are the canonical chrome vocabulary; the
playground re-uses them verbatim so contributors recognise the
layout in either place.

| File | Contents |
|---|---|
| `tokens.css` | Source of truth for every design token |
| `index.html` | Long-form visual guide (single page) |
| `ui_kits/web/library.html` | Full-screen sample — library |
| `ui_kits/web/viewer.html` | Full-screen sample — chord sheet viewer |
| `ui_kits/web/editor.html` | Full-screen sample — ChordPro split editor (source + live preview) |
| `ui_kits/web/editor-irealb.html` | Full-screen sample — iReal Pro bar-grid editor with metadata header and bar inspector |
| `preview/index.html` | Component preview index |
| `preview/components-buttons.html` | Buttons — variants, sizes, icon-only, disabled, loading |
| `preview/components-forms.html` | Inputs, textarea, select, segmented, check, radio, switch |
| `preview/components-cards.html` | Song / setlist / accent cards |
| `preview/components-badges.html` | Status, key, format, genre badges |
| `preview/components-avatars.html` | Avatars at 24 / 28 / 36 / 48 px, stacked +N |
| `preview/components-navigation.html` | Top nav, tabs, breadcrumbs, sidebar |
| `preview/components-modal.html` | Confirm dialog, form modal, command palette |
| `preview/components-table.html` | Library table, stats table |
| `preview/components-toast.html` | Default, success, danger, warning, stack |
| `preview/components-progress.html` | Linear bar, spinner, skeleton |
| `../assets/logo.svg` | Brand mark (vector, 180×180, `#BD1642` field) |
| `../assets/logo-128.png` | Raster derivative — VS Code extension icon |
| `../assets/logo-256.png` | Raster derivative — Marketplace README header / high-DPI contexts |

---

## 10. Changelog

- **v1.0** — Initial. Crimson + Warm Ink + Noto Sans JP / Inter /
  JetBrains Mono / Roboto / Source Serif 4 / Bravura Text. Source
  Serif 4 is restricted to chart-rendering surfaces (iReal Pro); UI
  text remains sans-serif and monospace.
