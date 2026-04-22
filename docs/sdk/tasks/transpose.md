# Transpose chords by N semitones

Every binding accepts a transposition offset (`-128..=127`
semitones) and shifts every chord in the song by that amount before
rendering. Internally the offset is reduced modulo 12, so
`+12 == 0` and `+13 == +1` produce identical output.

The same transposition produces the same rendered output across
every binding for any given input.

## Input + offset

We will transpose this fragment **up by 2 semitones** (G → A) in
every snippet:

```chordpro
{title: Amazing Grace}
{key: G}
[G]Amazing [G7]grace, how [C]sweet the [G]sound
```

Expected: chords become `[A] [A7] [D] [A]`.

## Rust

```rust
use chordsketch_chordpro::{config::Config, parse};
use chordsketch_render_html::render_song_with_transpose;

let song = parse(input)?;
let html: String = render_song_with_transpose(&song, 2, &Config::defaults());
```

`render_song_with_transpose(&song, 2, &Config::defaults())` is the
direct API. The `_text` and `_pdf` renderer crates expose the same
shape (`render_song_with_transpose` returning `String` / `Vec<u8>`).

For multi-song input use `render_songs_with_transpose(&songs, 2, &Config::defaults())`.

## `@chordsketch/wasm`

```ts
import init, { render_html_with_options } from '@chordsketch/wasm';

await init();

const html = render_html_with_options(input, { transpose: 2 });
```

`{transpose: number}` accepts integers; values outside
the `i8` range (`-128..=127`) reject with an error to match the
other bindings (#1826). The `_with_options` variants exist for
each format (`render_html_with_options` / `render_text_with_options`
/ `render_pdf_with_options`).

## `@chordsketch/node`

```ts
import { renderHtmlWithOptions } from '@chordsketch/node';

const html = renderHtmlWithOptions(input, { transpose: 2 });
```

NAPI uses **camelCase** function names (napi-rs converts the Rust
snake_case automatically); the options-object shape is the same as
the WASM build. Out-of-range values reject with
`Status::InvalidArg` (#1826 — previously this binding silently
clamped, which has since been fixed for cross-binding parity).

## CLI

```bash
chordsketch song.cho --transpose 2 --format html
```

`--transpose` accepts any signed 8-bit integer.

## Python

```python
import chordsketch

# Positional args: input, config_json, transpose
html = chordsketch.parse_and_render_html(input, None, 2)
```

## Swift

```swift
import ChordSketch

let html = try parseAndRenderHtml(input: input, configJson: nil, transpose: 2)
```

## Kotlin

```kotlin
import uniffi.chordsketch.parseAndRenderHtml

val html = parseAndRenderHtml(input, null, 2)
```

The Maven coordinate is `me.koeda:chordsketch` but the import
path UniFFI generates is `uniffi.chordsketch.*`.

## Ruby

```ruby
require 'chordsketch'

html = Chordsketch.parse_and_render_html(input, nil, 2)
```

The Ruby method signature matches the Python order: `(input,
config_json, transpose)`. The capital-C `Chordsketch` module
namespace is required (lowercase rest).

## Range and edge cases

- **Range**: `-128..=127` (`i8`), reduced modulo 12 internally.
  Out-of-range values reject with an error (Rust: `ParseError`;
  bindings: their respective error type) — they are not silently
  clamped. Since #1826 every binding agrees on this contract.
- **Zero offset**: `transpose = 0` is a no-op and is the default
  when omitted (`null` / `None` / `nil`).
- **Saturated transpositions**: A few rendering paths emit a
  warning when transposition produces a chord that the renderer
  cannot place faithfully (e.g. extreme accidental spelling).
  Structured warning capture is available through the
  `_with_warnings` variants in every binding that exposes them:
  Rust (`render_*_with_warnings`), WASM
  (`render_*_with_warnings_and_options`), NAPI
  (`render*WithWarningsAndOptions`), and UniFFI bindings —
  Python / Swift / Kotlin / Ruby — via the
  `parse_and_render_*_with_warnings` variants which return a
  struct carrying both the rendered output and a `Vec<String>` of
  warnings. The default (non-`_with_warnings`) entry points
  forward warnings to stderr.

## Next step

[Render to HTML, plain text, or PDF](render.md) — the underlying
operation that transposition feeds into.
