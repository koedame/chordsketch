# @chordsketch/ui-web

> ## ⚠️ Internal workspace package — not for external use
>
> This package is the shared **app shell** for the ChordSketch
> playground (`packages/playground/`) and the Tauri desktop app
> (`apps/desktop/`). It is intentionally `"private": true` and is
> **not published to npm**.
>
> **If you are building a third-party application** that embeds a
> ChordPro or iReal Pro editor, use
> [`@chordsketch/react`](../react/) instead — that package exposes
> `<Playground>`, `<ChordSheet>`, `<IrealPlayground>` and the
> matching hooks behind a stable, published API.
>
> Reasons this package stays internal:
>
> - It exists to deduplicate code between the playground and the
>   desktop app, not to be a third public surface alongside
>   `@chordsketch/wasm` and `@chordsketch/react`. Publishing it
>   would force its API to follow semver, which would slow the
>   playground / desktop iteration loop.
> - It is framework-agnostic plain DOM, deliberately incompatible
>   with React composition out of the box — the React surface
>   wraps it (or, post-[ADR-0020](../../docs/adr/0020-ireal-pro-react-surface.md),
>   re-implements its functionality in idiomatic React).
> - The "internal workspace package" policy is the result of the
>   [#2473](https://github.com/koedame/chordsketch/issues/2473)
>   non-goals discussion; see
>   [ADR-0020](../../docs/adr/0020-ireal-pro-react-surface.md) for
>   the iReal Pro side of the same decision.

Framework-agnostic playground UI shared between the browser
[playground](../playground/) (deployed at
<https://koedame.github.io/chordsketch/>) and the Tauri desktop app
([#2068](https://github.com/koedame/chordsketch/issues/2068)).
Hosts consume it via direct import (the playground uses Vite's
`resolve.alias` — see `packages/playground/vite.config.ts`); the desktop
scaffold added in [#2069](https://github.com/koedame/chordsketch/issues/2069)
uses the same pattern.

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

### Cleanup

`mountChordSketchUi` returns a `Promise<ChordSketchUiHandle>`. The
handle's `destroy()` method cancels the pending render-debounce
timer and detaches the event listeners attached during mount:

```ts
const handle = await mountChordSketchUi(root, { renderers });
// ...later, when the host is unmounting (Tauri WebView reset, tab
// switch, Vite HMR, etc.):
handle.destroy();
```

`destroy()` is idempotent. Hosts that mount once and never unmount
(today's browser playground) may safely ignore the return value.

## Host-page contract

`mountChordSketchUi` adds the `.chordsketch-ui-root` class to the
supplied `root` element and styles it as a `100vh` flex column. The
host therefore needs to provide:

- A `<body>` (and any wrapping containers) without their own
  conflicting `height` or `display` rules — the `100vh` on the mount
  root is self-sufficient and does not depend on parent sizing.
- A reset that zeroes `body` margin (the bundled `style.css` already
  applies `* { margin: 0; padding: 0; box-sizing: border-box; }`).

Both the browser playground (`packages/playground/index.html`) and
the desktop Tauri shell (`apps/desktop/index.html`) satisfy this with
a single `<div id="app"></div>`; no host-specific CSS is required.

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
