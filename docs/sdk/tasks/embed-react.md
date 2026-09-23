# Embed ChordPro and iReal Pro in your React app

`@chordsketch/react` ships the same parser + renderer pipeline that
powers <https://chordsketch.koeda.me> as a published React component
library. This page is the recipe collection for the most common
embedding scenarios; copy-paste into a fresh Vite + React app
(or Next.js, see [§Server-side rendering / Next.js](#recipe-10-server-side-rendering-nextjs)
below) and it works.

> **Prerequisite.** `npm install @chordsketch/react react react-dom`.
> The PDF / PNG export bundle is a separate optional peer — see
> [§Export to PDF](#recipe-5-export-to-pdf) for when to install it.
> Next.js apps need it installed regardless; see
> [§Server-side rendering / Next.js](#recipe-10-server-side-rendering-nextjs).

## Recipe 1 — Drop in a ChordPro playground in 30 seconds

The fastest path. One component, no configuration, full editor +
preview + transpose UI:

```tsx
import { ChordProEditor } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

export default function App() {
  return <ChordProEditor defaultSource={"{title: My Song}\n[G]Hello [D]world"} />;
}
```

`<ChordProEditor>` accepts `source` + `onSourceChange` to drive the
value from the host (controlled mode) instead of letting the component
own it.

> Renamed from `<Playground>` in `@chordsketch/react` v0.3.0 per
> [ADR-0022](../../adr/0022-react-as-canonical-preview-surface.md).

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

For hosts that want their own pane layout, `<ChordSourceArea>` (the
CodeMirror 6 editor with ChordPro syntax highlight) and
`<RendererPreview>` (the format-switching preview pane) compose
freely:

```tsx
import { useState } from 'react';
import { ChordSourceArea, RendererPreview, SplitLayout } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

export function Editor() {
  const [source, setSource] = useState('{title: My Song}\n[G]Hello');
  return (
    <SplitLayout
      start={<ChordSourceArea value={source} onChange={setSource} />}
      end={<RendererPreview source={source} format="html" />}
    />
  );
}
```

> `<ChordSourceArea>` was renamed from `<SourceEditor>` in
> `@chordsketch/react` v0.3.0.

`<SplitLayout>` exposes a `--cs-split-ratio` CSS variable for the
two-pane ratio and falls back to a stacked layout under 768 px.

## Recipe 4 — Add transposition controls

`<Transpose>` is a native `<select>` listing every semitone offset
between `min` and `max` — keyboard and screen-reader support come
from the browser's own control. Pair it with the `transpose` prop on
`<ChordSheet>`:

```tsx
import { ChordSheet, Transpose, useTranspose } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const source = `{title: Hello}\n[Am]hello [F]world`;

export function Sheet() {
  const { value, setValue } = useTranspose();
  return (
    <div>
      <Transpose value={value} onChange={setValue} />
      <ChordSheet source={source} transpose={value} />
    </div>
  );
}
```

The two defaults differ on purpose: `useTranspose()` clamps to the
feature limit `±11` (a full octave is the identity, so `±12` renders
the written chords), while the select offers the narrower `±6` that
is useful in practice. Pass `min` / `max` to `<Transpose>` to widen
the option list to whatever range the hook is clamping to.

`useTranspose()` also returns `increment` / `decrement` / `reset`
for hosts that build their own control (slider, number input,
keyboard shortcut). Every update clamps, and `reset()` returns to
the initial value — not necessarily zero.

## Recipe 5 — Export to PDF

PDF export ships in a separate heavy bundle so the lean
`@chordsketch/wasm` core stays small, behind the `@chordsketch/react/pdf`
subpath rather than the package root. Install the optional peer
alongside `@chordsketch/react`:

```bash
npm install @chordsketch/wasm-export
```

Then drop in `<PdfExport>`:

```tsx
import { PdfExport } from '@chordsketch/react/pdf';

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

The heavy bundle is **lazy-loaded** on first export — the initial
page load does not pay for it. `<PdfExport>` exposes the standard
`<button>` attributes (`className`, `style`, `type`, …) plus
`onExported(filename)` and `onError(err)` callbacks for analytics
or toasts.

`usePdfExport()` returns the same `exportPdf` pipeline as state for
custom UIs (dropdown items, command palettes, etc.).

`<RendererPreview format="pdf">`, `<PreviewToolbar>`, `<ChordProPreview>`,
and `<ChordProEditor>` do not import `@chordsketch/react/pdf` on
their own — pass `<PdfExport>` through their `pdfExportComponent`
prop to enable PDF export in those surfaces:

```tsx
import { ChordProEditor } from '@chordsketch/react';
import { PdfExport } from '@chordsketch/react/pdf';

<ChordProEditor pdfExportComponent={PdfExport} defaultSource="{title: Hello}" />
```

This split keeps `@chordsketch/react`'s main entry point free of the
`import('@chordsketch/wasm-export')` call — bundlers that resolve
dynamic imports at build time (webpack, Turbopack, and so Next.js —
see [Recipe 10](#recipe-10-server-side-rendering-nextjs)) never
require the peer for apps that do not import `@chordsketch/react/pdf`.

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
      <div>{renderChordproAst(ast)}</div>
      {warnings.length > 0 ? (
        <details>
          <summary>Warnings ({warnings.length})</summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
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
can place anywhere in your tree, song title included. Read
`ast.metadata` (`title`, `artists`, `key`, …) when the host wants
those fields for its own chrome — a page `<title>`, a setlist row —
rather than for the sheet itself. `warnings` is a list of
human-readable strings.

## Recipe 8 — Drop in an iReal Pro playground

`<IrealProEditor>` is the iReal Pro sibling of `<ChordProEditor>` — a
single-component embed for an iReal Pro chart:

```tsx
import { IrealProEditor } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const URL =
  'irealb://Autumn%20Leaves%3DKosma%20Joseph%3D%3DMedium%20Swing%3DG%2D%3D%3D' +
  '1r34LbKcu7T44%2AA%5BC%2D7%7CF7%7CBb%5E7%7CEb%5E7%7CAh7%7CD7%7CG%2D6%7CG%2D6Z' +
  '%3D%3D0%3D0';

export default function App() {
  return <IrealProEditor defaultValue={URL} />;
}
```

> Renamed from `<IrealPlayground>` in `@chordsketch/react` v0.3.0
> per [ADR-0022](../../adr/0022-react-as-canonical-preview-surface.md).

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

Install the optional PDF peer alongside the library, even if the app
never exports a PDF:

```bash
npm install @chordsketch/react @chordsketch/wasm-export
```

Next.js's bundler resolves every `import()` at build time, including
the lazy import `<PdfExport>` uses for `@chordsketch/wasm-export`.
Without the package installed, `next build` stops with
`Module not found: Can't resolve '@chordsketch/wasm-export'`. The
bundle is still only fetched on the first export, so installing it
does not grow the page.

The components hold state and touch `window` / `document` on mount,
so they are Client Components, and `@chordsketch/react` does not mark
its entry point with `'use client'`. Re-export what you need from a
file that does:

```tsx
// app/song/[id]/sheet.tsx
'use client';

import { ChordSheet } from '@chordsketch/react';
export { ChordSheet };
```

Then import from that file — not from `@chordsketch/react` — in the
Server Component. Importing the library directly into a Server
Component fails at request time with
`useState is not a function or its return value is not iterable`.

```tsx
// app/song/[id]/page.tsx
import { ChordSheet } from './sheet';
import '@chordsketch/react/styles.css';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The server renders the component's loading state; the
  // wasm-backed render runs on the client, where the browser
  // caches the binary.
  return <ChordSheet source={`{title: ${id}}\n[G]Hello [D]world`} />;
}
```

`params` is a `Promise` from Next.js 15 on; on Next.js 14, type it as
`{ params: { id: string } }` and read `params.id` directly.

In practice, prefer rendering the preview on the client even for
static content — the browser's HTTP cache stores
`chordsketch_wasm_bg.wasm` once and reuses it across navigations,
which the Node `require` cache cannot do across deployments.

For pure SSR (e.g. generating an OG image, emailing a PDF), drive the
wasm packages directly from a Node module — `render_html_with_options`
from `@chordsketch/wasm`, `render_pdf` from `@chordsketch/wasm-export`
— and call them synchronously. The React components are the wrong
layer for non-React server rendering.

## See also

- [Embed ChordPro in a Vue app](embed-vue.md) — the same recipes in
  the same order for `@chordsketch/vue`, and the list of surfaces on
  this page that have no Vue counterpart.
- [Embed ChordPro in a Svelte app](embed-svelte.md) — the same
  recipes again for `@chordsketch/svelte`, and the list of surfaces
  on this page that have no Svelte counterpart.
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
