<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/node

[ChordSketch](https://github.com/koedame/chordsketch) native Node.js addon —
parse and render [ChordPro](https://www.chordpro.org/) and
[iReal Pro](https://www.irealpro.com/) chord charts with native
performance via [napi-rs](https://napi.rs/).

**Prebuilt binaries — no Rust toolchain required.**
Prefer this over `@chordsketch/wasm` when running in Node.js: no WASM overhead,
`Buffer` output for PDF, and better throughput for batch workloads. Use
`@chordsketch/wasm` for browser environments.

## Installation

```bash
npm install @chordsketch/node
```

Prebuilt binaries are published for five platforms and installed automatically
as optional dependencies:

| Platform | Package |
|----------|---------|
| Linux x86\_64 (glibc) | `@chordsketch/node-linux-x64-gnu` |
| Linux arm64 (glibc) | `@chordsketch/node-linux-arm64-gnu` |
| macOS x86\_64 | `@chordsketch/node-darwin-x64` |
| macOS arm64 (Apple Silicon) | `@chordsketch/node-darwin-arm64` |
| Windows x86\_64 | `@chordsketch/node-win32-x64-msvc` |

## Quick Start

```js
import { renderHtml, renderText, renderPdf, version } from '@chordsketch/node';

const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

const html = renderHtml(source);   // string — full HTML document
const text = renderText(source);   // string — plain text with chord lines above lyrics
const pdf  = renderPdf(source);    // Buffer — raw PDF bytes

console.log(`ChordSketch ${version()}`);
```

## API

The tables below cover every `#[napi]`-exported `pub fn` in
[`crates/napi/src/lib.rs`](src/lib.rs).

### Basic rendering

| Function | Returns | Description |
|----------|---------|-------------|
| `renderText(source)` | `string` | Plain text: chord names above lyric lines |
| `renderHtml(source)` | `string` | Full HTML document |
| `renderPdf(source)` | `Buffer` | Raw PDF bytes |

### Rendering with options

| Function | Returns | Description |
|----------|---------|-------------|
| `renderTextWithOptions(source, options)` | `string` | Text with transposition / config |
| `renderHtmlWithOptions(source, options)` | `string` | HTML with transposition / config |
| `renderPdfWithOptions(source, options)` | `Buffer` | PDF with transposition / config |

### Body-only HTML and stylesheet

| Function | Returns | Description |
|----------|---------|-------------|
| `renderHtmlBody(source)` | `string` | Body-only `<div class="song">…</div>` HTML fragment with no `<!DOCTYPE>` / `<html>` / `<head>` / `<title>` / embedded `<style>` — pair with `renderHtmlCss` when the host supplies its own document envelope |
| `renderHtmlBodyWithOptions(source, options)` | `string` | Same as `renderHtmlBody`, with transposition / config |
| `renderHtmlCss()` | `string` | Canonical chord-over-lyrics CSS that `renderHtml` embeds inside `<style>` (byte-stable; safe to hash for cache-busting) |
| `renderHtmlCssWithOptions(options)` | `string` | Variant of `renderHtmlCss` that honours `settings.wraplines` from the supplied options (when `wraplines` is false, `.line` emits `flex-wrap: nowrap`) |

### Captured warnings

| Function | Returns | Description |
|----------|---------|-------------|
| `renderTextWithWarnings(source)` | `{ output: string, warnings: string[] }` | Text render that captures warnings as structured data |
| `renderHtmlWithWarnings(source)` | `{ output: string, warnings: string[] }` | HTML render with captured warnings |
| `renderPdfWithWarnings(source)` | `{ output: Buffer, warnings: string[] }` | PDF render with captured warnings |
| `renderHtmlBodyWithWarnings(source)` | `{ output: string, warnings: string[] }` | Body-only HTML fragment with captured warnings (body counterpart to `renderHtmlWithWarnings`) |
| `renderTextWithWarningsAndOptions(source, options)` | `{ output: string, warnings: string[] }` | `renderTextWithWarnings` + transposition / config |
| `renderHtmlWithWarningsAndOptions(source, options)` | `{ output: string, warnings: string[] }` | `renderHtmlWithWarnings` + transposition / config |
| `renderPdfWithWarningsAndOptions(source, options)` | `{ output: Buffer, warnings: string[] }` | `renderPdfWithWarnings` + transposition / config |
| `renderHtmlBodyWithWarningsAndOptions(source, options)` | `{ output: string, warnings: string[] }` | `renderHtmlBodyWithWarnings` + transposition / config |

### iReal Pro conversion

| Function | Returns | Description |
|----------|---------|-------------|
| `convertChordproToIrealb(source)` | `{ output: string, warnings: string[] }` | Convert ChordPro source to an `irealb://` URL (lossy — drops lyrics, fonts, capo) |
| `convertIrealbToChordproText(url)` | `{ output: string, warnings: string[] }` | Convert an `irealb://` URL to rendered ChordPro text |
| `renderIrealSvg(url)` | `string` (SVG document) | Render an `irealb://` URL as an iReal Pro-style SVG chart |
| `renderIrealPng(url)` | `Buffer` (PNG bytes) | Render an `irealb://` URL as a PNG image (300 DPI default, A4-equivalent canvas) |
| `renderIrealPdf(url)` | `Buffer` (PDF bytes) | Render an `irealb://` URL as a single-page A4 PDF document |
| `parseIrealb(url)` | `string` (JSON) | Parse an `irealb://` URL into AST-shaped JSON (mirrors `IrealSong`) |
| `serializeIrealb(json)` | `string` (URL) | Serialize an AST-shaped JSON string back into an `irealb://` URL (round-trips with `parseIrealb`) |

The `output` of `convertIrealbToChordproText` is the
`chordsketch-render-text` rendering of the converted song, not raw
ChordPro source. The `warnings` array contains
`"<kind>: <message>"` strings (`kind` is `lossy-drop`,
`approximated`, or `unsupported`).

```js
import { convertChordproToIrealb, convertIrealbToChordproText } from '@chordsketch/node';

const { output: url, warnings } = convertChordproToIrealb(`{title: Test}\n[C]Hello`);
console.log(url);       // "irealb://..."
console.log(warnings);  // ["lossy-drop: lyrics are dropped", ...]

const { output: text } = convertIrealbToChordproText(url);
console.log(text);
```

> **Note:** `renderPdf` and `renderPdfWithWarnings` return a Node.js `Buffer`
> (not `Uint8Array`). This differs from `@chordsketch/wasm` where PDF output
> is `Uint8Array`.

> **When to use `*WithWarnings`:** the plain `render*` functions forward
> warnings to process stderr via `eprintln!`, which is invisible to most
> UI callers. The `*WithWarnings` variants return the warnings as an
> array of strings so they can be shown inline, aggregated, or
> suppressed. See #1827.

### Validation

| Function | Returns | Description |
|----------|---------|-------------|
| `validate(source)` | `ValidationError[]` (`{ line: number, column: number, message: string }`, line / column one-based) | Validate ChordPro input and return any parse errors as structured records (empty array if clean). Mirrors the WASM `validate` shape and the FFI `ValidationError` dictionary. |

```js
import { validate } from '@chordsketch/node';

const errors = validate(source); // ValidationError[] — empty array if clean
for (const { line, column, message } of errors) {
  console.warn(`line ${line}, column ${column}: ${message}`);
}
```

### Chord diagrams

| Function | Returns | Description |
|----------|---------|-------------|
| `chordDiagramSvg(chord, instrument)` | `string \| null` (SVG markup) | Render a chord diagram as inline SVG. `instrument` is `"guitar"`, `"ukulele"` (alias `"uke"`), or `"piano"` (aliases `"keyboard"`, `"keys"`). Returns `null` when the chord is not in the built-in voicing database; throws on unknown instrument. |

### Utility

| Function | Returns |
|----------|---------|
| `version()` | `string` — library version |

## Options

```ts
interface RenderOptions {
  /** Semitone transposition offset. Default: 0.
   *  Values outside the i8 range (-128..127) are clamped, then reduced mod 12. */
  transpose?: number;

  /** Preset name ("guitar", "ukulele") or inline RRJSON configuration string. */
  config?: string;
}
```

### Rendering with options

```js
import { renderHtmlWithOptions, renderTextWithOptions } from '@chordsketch/node';

// Transpose up 2 semitones using the ukulele preset
const html = renderHtmlWithOptions(source, { transpose: 2, config: 'ukulele' });

// Inline RRJSON config
const text = renderTextWithOptions(source, {
  config: '{"settings": {"notation": "solfege"}}',
});
```

## Error handling

Functions throw a JavaScript `Error` if the `config` option is not a known
preset name and is also not valid RRJSON.

```js
import { renderHtml } from '@chordsketch/node';

try {
  renderHtml(source);
} catch (err) {
  console.error(err.message);
}
```

Parse errors in the ChordPro input are **not** thrown — the renderer is
lenient and produces a best-effort result. Call `validate()` to surface
diagnostics without rendering.

## Links

- **Project**: https://github.com/koedame/chordsketch
- **Playground**: https://chordsketch.koeda.me
- **Issues**: https://github.com/koedame/chordsketch/issues
- **WASM package** (browser): [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm)

## License

MIT
