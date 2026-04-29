<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-render-ireal

[![crates.io](https://img.shields.io/crates/v/chordsketch-render-ireal)](https://crates.io/crates/chordsketch-render-ireal)

iReal Pro chart renderer — SVG with 4-bars-per-line grid layout.

This crate renders an `IrealSong` AST as a fixed-size SVG document.
The current scope (`#2058` scaffold + `#2060` layout engine) covers
the page frame, the metadata header (title / composer / style /
key), the 4-bars-per-line grid with section line breaks, and
flat-layout chord text centred in each cell. Barlines, repeat /
ending brackets, music symbols, and superscript chord-name
typography land in follow-up issues (`#2057` / `#2059` / `#2062`).

Tracked under [#2050](https://github.com/koedame/chordsketch/issues/2050).

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Installation

Add via `cargo add` (resolves to the latest published version automatically):

```bash
cargo add chordsketch-render-ireal
```

Or pin manually — replace `VERSION` with the value shown on the badge above:

```toml
[dependencies]
chordsketch-render-ireal = "VERSION"
```

## Quick start

```rust
use chordsketch_ireal::IrealSong;
use chordsketch_render_ireal::{RenderOptions, render_svg};

let song = IrealSong::new();
let svg = render_svg(&song, &RenderOptions::default());
assert!(svg.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
assert!(svg.contains("<svg "));
```

## API

| Item | Signature | Notes |
|---|---|---|
| `render_svg` | `fn render_svg(song: &IrealSong, options: &RenderOptions) -> String` | Returns a fixed-size SVG document. Output is byte-stable for a given input. |
| `RenderOptions` | `#[non_exhaustive]` struct, `Default` | Caller-supplied configuration; the scaffold accepts only defaults. |
| `version()` | `fn version() -> &'static str` | Library version baked in at compile time. |
| `page::*` | `pub const i32` / `pub const usize` | Page-layout constants (`PAGE_WIDTH`, `PAGE_HEIGHT`, `MARGIN_X`, `MARGIN_Y`, `HEADER_BAND_HEIGHT`, `GRID_TOP`, `BARS_PER_ROW`, `BAR_ROW_HEIGHT`). Changing any of them is a behavioural change that requires a fixture regen. |

## Layout

Output is a fixed-size SVG `(595 × 842)` with deterministic integer
coordinates so golden snapshots remain byte-stable. The page is
divided into:

- **Header band** — title (top), composer (right, omitted if
  absent), style + key (left, beneath the title; falls back to
  iReal Pro's "Medium Swing" default when style is unset).
- **Bar grid** — bars laid out 4-per-row in equal-width cells
  below the header. Each cell is currently an empty `<rect>`;
  chord text and inner glyphs are filled in by the follow-up
  crates / issues.

## Roadmap

| Feature | Tracking issue |
|---|---|
| 4-bars-per-line grid layout engine | [#2060](https://github.com/koedame/chordsketch/issues/2060) |
| Repeat barlines, endings, section markers | [#2059](https://github.com/koedame/chordsketch/issues/2059) |
| Chord-name typography with superscripts | [#2057](https://github.com/koedame/chordsketch/issues/2057) |
| Music symbols via Bravura font (segno / coda / D.C. / D.S.) | [#2062](https://github.com/koedame/chordsketch/issues/2062) |
| PNG rasterization via resvg | [#2064](https://github.com/koedame/chordsketch/issues/2064) |
| PDF output layer | [#2063](https://github.com/koedame/chordsketch/issues/2063) |

## Regenerating the golden fixture

When the renderer changes intentionally:

```bash
UPDATE_GOLDEN=1 cargo test -p chordsketch-render-ireal
cargo test -p chordsketch-render-ireal   # re-run without the env var to confirm
```

The expected SVG lives at `tests/fixtures/basic/expected.svg`.

## Links

- [Project repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [API docs (docs.rs)](https://docs.rs/chordsketch-render-ireal)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

MIT.
