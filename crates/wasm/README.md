<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-wasm

The Rust-side WebAssembly bindings crate for [ChordSketch](https://github.com/koedame/chordsketch).
It wraps `chordsketch-chordpro` (with text / HTML / PDF renderers) plus
the iReal Pro parser, chart renderer, and ChordPro ↔ iReal Pro converter
(`chordsketch-ireal`, `chordsketch-render-ireal`, `chordsketch-convert`)
with `wasm-bindgen` entry points consumed from JavaScript/TypeScript.

**If you want to use ChordSketch from Node.js or a browser, install
[`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm)
from npm instead.** That package is built from this crate and ships the
dual-package (ESM + CommonJS) layout, type definitions, and pre-compiled
`.wasm` binary. This crate is the source this README lives next to; it
is published to crates.io primarily so that `docs.rs` can render the
Rust-side API and so that other Rust crates can compile the same bindings
with different `wasm-pack` targets if needed.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## JavaScript/TypeScript usage (npm)

```bash
npm install @chordsketch/wasm
```

```js
import { render_html, render_text, render_pdf, version } from '@chordsketch/wasm';

const chordpro = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

const html = render_html(chordpro);
const text = render_text(chordpro);
const pdfBytes = render_pdf(chordpro); // Uint8Array
console.log(version());
```

See [`packages/npm/README.md`](https://github.com/koedame/chordsketch/blob/main/packages/npm/README.md)
for browser-vs-Node specifics, options (`transpose`, `config`), and the
dual-package resolution rules.

## Building the crate locally (Rust developers only)

```bash
wasm-pack build crates/wasm --target web
```

The canonical build script used by the playground and npm publishing is
`packages/npm/scripts/build.mjs` (runs `wasm-pack` twice — once for the
browser target and once for the Node target — and merges the output into
a dual-package layout).

## API

The tables below cover every `#[wasm_bindgen]`-exported `pub fn`
in [`crates/wasm/src/lib.rs`](src/lib.rs) (the `start` lifecycle
hook and the `console` `extern "C"` shim are intentionally
omitted). The `### iReal Pro` subsection mirrors the structure of
the
[`### iReal Pro conversion` table in `packages/npm/README.md`](https://github.com/koedame/chordsketch/blob/main/packages/npm/README.md#ireal-pro-conversion).

### Basic rendering

| Function | Description | Return type |
|---|---|---|
| `render_text(input)` | Render ChordPro to plain text | `string` |
| `render_html(input)` | Render ChordPro to HTML5 | `string` |
| `render_pdf(input)` | Render ChordPro to a PDF byte array | `Uint8Array` |

### Rendering with options

| Function | Description | Return type |
|---|---|---|
| `render_text_with_options(input, opts)` | Same as `render_text`, with `{ transpose?, config? }` | `string` |
| `render_html_with_options(input, opts)` | Same as `render_html`, with `{ transpose?, config? }` | `string` |
| `render_pdf_with_options(input, opts)` | Same as `render_pdf`, with `{ transpose?, config? }` | `Uint8Array` |

### Body-only HTML and stylesheet

| Function | Description | Return type |
|---|---|---|
| `render_html_body(input)` | Render ChordPro to a body-only `<div class="song">…</div>` HTML fragment with no `<!DOCTYPE>` / `<html>` / `<head>` / `<title>` / embedded `<style>` — pair with `render_html_css` when the host supplies its own document envelope | `string` |
| `render_html_body_with_options(input, opts)` | Same as `render_html_body`, with `{ transpose?, config? }` | `string` |
| `render_html_css()` | Return the canonical chord-over-lyrics CSS that `render_html` embeds inside `<style>` (byte-stable; safe to hash for cache-busting) | `string` |
| `render_html_css_with_options(opts)` | Variant of `render_html_css` that honours `settings.wraplines` from `{ transpose?, config? }` (when `wraplines` is false, `.line` emits `flex-wrap: nowrap`) | `string` |

### Captured warnings

| Function | Description | Return type |
|---|---|---|
| `renderTextWithWarnings(input)` | Plain-text render that captures warnings instead of forwarding to `console.warn` | `{ output: string, warnings: string[] }` |
| `renderHtmlWithWarnings(input)` | HTML render with captured warnings | `{ output: string, warnings: string[] }` |
| `renderPdfWithWarnings(input)` | PDF render with captured warnings | `{ output: Uint8Array, warnings: string[] }` |
| `renderHtmlBodyWithWarnings(input)` | Body-only HTML fragment with captured warnings (body counterpart to `renderHtmlWithWarnings`) | `{ output: string, warnings: string[] }` |
| `renderTextWithWarningsAndOptions(input, opts)` | `renderTextWithWarnings` + `{ transpose?, config? }` options | `{ output: string, warnings: string[] }` |
| `renderHtmlWithWarningsAndOptions(input, opts)` | `renderHtmlWithWarnings` + `{ transpose?, config? }` options | `{ output: string, warnings: string[] }` |
| `renderPdfWithWarningsAndOptions(input, opts)` | `renderPdfWithWarnings` + `{ transpose?, config? }` options | `{ output: Uint8Array, warnings: string[] }` |
| `renderHtmlBodyWithWarningsAndOptions(input, opts)` | `renderHtmlBodyWithWarnings` + `{ transpose?, config? }` options | `{ output: string, warnings: string[] }` |

### Validation

| Function | Description | Return type |
|---|---|---|
| `validate(input)` | Validate ChordPro input and return any parse errors as structured records (empty array if valid). Matches the NAPI `ValidationError[]` shape and the FFI `ValidationError` dictionary | `ValidationError[]` (`{ line: number, column: number, message: string }`, line / column one-based) |

### Chord diagrams

| Function | Description | Return type |
|---|---|---|
| `chord_diagram_svg(chord, instrument)` | Render a chord diagram as inline SVG. `instrument` is `"guitar"`, `"ukulele"` (alias `"uke"`), or `"piano"` (aliases `"keyboard"`, `"keys"`). Returns `null` when the chord is not in the built-in voicing database; throws on unknown instrument | `string \| null` (SVG markup) |

### iReal Pro

| Function | Description | Return type |
|---|---|---|
| `convertChordproToIrealb(input)` | Convert ChordPro source to an `irealb://` URL (lossy — drops lyrics, fonts, capo) | `{ output: string, warnings: string[] }` |
| `convertIrealbToChordproText(input)` | Convert an `irealb://` URL to rendered ChordPro text | `{ output: string, warnings: string[] }` |
| `renderIrealSvg(input)` | Render an `irealb://` URL as an iReal Pro-style SVG chart | `string` (SVG document) |
| `renderIrealPng(input)` | Render an `irealb://` URL as a PNG image (300 DPI default, A4-equivalent canvas) | `Uint8Array` (PNG bytes) |
| `renderIrealPdf(input)` | Render an `irealb://` URL as a single-page A4 PDF | `Uint8Array` (PDF bytes) |
| `parseIrealb(input)` | Parse an `irealb://` URL into AST-shaped JSON (mirrors `IrealSong`) | `string` (JSON) |
| `serializeIrealb(input)` | Serialize an AST-shaped JSON string back into an `irealb://` URL (round-trip with `parseIrealb`) | `string` (URL) |

`convertChordproToIrealb` is lossy: lyrics, fonts / colours, and capo
are dropped because iReal has no surface for them. Each drop appears in
`warnings` as a `"<kind>: <message>"` string (`kind` is `lossy-drop`,
`approximated`, or `unsupported`).

`convertIrealbToChordproText` returns the `chordsketch-render-text`
rendering of the converted song, not raw ChordPro source — there is no
source emitter yet.

### Utility

| Function | Description | Return type |
|---|---|---|
| `version()` | Library version string | `string` |

Each element of `warnings` is a plain UTF-8 string containing a
human-readable diagnostic (e.g., `"{capo: 999} out of range 0..=11 — ignored"`).
Use the `*WithWarnings` variants when embedding the WASM package in a
UI that needs to show warnings inline or aggregate them across renders;
the plain `render_*` functions forward warnings to `console.warn`
instead.

## Links

- Project repository: <https://github.com/koedame/chordsketch>
- npm package: <https://www.npmjs.com/package/@chordsketch/wasm>
- Live playground: <https://chordsketch.koeda.me>
- API docs: <https://docs.rs/chordsketch-wasm>
- Issue tracker: <https://github.com/koedame/chordsketch/issues>

## License

[MIT](../../LICENSE)
