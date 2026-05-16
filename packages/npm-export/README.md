<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/wasm-export

[ChordSketch](https://github.com/koedame/chordsketch) WebAssembly
bindings for **PDF / PNG export** — the heavy companion of
[`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm).

This package adds `render_pdf` / `renderIrealPng` / `renderIrealPdf`
on top of every export the lean package ships, so a single import of
`@chordsketch/wasm-export` is sufficient for any app that needs to
emit binary chart artefacts. The price is bundle weight: this
package weighs ~25× more than `@chordsketch/wasm` because it bundles
the resvg / tiny-skia / svg2pdf / fontdb / harfrust transitive
dependency tree required to rasterise SVG and emit PDF.

| Package | Raw `.wasm` | gzipped | Surface |
|---|---|---|---|
| [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm) | 399 KB | 178 KB | parse + transpose + text / HTML / SVG |
| `@chordsketch/wasm-export` | 9.7 MB | 6.7 MB | lean surface **+** PDF / PNG |

The intended usage pattern is to install `@chordsketch/wasm` as
your default dependency and `import('@chordsketch/wasm-export')`
dynamically only when the user actually triggers an export — the
dynamic-import boundary lets bundlers (Vite, webpack, Rollup,
esbuild) emit a separate chunk for the heavy bundle so the
initial page load stays light.

## Installation

[![npm](https://img.shields.io/npm/v/@chordsketch/wasm-export)](https://www.npmjs.com/package/@chordsketch/wasm-export)

Replace `VERSION` with the current version from the badge above.

```bash
npm install '@chordsketch/wasm-export@VERSION'
```

## Usage

The package ships **two builds** under one name and uses Node's
conditional `exports` to pick the right one for the runtime:

| Runtime | Build | Init required? |
|---|---|---|
| Browser (Vite, webpack, native ESM) | `wasm-pack --target web` | Yes — `await init()` |
| Node.js (≥ 20) | `wasm-pack --target nodejs` | No — auto-loaded synchronously |

### Browser

```js
import init, { render_pdf, render_pdf_with_options } from '@chordsketch/wasm-export';

await init();

const chordpro = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

const pdfBytes = render_pdf(chordpro);                // Uint8Array
const transposed = render_pdf_with_options(chordpro, { transpose: 2 });
```

### Node.js

```js
import { render_pdf } from '@chordsketch/wasm-export';

const pdfBytes = render_pdf('{title: T}\n[C]Hello');  // Uint8Array
```

### Lazy dynamic import (recommended in the browser)

```js
async function downloadPdf(chordpro) {
  // Only the user clicking "export" pays the ~6 MB gzipped download.
  const { default: init, render_pdf } = await import('@chordsketch/wasm-export');
  await init();
  const bytes = render_pdf(chordpro);
  // ... wrap in Blob, anchor.click, etc.
}
```

## API

This package re-exports the full surface of
[`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm)
(parse + transpose + text / HTML / SVG / iReal-chord-typography)
unchanged. Refer to the sister package's README for those signatures.

The export-specific additions:

| Function | Input | Output |
|----------|-------|--------|
| `render_pdf(input)` | ChordPro string | `Uint8Array` (PDF bytes) |
| `render_pdf_with_options(input, options)` | ChordPro string + options | `Uint8Array` (PDF bytes) |
| `renderIrealPng(input)` | `irealb://` URL | `Uint8Array` — encoded PNG (300 DPI default, A4-equivalent canvas) |
| `renderIrealPdf(input)` | `irealb://` URL | `Uint8Array` — single-page A4 PDF (vector content) |

### Options

```ts
interface RenderOptions {
  transpose?: number;  // Semitone offset (any integer in i8 range; renderer reduces mod 12), default 0
  config?: string;     // Preset name ("guitar", "ukulele") or inline RRJSON
}
```

## Why split the package?

Resolving SVG (`resvg`) and emitting PDF (`svg2pdf`, plus the
PDF text-shaping stack in `chordsketch-render-pdf`) inflates the
wasm binary by an order of magnitude. Most consumers of
`@chordsketch/wasm` only want the parser + the text / HTML / SVG
renderers — they should not pay the rasterisation cost on every
page load.

The split is implemented at the `chordsketch-wasm` Cargo feature
level: `@chordsketch/wasm` builds with `--no-default-features`
(parser + lean renderers only), and `@chordsketch/wasm-export`
builds with the `png-pdf` Cargo feature on. See
[CLAUDE.md](https://github.com/koedame/chordsketch/blob/main/CLAUDE.md)
in the source repo for the per-crate dependency graph and #2466
for the size-budget discussion that motivated the split.

## Building from source

```bash
# From the repository root
cd packages/npm-export && npm run build
```

## License

MIT
