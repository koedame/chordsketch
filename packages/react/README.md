<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/react

React component library for rendering [ChordPro](https://www.chordpro.org/)
files, powered by [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm).

> **Status:** pre-release. The component surface is landing
> incrementally under issues
> [#2041](https://github.com/koedame/chordsketch/issues/2041)–[#2045](https://github.com/koedame/chordsketch/issues/2045).
> Currently shipped: `<PdfExport>` + `usePdfExport` (#2041),
> `<Transpose>` + `useTranspose` (#2044),
> `<ChordSheet>` + `useChordRender` (#2042),
> `<ChordEditor>` + `useDebounced` (#2043).
> Still pending: `<ChordDiagram>`.

## Installation

[![npm](https://img.shields.io/npm/v/@chordsketch/react)](https://www.npmjs.com/package/@chordsketch/react)

Replace `VERSION` with the current version from the badge above.

```bash
npm install '@chordsketch/react@VERSION' react
```

`@chordsketch/wasm` is bundled as a runtime dependency and loads
itself — the host does not need to install it separately. `react`
is a **peer dependency** (React 18 or newer).

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

`format="html"` (default) injects ChordPro's rendered HTML via
`dangerouslySetInnerHTML`. The output comes from
`chordsketch-render-html`, which escapes all user-supplied
ChordPro tokens (titles, lyrics, chord names, attributes, inline
markup, custom section labels) before emitting markup — for
first-party ChordPro this is safe to inject directly.
`format="text"` renders the plain-text chords-above-lyrics output
inside a `<pre>`; pick that variant if you need a zero-HTML
preview.

**Trust boundary note.** Delegate sections (`{start_of_abc}`,
`{start_of_ly}`, `{start_of_musicxml}`, `{start_of_textblock}`)
pass their bodies through **raw** per the render-html crate's
security doc. If you accept **untrusted** ChordPro (e.g. a
multi-tenant SaaS where end users share songs), combine this
component with a Content Security Policy that restricts inline
scripts and external resource loads, or switch to `format="text"`
for a zero-HTML preview. The playground
(`packages/ui-web`) uses a sandboxed iframe for the same render
pipeline because it does not control the ChordPro source it
renders; `<ChordSheet>` does not sandbox because typical React
hosts already control their own input.

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

### `<ChordEditor>` — split-pane edit + live preview

```tsx
import { ChordEditor, useTranspose } from '@chordsketch/react';

export function Editor() {
  const { value: transpose, setValue: setTranspose } = useTranspose();
  return (
    <ChordEditor
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
copy of the source (default 250 ms). Supports both controlled
(`value` + `onChange`) and uncontrolled (`defaultValue`) modes,
plus keyboard shortcuts **Ctrl+ArrowUp / Ctrl+ArrowDown** (Cmd
on macOS) to fire `onTransposeChange` — wire that callback to
the `setValue` from `useTranspose()` to get live transposition
without leaving the editor.

`readOnly`, `previewFormat="text"` (preview inside `<pre>`
instead of HTML), `config`, custom `errorFallback`, and
`minTranspose` / `maxTranspose` bounds for the shortcuts are all
passed through. Pass `debounceMs={0}` in tests to make the
preview re-render synchronously.

The textarea receives a default `aria-label="ChordPro editor"`
so screen-reader users hear an actual name rather than falling
back to the placeholder (which WAI-ARIA does not treat as an
accessible name). Override via the `textareaAriaLabel` prop when
a visible `<label>` provides a better name.

### `useDebounced` — general-purpose debouncer

```tsx
import { useDebounced } from '@chordsketch/react';

const debouncedQuery = useDebounced(rawQuery, 300);
```

Returns a value that lags the input by at most `delay` ms.
`delay <= 0` bypasses the debounce and passes the input through
synchronously (used internally by `<ChordEditor>` in tests).

### `<PdfExport>` — one-click PDF download

```tsx
import { PdfExport } from '@chordsketch/react';

const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

export function SaveButton() {
  return (
    <PdfExport source={source} filename="amazing-grace.pdf">
      Download PDF
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

The component renders a `−` / current-value readout / `+` trio
plus a Reset button that appears only when the offset is non-zero.
Buttons carry per-direction `aria-label`s (`"Transpose up one
semitone"`, etc.), the readout is an `<output>` with `aria-live="polite"`
so screen readers announce changes, and the wrapper listens for
`+` / `-` / `0` keys while focus is inside so keyboard users can
step without mouse hits. Values are clamped into `[min, max]`
(defaults `-11`…`+11`) in both the controlled mode and via the
hook's own `setValue`.

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
- [ChordSketch Playground](https://koedame.github.io/chordsketch/)
  (vanilla-TS) — shows the underlying rendering with
  `@chordsketch/wasm` directly
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

[MIT](https://github.com/koedame/chordsketch/blob/main/LICENSE)
