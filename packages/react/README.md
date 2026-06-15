<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/react

React component library for embedding
[ChordPro](https://www.chordpro.org/) **and**
[iReal Pro](https://www.irealpro.com/) editors + previews in a few
lines of React, powered by
[`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm).

`@chordsketch/react@0.3.0` consolidates the component surface into
three explicit tiers (#2527 / #2533) and removes the ambiguous
"Editor" suffix from Tier 1 atoms. Tier 3 composed editors are now
the only components that carry an "Editor" suffix. ChordPro and
iReal Pro both expose the same three-tier shape so consumers can
choose the surface that matches their host.

## Component layout (three tiers)

| Tier | Purpose | ChordPro | iReal Pro |
|------|---------|----------|-----------|
| **Tier 1 atoms** | Single-responsibility primitives | `<ChordSheet>`, `<ChordTextarea>`, `<ChordSourceArea>`, `<ChordDiagram>`, `<Transpose>`, `<PdfExport>`, `<SplitLayout>`, `<RendererPreview>` | `<IrealBarGrid>`, `<IrealPreview>` |
| **Tier 2 preview-with-controls** | Preview surface with built-in format / transpose controls — host owns the source | `<ChordProPreview>` | — (use `<IrealPreview>` directly) |
| **Tier 3 composed editor** | Opinionated all-in-one editor + preview shell | `<ChordProEditor>` | `<IrealProEditor>` |

### Consumer-to-tier mapping

`<ChordProEditor>` and `<IrealProEditor>` are the **recommended
Tier 3 all-in-one surfaces** for external integrators — they ship
the playground / desktop UX out of the box and are the right
default for most embedders. The in-repo playground and the Tauri
desktop app deliberately compose Tier 1 / Tier 2 components into
app-specific layouts so they can own their own chrome (page
routing in the playground; Tauri menu + tree-sitter editor in the
desktop). External consumers without those constraints should
reach for the Tier 3 components first.

| Consumer | ChordPro components | iReal Pro components |
|----------|---------------------|----------------------|
| Playground page (this repo) | Composes Tier 1 atoms (`<RendererPreview>`, `<Transpose>`, ...) into a custom layout | Composes the iReal Pro atoms similarly |
| Tauri desktop app | `<ChordProPreview>` (Tier 2) + a local `<ChordProDesktopEditor>` (CodeMirror 6 + `tree-sitter-chordpro`) | `<IrealPreview>` (Tier 1) + a local `<IrealGridEditor>` wrapping `@chordsketch/ui-irealb-editor` |
| VS Code WebView preview | `<ChordProPreview>` (Tier 2) | `<IrealPreview>` (Tier 1) |
| External React consumers (recommended) | `<ChordProEditor>` (Tier 3) — opinionated all-in-one | `<IrealProEditor>` (Tier 3) — opinionated all-in-one |
| External React consumers (custom layout) | Compose Tier 1 atoms (`<ChordSourceArea>` / `<ChordTextarea>` + `<RendererPreview>` or `<ChordProPreview>`) | Compose `<IrealBarGrid>` + `<IrealPreview>` |

Tier 1 atoms never carry an "Editor" suffix — they are
single-responsibility primitives. `<ChordTextarea>` does include a
built-in preview pane (the "Textarea" name reflects the editor
surface technology, not the absence of a preview); `<ChordSourceArea>`
is the CodeMirror-backed source-edit surface without a preview.
`<IrealBarGrid>` is the iReal Pro bar-grid editor surface alone.
Tier 3 composed editors (`<ChordProEditor>`, `<IrealProEditor>`)
are the only components whose name carries an "Editor" suffix; they
each compose multiple Tier 1 / Tier 2 surfaces into the opinionated
all-in-one shell.

## Installation

[![npm](https://img.shields.io/npm/v/@chordsketch/react)](https://www.npmjs.com/package/@chordsketch/react)

Replace `VERSION` with the current version from the badge above.

```bash
npm install '@chordsketch/react@VERSION' react react-dom
```

`@chordsketch/wasm` is declared as a regular `dependency`, so npm
installs it automatically as a transitive dependency of
`@chordsketch/react`; the wasm module is then lazy-loaded on first
render. Hosts do not install it separately and do not need to call
`init()`. `react` / `react-dom` are **peer dependencies** (React 18
or newer).

The PDF / PNG export bundle ships separately as the heavy
`@chordsketch/wasm-export` peer (~6 MB gzipped). Install it
alongside this package **only** if you use the `<PdfExport>` /
`usePdfExport` surface; it is lazy-loaded the first time you call
the export.

```bash
# Optional — only needed for <PdfExport> / usePdfExport.
npm install @chordsketch/wasm-export
```

### Peer dependency compatibility

| Peer | Required range | Notes |
|------|----------------|-------|
| `react` | `>=18` | Both 18.x and 19.x are supported. |
| `react-dom` | `>=18` | Track the `react` major. |
| `@chordsketch/wasm` | `^0.5.0` (runtime dep) | Bundled as a regular dependency; hosts can override at hoist time if they want a specific minor. |
| `@chordsketch/wasm-export` | `^0.5.0` (optional peer) | Required for `<PdfExport>` / `usePdfExport`. Lazy-loaded on first export. |

### Platform compatibility

| Platform | Status |
|---|---|
| Browsers (evergreen Chromium / Firefox / Safari) | Supported — uses the `web` build of `@chordsketch/wasm`. |
| Node.js 18+ (SSR) | Renderer hooks work via the `node` build of `@chordsketch/wasm`. Editor components mount on the client (`'use client'` boundary in Next.js — see [Next.js notes](#nextjs--ssr) below). |
| Bun / Deno | Best-effort — both expose the Node.js `import('@chordsketch/wasm')` entry, but no CI coverage today. |
| React Native / Hermes | Not supported — depends on the browser / Node WebAssembly loaders. |

## Usage

### `<ChordSheet>` — flagship render component

```tsx
import { ChordSheet } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

export function Sheet() {
  return <ChordSheet source={source} transpose={0} />;
}
```

`format="html"` (default) parses the ChordPro source via
`@chordsketch/wasm`'s `parseChordpro` export and walks the AST
into a React tree directly through the `chordpro-jsx` walker.
No HTML string injection is involved on this path — every
element reaches the DOM through React reconciliation, so the
output is amenable to ordinary React composition (selectable
text spans, hover affordances, snapshot tests). The walker
mirrors the DOM contract `chordsketch-render-html` produces
(`.song`, `.line`, `.chord-block`, `<section class="…">`,
`<p class="comment">`, etc.) so the bundled
`@chordsketch/react/styles.css` lights up unchanged. See
[ADR-0017](https://github.com/koedame/chordsketch/blob/main/docs/adr/0017-react-renders-from-ast.md)
for the architectural split.

`format="text"` renders the plain-text chords-above-lyrics
output inside a `<pre>`; pick that variant if you need an
even-more-conservative preview that avoids the JSX walker
entirely.

**Trust boundary note.** The walker enforces the same URI-scheme
blocklist (`javascript:`, `vbscript:`, `data:`, `file:`,
`blob:`) `chordsketch-render-html` applies, so image directives
with dangerous schemes drop out of the output the same way they
do on the static-HTML side. Delegate sections (`{start_of_abc}`,
`{start_of_ly}`, `{start_of_musicxml}`, `{start_of_textblock}`)
are tracked as a follow-up — the walker currently ignores their
bodies rather than rendering them. If you accept untrusted
ChordPro and need full delegate-section rendering today, drive
the static `chordsketch-render-html` output yourself and embed
it in your own iframe.

Errors are surfaced via an inline `role="alert"` above the
render by default. Pass `errorFallback={(err) => <YourJsx/>}` to
customise — any ReactNode works under both `format` values
because the error lives in a sibling element of the rendered
output. `errorFallback={null}` hides errors entirely and lets
the stale previous render stay visible.

### `useChordRender` — hook for bespoke renderers

```tsx
import { useChordRender } from '@chordsketch/react';

const { output, loading, error } = useChordRender(source, 'html', {
  transpose: 2,
});
```

Same render pipeline as `<ChordSheet>` but exposed as raw state —
wire the output into a custom container (e.g. a diff view, a
multi-pane preview). The renderer is memoised against
`(source, format, transpose, config)`, so re-renders with
unchanged inputs do not re-parse.

### `<ChordTextarea>` — split-pane textarea + live preview (Tier 1 atom)

```tsx
import { ChordTextarea, useTranspose } from '@chordsketch/react';

export function Editor() {
  const { value: transpose, setValue: setTranspose } = useTranspose();
  return (
    <ChordTextarea
      defaultValue="{title: My Song}\n[G]Hello"
      transpose={transpose}
      onTransposeChange={setTranspose}
    />
  );
}
```

The left pane is a plain `<textarea>` (spell-check / auto-correct
disabled so ChordPro tokens don't trigger browser corrections),
the right pane is a `<ChordSheet>` that re-renders a debounced
copy of the source (default 250 ms). Despite the "Textarea" name
this atom DOES include a live preview pane — the name reflects
the editor surface technology (a plain `<textarea>`), not the
absence of a preview. Pair with `<ChordSourceArea>` if you want
CodeMirror highlighting, or with `<ChordProPreview>` for a
preview-only Tier 2 surface.

Supports both controlled (`value` + `onChange`) and uncontrolled
(`defaultValue`) modes, plus keyboard shortcuts **Ctrl+ArrowUp /
Ctrl+ArrowDown** (Cmd on macOS) to fire `onTransposeChange` — wire
that callback to the `setValue` from `useTranspose()` to get live
transposition without leaving the editor. Registering
`onTransposeChange` suppresses the browser's default
text-navigation for those key combinations (Firefox normally moves
the caret to start/end-of-paragraph); omit the prop if the browser
default is preferred.

`readOnly`, `previewFormat="text"` (preview inside `<pre>`
instead of HTML), `config`, custom `errorFallback`, and
`transposeMin` / `transposeMax` bounds for the shortcuts are all
passed through. Pass `debounceMs={0}` in tests to make the
preview re-render synchronously.

The textarea receives a default `aria-label="ChordPro editor"`
so screen-reader users hear an actual name rather than falling
back to the placeholder (which WAI-ARIA does not treat as an
accessible name). Override via the `textareaAriaLabel` prop when
a visible `<label>` provides a better name.

### `<ChordSourceArea>` — CodeMirror source editor (Tier 1 atom)

```tsx
import { ChordSourceArea } from '@chordsketch/react';

export function SourcePane({ source, onChange }) {
  return (
    <ChordSourceArea
      value={source}
      onChange={onChange}
      placeholder="Paste your ChordPro here…"
    />
  );
}
```

CodeMirror 6 with line numbers, regex-based syntax highlighting
(chords / directives / comments), bracket matching, history, search,
and indent-with-tab. Adds ~150 KB of editor runtime in exchange for
the rich keymaps — pick `<ChordTextarea>` if bundle size is the
primary constraint. `<ChordSourceArea>` does NOT include a preview
pane; compose with `<ChordProPreview>` / `<RendererPreview>` for the
editor + preview split, or use `<ChordProEditor>` for the
opinionated all-in-one Tier 3 shell.

### `<ChordProPreview>` — preview-with-controls (Tier 2)

```tsx
import { ChordProPreview } from '@chordsketch/react';

export function Embedded({ source }) {
  return <ChordProPreview source={source} defaultFormat="html" />;
}
```

The right-side surface for hosts that bring their own ChordPro
source (e.g. VS Code's WebView preview, an embedded docs viewer)
but want the same in-pane controls the playground exposes without
composing them by hand: format `<select>` (HTML / Text / PDF) +
`<Transpose>` control. Both axes support controlled and
uncontrolled state independently — supply `format` + `onFormatChange`
to lift format state, or only `defaultFormat` to keep it inside the
component (same for `transpose` / `onTransposeChange`).

Pass `formats={['html', 'text']}` to restrict the format menu;
useful for hosts that do not ship `@chordsketch/wasm-export` and
should not let users pick PDF.

### `<ChordProEditor>` — composed editor + preview (Tier 3)

```tsx
import { ChordProEditor } from '@chordsketch/react';

export function Page() {
  return <ChordProEditor defaultSource="{title: Hello}" />;
}
```

The all-in-one shell — composes `<ChordSourceArea>` (CodeMirror) on
the left and `<ChordProPreview>` (format select + transpose +
renderer) on the right via `<SplitLayout>`. Source / format /
transpose all support both controlled and uncontrolled modes. Pass
the corresponding `value` + `onChange` pair to lift state into the
parent; pass only `default*` to keep state inside the component.
Use `<ChordProEditor>` when you want the playground / desktop UX
out of the box; compose Tier 1 atoms directly when you need a
fully custom layout.

### `useDebounced` — general-purpose debouncer

```tsx
import { useDebounced } from '@chordsketch/react';

const debouncedQuery = useDebounced(rawQuery, 300);
```

Returns a value that lags the input by at most `delay` ms.
`delay <= 0` bypasses the debounce and passes the input through
synchronously (used internally by `<ChordTextarea>` in tests).

### `<ChordDiagram>` — guitar / ukulele / piano voicings

```tsx
import { ChordDiagram } from '@chordsketch/react';

export function Voicing() {
  return (
    <>
      <ChordDiagram chord="Am" instrument="guitar" />
      <ChordDiagram chord="C" instrument="ukulele" />
      <ChordDiagram chord="Dm7" instrument="piano" />
    </>
  );
}
```

Looks up the chord in the same voicing database the Rust HTML
renderer uses (156 built-in voicings: 60 guitar, 36 ukulele,
60 piano) and returns inline SVG. The SVG inherits
`currentColor`, so the diagram picks up the host text colour and
works in dark/light themes without extra styling.

`instrument` accepts `"guitar"`, `"ukulele"` (alias `"uke"`), or
`"piano"` (aliases `"keyboard"`, `"keys"`). Unknown chords — or
known chords the database has no voicing for — render
`notFoundFallback` (default: an inline `role="note"` that
surfaces the chord name so page readers still see "Am — no
guitar voicing in the built-in database"). Unsupported
instruments surface via `errorFallback` (default: inline
`role="alert"`; pass `errorFallback={null}` to hide).

### `useChordDiagram` — hook for bespoke renderers

```tsx
import { useChordDiagram } from '@chordsketch/react';

const { svg, loading, error } = useChordDiagram('Am', 'guitar');
```

Returns the raw SVG string (or `null` when not in the database),
plus loading / error state. Useful for hosts that want to embed
the diagram inside custom markup (tooltip, popover, etc.).

### `<PdfExport>` — one-click PDF export

```tsx
import { PdfExport } from '@chordsketch/react';

const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

export function SaveButton() {
  return (
    <PdfExport source={source} filename="amazing-grace.pdf">
      Export PDF
    </PdfExport>
  );
}
```

While the render is in flight the button is `disabled` and
`aria-busy="true"` so assistive tech surfaces the loading state.
`onExported(filename)` and `onError(err)` callbacks are available
for imperative handlers (analytics, toasts). All the standard
`<button>` attributes (`className`, `style`, `type` override,
`id`, …) are forwarded.

### `usePdfExport` — hook for bespoke UIs

```tsx
import { usePdfExport } from '@chordsketch/react';

export function SaveDropdownItem({ source }: { source: string }) {
  const { exportPdf, loading, error } = usePdfExport();
  return (
    <>
      <button onClick={() => exportPdf(source, 'song.pdf')} disabled={loading}>
        {loading ? 'Preparing…' : 'Save as PDF'}
      </button>
      {error ? <p role="alert">{error.message}</p> : null}
    </>
  );
}
```

The hook lazy-loads `@chordsketch/wasm` on first call and caches
the initialised module for subsequent calls, so repeated exports
do not re-run WASM init.

### Transposition

Both the component and the hook accept a third `options` argument
forwarded to the underlying WASM renderer:

```tsx
<PdfExport source={source} filename="song-up-2.pdf" options={{ transpose: 2 }} />
await exportPdf(source, 'ukulele-preset.pdf', { config: 'ukulele' });
```

### `<Transpose>` — accessible transposition control

```tsx
import { Transpose, useTranspose } from '@chordsketch/react';

export function Controls() {
  const { value, setValue } = useTranspose();
  return <Transpose value={value} onChange={setValue} />;
}
```

The component renders a native `<select>` whose options list every
semitone offset, highest-first (`+6 … 0 … -6`); keyboard and
screen-reader support come from the native select. The default
option range is `±6` semitones — narrower than the feature ceiling
`TRANSPOSE_MIN` / `TRANSPOSE_MAX` (`±11`) — so hosts that want a
wider range pass explicit `min` / `max` props (down to `-11` /
up to `+11`). The controlled `value` is resolved to the nearest
rendered option at render time (so an out-of-range or off-step
value still selects a real option), and the hook's own `setValue`
clamps into `[min, max]`.

### `useTranspose` — state helper for custom UIs

```tsx
import { useTranspose } from '@chordsketch/react';

const { value, increment, decrement, reset, setValue } = useTranspose({
  initial: 0,
  min: -11,
  max: 11,
});
```

All update functions clamp into `[min, max]`. `reset()` returns
to the initial value, not necessarily zero. `increment` /
`decrement` accept an optional step; `setValue` accepts any
number (including `NaN`, which collapses to `min`) so direct
binding to a numeric input is safe.

### `<IrealProEditor>` — composed iReal Pro editor + preview (Tier 3)

```tsx
import { IrealProEditor } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const URL =
  'irealb://Autumn%20Leaves%3D%5BT44Cm7%20%7C%20F7%20%7C%20BbMaj7%20%7C%20EbMaj7%20%5D%3DJoseph%20Kosma%3DJazz%20Ballad%3DC';

export function Chart() {
  return <IrealProEditor defaultValue={URL} />;
}
```

The composite shows the editor pane (header form + interactive bar
grid + URL textarea) next to the SVG preview. Pass `source` +
`onChange` for controlled use; `hidePreview`, `hideBars`, and
`hideUrl` trim the layout for narrower hosts.

### `<IrealBarGrid>` — bar-grid editor surface (Tier 1 atom)

```tsx
import { useState } from 'react';
import { IrealBarGrid } from '@chordsketch/react';

export function ChartEditor() {
  const [url, setUrl] = useState('');
  return <IrealBarGrid source={url} onChange={setUrl} />;
}
```

Edits to title / composer / style / key root + accidental + mode /
time numerator + denominator / tempo / transpose round-trip through
`@chordsketch/wasm`'s `parseIrealb` / `serializeIrealb` and fire
`onChange` with the new URL. The bar grid is fully interactive per
[ADR-0020](https://github.com/koedame/chordsketch/blob/main/docs/adr/0020-ireal-pro-react-surface.md):

- **Structural editing.** Per-section rename / move up / move
  down / delete + a `+ Add section` trailer; per-bar move left /
  move right / delete + a `+ Add bar` trailer. The default
  section-label prompt uses `window.prompt`; pass
  `promptSectionLabel` / `confirmDeleteSection` to inject styled
  modals.
- **Bar popover.** Clicking a bar cell opens a
  `role="dialog" aria-modal="true"` editor with a focus trap +
  Escape / outside-click dismissal. Edit start/end barlines,
  chord rows (root + accidental + 12 named qualities + Custom
  + optional slash-bass + beat position 1 / 1.5 / … / 4.5; add
  / remove / reorder), N-th ending (`empty` / `0` (untitled
  N0) / `1..9`), and musical symbol (None / Segno / Coda / Fine
  / Fermata / Break + the 11 player-recognised D.C. / D.S.
  macro variants). Save commits via the host's `emit` path so
  the URL round-trip stays single-source.
- **Accessibility.** The bar grid carries `role="grid"` +
  `aria-rowcount` + `aria-colcount={4}` + `aria-rowindex` /
  `aria-colindex`, with W3C APG roving tabindex (exactly one
  cell holds `tabindex="0"`). Keyboard shortcuts on the focused
  cell: Arrow / Home / End for roving navigation, Alt+Arrow
  for reorder, Delete / Backspace to remove the bar. Structural
  edits announce via a polite ARIA live region.

`readOnly`, `showUrl`, `showBars`, `promptSectionLabel`,
`confirmDeleteSection`, and a custom `errorFallback` are all
supported. Omit `onChange` to force read-only display.

### `<IrealPreview>` — SVG preview alone (Tier 1 atom)

```tsx
import { IrealPreview } from '@chordsketch/react';

export function Sheet({ url }: { url: string }) {
  return <IrealPreview source={url} />;
}
```

Calls `@chordsketch/wasm`'s `renderIrealSvg` and injects the result
via `dangerouslySetInnerHTML`. The SVG is fully server-controlled by
the Rust renderer (`crates/render-ireal/`); user-supplied chord and
metadata strings are escaped before being placed inside the SVG.

### iReal Pro hooks

```tsx
import { useIrealParse, useIrealSerialize, useIrealRender } from '@chordsketch/react';

const { song, loading: parsing, error: parseError } = useIrealParse(url);
const { url: nextUrl } = useIrealSerialize(song);
const { svg } = useIrealRender(url);
```

`useIrealParse` returns the typed AST (`IrealSong`).
`useIrealSerialize` produces a stable `irealb://` URL string from an
edited AST. `useIrealRender` is a convenience for the SVG render
path. All three lazy-load `@chordsketch/wasm` and reuse the
initialised module across re-renders.

### AST types and helpers

The iReal Pro AST mirrors the Rust `IrealSong` struct verbatim and
is re-exported on the package boundary:

```ts
import type {
  IrealSong,
  IrealSection,
  IrealBar,
  IrealChord,
  IrealChordQuality,
  IrealMusicalSymbol,
} from '@chordsketch/react';
import { irealChordToString, irealSectionLabelToString } from '@chordsketch/react';
```

The string helpers render AST nodes back to their iReal-Pro URL
shorthand (no Unicode translation; the SVG renderer handles that).

## API reference

| Export | Tier | Kind | Brief |
|---|---|---|---|
| `<ChordSheet>` | Atom | Component | Flagship ChordPro renderer (HTML AST → JSX or text → `<pre>`). |
| `useChordRender` | Atom | Hook | Same pipeline as `<ChordSheet>` exposed as state. |
| `<ChordTextarea>` | Atom | Component | Split-pane textarea + live preview + transpose shortcuts. |
| `<ChordSourceArea>` | Atom | Component | CodeMirror 6 source editor with ChordPro syntax highlight. |
| `<ChordDiagram>` | Atom | Component | Guitar / ukulele / piano voicing SVG from the built-in database. |
| `useChordDiagram` | Atom | Hook | Raw SVG string for the chord-instrument pair. |
| `<Transpose>` | Atom | Component | Accessible ± / reset transposition control. |
| `useTranspose` | Atom | Hook | Clamped state helper for transposition values. |
| `<PdfExport>` | Atom | Component | One-click export button; lazy-loads `@chordsketch/wasm-export`. |
| `usePdfExport` | Atom | Hook | Same export pipeline for custom UIs. |
| `<SplitLayout>` | Atom | Component | Layout container with resizable splitter. |
| `<RendererPreview>` | Atom | Component | Format-switcher preview pane. |
| `<ChordProPreview>` | Preview-with-controls | Component | `<RendererPreview>` + format select + transpose, for hosts that own the source. |
| `<ChordProEditor>` | Composed editor | Component | All-in-one ChordPro editor + preview shell. |
| `useChordproAst` | Atom | Hook | Parse ChordPro source into AST + warnings. |
| `renderChordproAst` | Atom | Function | AST → JSX walker (powers `<ChordSheet format="html">`). |
| `applyChordReposition` | Atom | Function | Apply a drag-to-reposition event to a ChordPro source. |
| `lyricsOffsetToSourceColumn` | Atom | Function | Lyrics-offset → source-column helper for drag UX. |
| `useDebounced` | Atom | Hook | General-purpose debouncer used by `<ChordTextarea>`. |
| `<MetronomeButton>` | Atom | Component | Clickable `{tempo}` metronome icon; ticks audibly at the BPM (speaker cursor on hover). |
| `useMetronome` | Atom | Hook | Web Audio metronome state (`start` / `stop` / `toggle` / `isRunning` / `isPlaying` / `supported`). |
| `<IrealBarGrid>` | Atom | Component | Header form + interactive bar grid + URL round-trip for iReal Pro. |
| `<IrealPreview>` | Atom | Component | iReal Pro SVG preview via `renderIrealSvg`. |
| `<IrealProEditor>` | Composed editor | Component | All-in-one iReal Pro editor + preview shell. |
| `useIrealParse` | Atom | Hook | `irealb://` URL → typed AST. |
| `useIrealSerialize` | Atom | Hook | AST → `irealb://` URL. |
| `useIrealRender` | Atom | Hook | `irealb://` URL → SVG string. |
| `irealChordToString` | Atom | Function | Render an iReal AST chord to its URL shorthand. |
| `irealSectionLabelToString` | Atom | Function | Render an iReal AST section label to its display name. |
| `version()` | — | Function | Returns the installed package version. |

Every component accepts a `className`, `style`, and where
applicable a structured `errorFallback` prop (`ReactNode`, a
render function `(err: Error) => ReactNode`, or `null` to suppress
entirely).

## Errors

Renderer and parse failures **never** throw out of the components.
Each surface returns an `error: Error | null` (hooks) or invokes
`errorFallback` (components) so the host decides how to display the
failure. When a previous successful render exists, components keep
the stale output visible alongside the alert so transient parse
errors do not blank the UI.

## Next.js / SSR

The editor and preview components touch wasm and browser globals on
mount; mark consuming files with `'use client'` in Next.js's
App Router. The render hooks themselves are safe to call from the
server (Node build of `@chordsketch/wasm`), but in practice you will
want to render the previews on the client so the bundle's WebAssembly
modules can be cached by the browser's HTTP cache instead of the
Node `require` cache.

### Version

```ts
import { version } from '@chordsketch/react';
console.log(version());
```

The returned string matches `package.json`'s `version` field.

## Design

- **Dual build (ESM + CJS)** produced by
  [tsup](https://tsup.egoist.dev/). Type declarations are emitted
  alongside each output.
- **React, ReactDOM, and `@chordsketch/wasm` are `external`** in the
  build config — they are resolved by the consumer's bundler rather
  than bundled in. This keeps the published package small and lets
  consumers upgrade those dependencies on their own cadence.
- **CSS under `./styles.css`** is the canonical stylesheet import
  path — opt in from the host application:
  ```ts
  import '@chordsketch/react/styles.css';
  ```
  Rules are minimal and use `currentColor` / transparent
  backgrounds so the components inherit the host theme. Every
  selector carries a `chordsketch-*` prefix to avoid colliding
  with host styles.

## Links

- [Main repository](https://github.com/koedame/chordsketch)
- [ChordSketch Docs](https://chordsketch.koeda.me/docs/) —
  embedding recipes for this package, per-component API
  reference, and cross-binding render / transpose guides
- [ChordSketch Playground](https://chordsketch.koeda.me)
  (vanilla-TS) — shows the underlying rendering with
  `@chordsketch/wasm` directly
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

[MIT](https://github.com/koedame/chordsketch/blob/main/LICENSE)
