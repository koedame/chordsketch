<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-render-ireal

[![crates.io](https://img.shields.io/crates/v/chordsketch-render-ireal)](https://crates.io/crates/chordsketch-render-ireal)

iReal Pro chart renderer — SVG with chord-name typography,
repeat barlines, ending brackets, and section labels.

This crate renders an `IrealSong` AST as a fixed-size SVG document.
The current scope covers the page frame, the metadata header
(title / composer / style / key), the 4-bars-per-line grid with
section line breaks, superscript chord-name typography (root +
accidental at base size, quality / extensions raised as
superscript at a smaller size, slash + bass back at base size),
repeat / final / double barline glyphs, N-th-ending brackets
with `1.` / `2.` labels, and section-letter labels above each
section start. Music symbols (segno / coda / D.C. / D.S.) land
in follow-up issue `#2062`.

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
| `compute_layout` | `fn compute_layout(song: &IrealSong) -> Layout` | Computes per-bar coordinates without rendering — useful to drive a non-SVG layout (e.g. canvas, web component grid). |
| `chord_to_typography` | `fn chord_to_typography(chord: &Chord) -> ChordTypography` | Splits a chord into root/extension/slash/bass `<tspan>`-ready spans. Public so the future PNG (#2064) / PDF (#2063) layers can compute alternative layouts. |
| `page::*` | `pub const i32` / `pub const usize` | Page-layout constants (`PAGE_WIDTH`, `PAGE_HEIGHT`, `MARGIN_X`, `MARGIN_Y`, `HEADER_BAND_HEIGHT`, `GRID_TOP`, `BARS_PER_ROW`, `BAR_ROW_HEIGHT`, `MAX_BARS`, `MAX_CHORDS_PER_BAR`, `CHORD_FONT_SIZE_BASE`, `CHORD_FONT_SIZE_SUPERSCRIPT`, `CHORD_SUPERSCRIPT_DY`). Changing any of them is a behavioural change that requires a fixture regen. |

## Layout

Output is a fixed-size SVG `(595 × 842)` with deterministic integer
coordinates so golden snapshots remain byte-stable. The page is
divided into:

- **Header band** — title (top), composer (right, omitted if
  absent), style + key (left, beneath the title; falls back to
  iReal Pro's "Medium Swing" default when style is unset).
- **Bar grid** — bars laid out 4-per-row by `compute_layout`. Each
  cell carries a centred chord-name `<text>` whose `<tspan>` runs
  apply iReal Pro's typography convention: root + accidental at
  base size, quality / extensions raised as superscript at a
  smaller size, slash + bass returning to base size on the original
  baseline. Trailing cells in a section's last row are filled with
  empty placeholders so the visible grid stays a clean rectangle;
  barlines / repeats / endings / music symbols layer on top in
  #2059 / #2062.

## Roadmap

| Feature | Tracking issue |
|---|---|
| Music symbols via Bravura font (segno / coda / D.C. / D.S.) | [#2062](https://github.com/koedame/chordsketch/issues/2062) |
| PNG rasterization via resvg | [#2064](https://github.com/koedame/chordsketch/issues/2064) |
| PDF output layer | [#2063](https://github.com/koedame/chordsketch/issues/2063) |

## Regenerating the golden fixtures

When the renderer changes intentionally:

```bash
UPDATE_GOLDEN=1 cargo test -p chordsketch-render-ireal
cargo test -p chordsketch-render-ireal   # re-run without the env var to confirm
```

The expected SVGs live under `tests/fixtures/<name>/expected.svg`
(currently `basic`, `twelve_bar_blues`, `aaba_32bar`,
`sixteen_bar_loop`, `section_break_irregular`, `multi_chord_bar`).

## Links

- [Project repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [API docs (docs.rs)](https://docs.rs/chordsketch-render-ireal)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

MIT.
