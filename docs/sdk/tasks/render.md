# Render to HTML, plain text, or PDF

Rendering is the universal SDK operation. Every binding accepts a
ChordPro string and returns rendered output in one of three formats:
plain text (chords above lyrics), self-contained HTML5, or A4 PDF.

The output is **byte-identical across every binding** for a given
input — language choice does not change rendering semantics. PRs
that introduce per-binding output drift are caught by the
fix-propagation rule (`.claude/rules/fix-propagation.md`).

## Input

```chordpro
{title: Amazing Grace}
{key: G}
[G]Amazing [G7]grace, how [C]sweet the [G]sound
```

## Rust

The renderer crates take a `&[Song]` (parsed by
`chordsketch-chordpro`) plus an optional transpose offset and a
`Config`. Use the convenience helpers to skip the hand-wired
config / transpose:

```rust
use chordsketch_chordpro::parse;
use chordsketch_render_html::render_song;
use chordsketch_render_text::render_song as render_text;
use chordsketch_render_pdf::render_song as render_pdf;

let song = parse(input)?;
let html: String     = render_song(&song);
let text: String     = render_text(&song);
let pdf:  Vec<u8>    = render_pdf(&song);
```

For multi-song input (`{new_song}` separator) parse with
`chordsketch_chordpro::parse_multi(input)` and pass the resulting
`Vec<Song>` to the `render_songs` family.

API reference: [docs.rs/chordsketch-render-html](https://docs.rs/chordsketch-render-html),
[`-text`](https://docs.rs/chordsketch-render-text),
[`-pdf`](https://docs.rs/chordsketch-render-pdf).

## `@chordsketch/wasm` (browser / Node ESM)

```ts
import init, {
  render_html,
  render_text,
  render_pdf,
} from '@chordsketch/wasm';

await init(); // browser only — Node auto-loads via wasm-pack --target nodejs

const html: string      = render_html(input);
const text: string      = render_text(input);
const pdf:  Uint8Array  = render_pdf(input);
```

The browser build requires `await init()` once before the first
call; the Node.js build auto-loads synchronously via `require`.
See [`packages/npm/README.md`](../../../packages/npm/README.md) for
the runtime-detection details and the dual-package layout.

## `@chordsketch/node` (Node.js native addon)

```ts
import { renderHtml, renderText, renderPdf } from '@chordsketch/node';

const html: string  = renderHtml(input);
const text: string  = renderText(input);
const pdf:  Buffer  = renderPdf(input);
```

NAPI exposes the functions as **camelCase** (napi-rs converts the
Rust snake_case automatically); the WASM package keeps snake_case.
`renderPdf` returns a Node.js `Buffer` (vs. `Uint8Array` for the
WASM build). No `init()` step — the native addon is loaded
synchronously by `require`. Prebuilt binaries are shipped for the
five supported platforms (linux-x64-gnu, linux-arm64-gnu,
darwin-x64, darwin-arm64, win32-x64-msvc); no Rust toolchain
required to install.

## CLI

The default subcommand reads ChordPro and renders to stdout (or
`--output FILE`):

```bash
# Plain text — chords above lyrics — is the default format
chordsketch song.cho

# HTML
chordsketch song.cho --format html

# PDF
chordsketch song.cho --format pdf --output song.pdf
```

`-` reads from stdin. `--help` lists every option.

## Python

```python
import chordsketch

html = chordsketch.parse_and_render_html(input, None, None)  # config_json, transpose
text = chordsketch.parse_and_render_text(input, None, None)
pdf  = chordsketch.parse_and_render_pdf(input, None, None)   # bytes
```

The UniFFI-backed bindings (Python / Swift / Kotlin / Ruby) do
parsing and rendering as a **single** `parse_and_render_*` call —
the AST is not exposed as a host-language object graph.

## Swift

```swift
import ChordSketch

let html = try parseAndRenderHtml(input: input, configJson: nil, transpose: nil)
let text = try parseAndRenderText(input: input, configJson: nil, transpose: nil)
let pdf  = try parseAndRenderPdf(input: input, configJson: nil, transpose: nil)  // [UInt8]
```

UniFFI converts the snake_case Rust function names to camelCase
Swift names automatically. PDF output is `[UInt8]` (the
`bytes` UDL type → Swift's byte sequence, per the Swift package
README).

## Kotlin

```kotlin
import uniffi.chordsketch.*

val html: String     = parseAndRenderHtml(input, null, null)
val text: String     = parseAndRenderText(input, null, null)
val pdf:  ByteArray  = parseAndRenderPdf(input, null, null)
```

The Maven coordinate is `me.koeda:chordsketch` but the package
namespace UniFFI generates is `uniffi.chordsketch` — that's the
import path in source.

## Ruby

```ruby
require 'chordsketch'

html = Chordsketch.parse_and_render_html(input, nil, nil)
text = Chordsketch.parse_and_render_text(input, nil, nil)
pdf  = Chordsketch.parse_and_render_pdf(input, nil, nil)  # binary string
```

## Errors

| Binding | Error type | Notes |
|---|---|---|
| Rust | `ParseError` (parse) / renderer infallible after parse | Carries `Span` (line + column) |
| WASM / npm | thrown `JsError` | Render-path errors carry only `.message`. Use `validate(input)` for structured `{line, column, message}` records. |
| NAPI / Node native | thrown `Error` | Same as WASM: render-path is `.message` only; `validate(input)` returns `ValidationError[]` with `line`, `column`, `message`. |
| CLI | non-zero exit + stderr | Currently `1` (`ExitCode::FAILURE`) on any error path; the binary does not yet differentiate parse vs. config vs. I/O failures via distinct exit codes. |
| Python | `chordsketch.ChordSketchError` exception | `.message` |
| Swift | `ChordSketchError` enum (`.invalidConfig(reason:)`, `.noSongsFound`, …) | `.message`-equivalent on the variant payload |
| Kotlin | `ChordSketchException` | `.message` |
| Ruby | `Chordsketch::ChordSketchError` | `.message` |

To validate input without rendering, use the `validate(input)`
function exposed by the WASM, NAPI, and UniFFI bindings (returns
an array of `{line, column, message}` records).

## Next step

[Transpose chords by N semitones](transpose.md) — same input,
shifted by a configurable number of semitones.
