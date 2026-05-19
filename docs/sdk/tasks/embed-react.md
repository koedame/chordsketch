# Embed ChordPro and iReal Pro in your React app

`@chordsketch/react` ships the same parser + renderer pipeline that
powers <https://chordsketch.koeda.me> as a published React component
library. This page is the recipe collection for the most common
embedding scenarios; copy-paste into a fresh Vite + React 18 app
(or Next.js, see [§Server-side rendering / Next.js](#server-side-rendering--nextjs)
below) and it works.

> **Prerequisite.** `npm install @chordsketch/react react react-dom`.
> The PDF / PNG export bundle is a separate optional peer — see
> [§Export to PDF](#export-to-pdf) for when to install it.

## Recipe 1 — Drop in a ChordPro playground in 30 seconds

The fastest path. One component, no configuration, full editor +
preview + transpose UI:

```tsx
import { Playground } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

export default function App() {
  return <Playground defaultValue={"{title: My Song}\n[G]Hello [D]world"} />;
}
```

`<Playground>` accepts `source` + `onChange` to drive the value from
the host (controlled mode) instead of letting the component own it.

## Recipe 2 — Render a read-only chord sheet

For lyrics-and-chords display without any editing affordance:

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

`format="html"` (the default) walks the parsed AST into a React tree
through the `chordpro-jsx` walker — every element reaches the DOM
through React reconciliation, so the output is safe for snapshot
tests and ordinary React composition. `format="text"` switches to
a `<pre>`-wrapped plain-text render for an even-more-conservative
preview.

## Recipe 3 — Build a custom editor layout

For hosts that want their own pane layout, `<SourceEditor>` (the
CodeMirror 6 editor with ChordPro syntax highlight) and
`<RendererPreview>` (the format-switching preview pane) compose
freely:

```tsx
import { useState } from 'react';
import { SourceEditor, RendererPreview, SplitLayout } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

export function Editor() {
  const [source, setSource] = useState('{title: My Song}\n[G]Hello');
  return (
    <SplitLayout
      start={<SourceEditor value={source} onChange={setSource} />}
      end={<RendererPreview source={source} format="html" />}
    />
  );
}
```

`<SplitLayout>` exposes a `--cs-split-ratio` CSS variable for the
two-pane ratio and falls back to a stacked layout under 768 px.

## Recipe 4 — Add transposition controls

`<Transpose>` is an accessible ± / reset control (announces value
changes via `aria-live="polite"`, supports `+` / `-` / `0`
keyboard shortcuts while focus is inside, clamps to `[min, max]`).
Pair it with the `transpose` prop on `<ChordSheet>`:

```tsx
import { ChordSheet, Transpose, useTranspose } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const source = `{title: Hello}\n[Am]hello [F]world`;

export function Sheet() {
  const { value, setValue } = useTranspose({ min: -11, max: 11 });
  return (
    <div>
      <Transpose value={value} onChange={setValue} />
      <ChordSheet source={source} transpose={value} />
    </div>
  );
}
```

`useTranspose()` clamps every update; `reset()` returns to the
initial value (not necessarily zero).

## Recipe 5 — Export to PDF

PDF export ships in a separate heavy bundle so the lean
`@chordsketch/wasm` core stays small. Install the optional peer
alongside `@chordsketch/react`:

```bash
npm install @chordsketch/wasm-export
```

Then drop in `<PdfExport>`:

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

The heavy bundle is **lazy-loaded** on first export — the initial
page load does not pay for it. `<PdfExport>` exposes the standard
`<button>` attributes (`className`, `style`, `type`, …) plus
`onExported(filename)` and `onError(err)` callbacks for analytics
or toasts.

`usePdfExport()` returns the same `exportPdf` pipeline as state for
custom UIs (dropdown items, command palettes, etc.).

## Recipe 6 — Render chord diagrams

`<ChordDiagram>` looks up the chord in the built-in voicing
database (156 voicings: 60 guitar, 36 ukulele, 60 piano) and
returns inline SVG that inherits `currentColor`:

```tsx
import { ChordDiagram } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

export function Voicings() {
  return (
    <>
      <ChordDiagram chord="Am" instrument="guitar" />
      <ChordDiagram chord="C" instrument="ukulele" />
      <ChordDiagram chord="Dm7" instrument="piano" />
    </>
  );
}
```

Unknown chords render `notFoundFallback` (default: an inline
`role="note"` with the chord name). `useChordDiagram()` returns the
raw SVG string for hosts that want to embed it inside custom markup
(tooltip, popover, etc.).

## Recipe 7 — Drive your own UI from the ChordPro AST

For hosts that want to render the song in a completely custom way
— a karaoke prompter, an alternate layout for printing, a
syntax-highlighted source view — use `useChordproAst` and
`renderChordproAst`:

```tsx
import { useChordproAst, renderChordproAst } from '@chordsketch/react';

export function CustomRender({ source }: { source: string }) {
  const { ast, warnings, loading, error } = useChordproAst(source);
  if (loading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (ast === null) return null;
  return (
    <article>
      <h1>{ast.metadata.title ?? 'Untitled'}</h1>
      <div>{renderChordproAst(ast)}</div>
      {warnings.length > 0 ? (
        <details>
          <summary>Warnings ({warnings.length})</summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
```

`renderChordproAst` is also the function `<ChordSheet format="html">`
uses internally — driving it directly gives identical output you
can place anywhere in your tree.

## Recipe 8 — Drop in an iReal Pro playground

`<IrealPlayground>` is the iReal Pro sibling of `<Playground>` — a
single-component embed for an iReal Pro chart:

```tsx
import { IrealPlayground } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const URL =
  'irealb://Autumn%20Leaves%3D%5BT44Cm7%20%7C%20F7%20%7C%20BbMaj7%20%7C%20EbMaj7%20%5D%3DJoseph%20Kosma%3DJazz%20Ballad%3DC';

export default function App() {
  return <IrealPlayground defaultValue={URL} />;
}
```

The composite shows the editor (header form + interactive bar grid
with structural editing + URL textarea) next to the SVG preview.
`hidePreview`, `hideBars`, and `hideUrl` trim the layout for
narrower hosts; pass `source` + `onChange` for controlled mode.

> **Editing scope.** `v0.2.0` brings the iReal Pro surface to
> parity with the private `@chordsketch/ui-irealb-editor` per
> [ADR-0020](../../adr/0020-ireal-pro-react-surface.md):
> structural section / bar editing, ARIA-grid keyboard navigation,
> and a popover-based per-bar chord editor with a chord-row
> editor, N-th ending input, and symbol picker. The playground
> at <https://chordsketch.koeda.me/chordsketch/irealpro/> still
> hosts the DOM editor for reference comparison.

## Recipe 9 — Custom iReal Pro rendering

For hosts that need their own iReal Pro UI, the `<IrealPreview>`
component renders the SVG directly:

```tsx
import { IrealPreview, useIrealParse } from '@chordsketch/react';

export function CustomChart({ url }: { url: string }) {
  const { song, error } = useIrealParse(url);
  return (
    <article>
      {song !== null ? <h1>{song.title}</h1> : null}
      <IrealPreview source={url} />
      {error ? <p role="alert">{error.message}</p> : null}
    </article>
  );
}
```

`useIrealParse` exposes the typed `IrealSong` AST so the host can
build any UI on top: a setlist filtered by `key_signature.mode`, a
search box that matches against `composer`, a key-changer that
edits `song.transpose` and re-serialises via `useIrealSerialize`.

## Recipe 10 — Server-side rendering / Next.js

`@chordsketch/react`'s render hooks load `@chordsketch/wasm` lazily;
on the Node side this means initialising the wasm runtime once per
process. The editor and preview components touch `window` /
`document` on mount, so mark consuming files with `'use client'` in
Next.js's App Router:

```tsx
// app/song/[id]/page.tsx
import { ChordSheet } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

export default function Page({ params }: { params: { id: string } }) {
  // The component is a Client Component (see below); SSR streams
  // its skeleton from the server but the wasm-backed render runs
  // on the client where the binary can be cached by the browser.
  return <ChordSheet source={`{title: ${params.id}}`} />;
}
```

```tsx
// app/song/[id]/sheet.tsx
'use client';

import { ChordSheet } from '@chordsketch/react';
export { ChordSheet };
```

In practice, prefer rendering the preview on the client even for
static content — the browser's HTTP cache stores
`chordsketch_wasm_bg.wasm` once and reuses it across navigations,
which the Node `require` cache cannot do across deployments.

For pure SSR (e.g. generating an OG image, emailing a PDF), drive
`@chordsketch/wasm` directly from a Node module and call
`render_html_with_options` / `render_pdf` synchronously — the React
components are the wrong layer for non-React server rendering.

## See also

- [Render to HTML, plain text, or PDF](render.md) — same operation
  across every binding (CLI / Rust / Python / Swift / Kotlin /
  Ruby / wasm), useful if your stack mixes a React client with a
  non-React server.
- [Transpose chords by N semitones](transpose.md) — the
  transposition surface across bindings, for hosts that want to
  pre-compute transpositions outside React.
- [`packages/react/README.md`](../../../packages/react/README.md) —
  the full API reference for `@chordsketch/react`, including the
  AST type re-exports and helper functions.
- [ADR-0020](../../adr/0020-ireal-pro-react-surface.md) — why the
  iReal Pro React surface is a native React implementation rather
  than a wrapper around the private `@chordsketch/ui-irealb-editor`.
