# @chordsketch/ui-web

Framework-agnostic playground UI shared between the browser
[playground](../playground/) (deployed at
<https://koedame.github.io/chordsketch/>) and the upcoming Tauri
desktop app ([#2068](https://github.com/koedame/chordsketch/issues/2068)).

This is a **private workspace package**. It is not published to npm.
Hosts consume it via direct import (the playground uses Vite's
`resolve.alias` — see `packages/playground/vite.config.ts`); the desktop
scaffold added in [#2069](https://github.com/koedame/chordsketch/issues/2069)
will use the same pattern.

## Why a separate package

The playground and the desktop app render the same editor + preview
UI. Forking the implementation would mean every feature added to the
playground has to be back-ported by hand to the desktop app and vice
versa. Extracting the UI into a single library makes \"build it once,
host it twice\" automatic.

## API

```ts
import { mountChordSketchUi, type Renderers } from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';

const renderers: Renderers = {
  init: () => initWasm(),
  renderHtml: (input, opts) =>
    opts ? render_html_with_options(input, opts) : render_html(input),
  renderText: (input, opts) =>
    opts ? render_text_with_options(input, opts) : render_text(input),
  renderPdf: (input, opts) =>
    opts ? render_pdf_with_options(input, opts) : render_pdf(input),
};

await mountChordSketchUi(document.getElementById('app')!, { renderers });
```

The branching `opts ? ... : ...` form (rather than `opts ?? {}`) is
deliberate — it lets the no-options renderer call match what the
playground used pre-extraction, which keeps `renderPdf`'s binary
output deterministic against the pre-extraction baseline.

The host injects the renderer backend so `ui-web` does not bake in a
dependency on `@chordsketch/wasm`. A desktop host could instead wrap a
native `chordsketch` binary over Tauri IPC and supply functions of the
same shape.

### Options

| Option | Default | Notes |
|---|---|---|
| `renderers` | (required) | `init / renderHtml / renderText / renderPdf` quartet. |
| `initialChordPro` | Sample \"Amazing Grace\" | The starter content shown in the editor. |
| `pdfFilename` | `chordsketch-output.pdf` | Used as the `download` attribute when the user clicks \"Download PDF\". |
| `title` | `ChordSketch Playground` | Shown in the header bar. |
| `documentTitle` | (unchanged) | When set, also overrides `document.title` on mount. |

## Visual contract

The DOM structure built by `mountChordSketchUi` is **structurally
identical** to the original `packages/playground/index.html` markup
— same element IDs, same class names, same nesting order. (The
text-node whitespace inside `<label>` elements is collapsed by
`document.createElement` rather than preserved as in the original
hand-written HTML, but CSS whitespace collapsing makes the rendered
result indistinguishable.) The bundled stylesheet (`./style.css`)
therefore renders identically against either host. A visual
regression check (screenshots before/after this extraction) is the
gate on changes that affect rendered output.
