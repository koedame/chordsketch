<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-render-ireal

[![crates.io](https://img.shields.io/crates/v/chordsketch-render-ireal)](https://crates.io/crates/chordsketch-render-ireal)

iReal Pro chart renderer — SVG with chord-name typography,
repeat barlines, ending brackets, section labels, and music
symbols.

This crate renders an `IrealSong` AST as a fixed-size SVG document.
The current scope covers the page frame, the metadata header
(title / composer / style / key), the 4-bars-per-line grid with
section line breaks, superscript chord-name typography (root +
accidental at base size, quality / extensions raised as
superscript at a smaller size, slash + bass back at base size),
repeat / final / double barline glyphs, N-th-ending brackets
with `1.` / `2.` labels, section-letter labels above each
section start, and music-symbol glyphs (segno / coda; `D.C.` /
`D.S.` / `Fine` text directives) above the bar that carries them.

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
  empty placeholders so the visible grid stays a clean rectangle.
  Music-symbol glyphs sit in the same band as the section label
  / ending bracket and are drawn last so they layer on top of any
  overlap.

## Roadmap

| Feature | Tracking issue |
|---|---|
| Bravura SMuFL font for high-fidelity music glyphs | [#2062](https://github.com/koedame/chordsketch/issues/2062) (deferred — current SVG primitive approximations avoid a ~3 MB per-export font payload) |
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
`sixteen_bar_loop`, `section_break_irregular`, `multi_chord_bar`,
`repeats_demo`, `endings_demo`, `section_markers_demo`,
`final_barline_demo`, `segno_demo`, `coda_demo`, `dc_demo`,
`ds_demo`, `fine_demo`).

## Links

- [Project repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [API docs (docs.rs)](https://docs.rs/chordsketch-render-ireal)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

MIT.
