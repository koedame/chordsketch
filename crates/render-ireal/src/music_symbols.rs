//! Music-symbol glyph rendering (segno / coda / D.C. / D.S. / fine).
//!
//! Each glyph is positioned above the bar that carries it (read
//! from `Bar.symbol`), in the same band that section labels and
//! ending brackets occupy. The drawn shape is a SVG-primitive
//! approximation of the SMuFL glyphs from Bravura — see the
//! `## Deferred` section in PR #2062's body for the reasoning
//! behind not bundling the Bravura font itself (≈ 3 MB
//! per-export overhead).
//!
//! ## Glyph shapes
//!
//! - **Segno** (`Segno`) — an "S" stroke + diagonal slash + two
//!   dots, drawn with `<path>` for the stroke and `<line>` /
//!   `<circle>` for the slash and dots.
//! - **Coda** (`Coda`) — a circle with a vertical and a
//!   horizontal line forming a cross through its centre.
//! - **D.C.** (`DaCapo`) / **D.S.** (`DalSegno`) / **Fine**
//!   (`Fine`) — italicised serif-style `<text>` runs (these are
//!   text directives in iReal Pro, not Unicode music glyphs).

use crate::layout::Layout;
use crate::svg;
use chordsketch_ireal::{IrealSong, MusicalSymbol};

/// Vertical gap between the row top and the symbol's bottom edge.
/// Larger than [`crate::markers`]'s `ENDING_BRACKET_GAP` so the
/// symbol sits above the bracket when both apply to the same bar.
const SYMBOL_BOTTOM_GAP: i32 = 10;

/// Approximate height of a music glyph (segno / coda) in SVG units.
const GLYPH_SIZE: i32 = 18;

/// Half-size — used as the radius for the coda's circle and the
/// reach of the segno's stroke from its centre.
const HALF_GLYPH: i32 = GLYPH_SIZE / 2;

/// Renders music-symbol glyphs above each bar that carries one.
///
/// Bars without a `Bar.symbol` produce no output. Symbols are
/// laid out independently per bar — adjacent bars carrying the
/// same symbol do NOT merge (the symbol is a per-bar
/// instruction, not a span).
#[must_use]
pub(crate) fn render_music_symbols(song: &IrealSong, layout: &Layout) -> String {
    let mut out = String::new();
    for cell in &layout.bars {
        // Flatten the (section, bar, symbol) lookup into a single
        // `let-else` so the "this bar carries no symbol" branch (the
        // overwhelming common case) and the "stale `BarCoord` for a
        // bar that no longer exists in the AST" defensive branch
        // share one `continue`. The defensive branch matches the
        // pattern in `lib.rs::chords_for_bar` — the layout engine
        // never produces stale indices for the song that built it,
        // but a hand-rolled `Layout` could, and crashing here would
        // be worse than silently dropping the symbol.
        let Some(symbol) = song
            .sections
            .get(cell.section_index)
            .and_then(|s| s.bars.get(cell.bar_index_in_section))
            .and_then(|b| b.symbol)
        else {
            continue;
        };
        // Centre the glyph horizontally over the cell's left edge
        // (iReal Pro's convention) — slightly inset to keep the
        // glyph clear of any barline overlay at the cell boundary.
        let glyph_cx = cell.x + HALF_GLYPH + 4;
        // Bottom edge of the glyph sits `SYMBOL_BOTTOM_GAP` above
        // the row top. Glyph extends upward from there.
        let glyph_bottom_y = cell.y - SYMBOL_BOTTOM_GAP;
        let glyph_top_y = glyph_bottom_y - GLYPH_SIZE;
        let glyph_cy = (glyph_top_y + glyph_bottom_y) / 2;
        match symbol {
            MusicalSymbol::Segno => {
                emit_segno(&mut out, glyph_cx, glyph_cy);
            }
            MusicalSymbol::Coda => {
                emit_coda(&mut out, glyph_cx, glyph_cy);
            }
            MusicalSymbol::DaCapo => {
                emit_text_directive(&mut out, cell.x + 4, glyph_bottom_y, "D.C.");
            }
            MusicalSymbol::DalSegno => {
                emit_text_directive(&mut out, cell.x + 4, glyph_bottom_y, "D.S.");
            }
            MusicalSymbol::Fine => {
                emit_text_directive(&mut out, cell.x + 4, glyph_bottom_y, "Fine");
            }
        }
    }
    out
}

fn emit_segno(out: &mut String, cx: i32, cy: i32) {
    // Stylised segno: an S-curve approximated with two arcs, a
    // diagonal slash through the centre, and two diagonally-
    // opposed dots. The path data uses absolute SVG path
    // commands so the glyph renders identically across viewers.
    let r = HALF_GLYPH;
    let stroke_width = 2;
    // S-curve: upper-right hook, then lower-left hook.
    out.push_str(&format!(
        "    <path d=\"M {x1} {y1} C {cx1} {cy1}, {cx2} {cy2}, {x2} {y2} \
S {cx3} {cy3}, {x3} {y3}\" stroke=\"black\" stroke-width=\"{stroke_width}\" \
fill=\"none\" class=\"music-symbol-segno-curve\"/>\n",
        x1 = cx + r - 2,
        y1 = cy - r + 2,
        cx1 = cx - r,
        cy1 = cy - r + 2,
        cx2 = cx + r,
        cy2 = cy - 2,
        x2 = cx,
        y2 = cy + 2,
        cx3 = cx + r,
        cy3 = cy + r - 2,
        x3 = cx - r + 2,
        y3 = cy + r - 2,
    ));
    // Diagonal slash from upper-left to lower-right.
    out.push_str(&format!(
        "    <line x1=\"{x1}\" y1=\"{y1}\" x2=\"{x2}\" y2=\"{y2}\" \
stroke=\"black\" stroke-width=\"1\" class=\"music-symbol-segno-slash\"/>\n",
        x1 = cx - r,
        y1 = cy - r,
        x2 = cx + r,
        y2 = cy + r,
    ));
    // Dots at upper-right and lower-left.
    out.push_str(&format!(
        "    <circle cx=\"{cx_dot}\" cy=\"{cy_dot}\" r=\"1.5\" fill=\"black\" \
class=\"music-symbol-segno-dot\"/>\n",
        cx_dot = cx + r - 2,
        cy_dot = cy - r + 4,
    ));
    out.push_str(&format!(
        "    <circle cx=\"{cx_dot}\" cy=\"{cy_dot}\" r=\"1.5\" fill=\"black\" \
class=\"music-symbol-segno-dot\"/>\n",
        cx_dot = cx - r + 2,
        cy_dot = cy + r - 4,
    ));
}

fn emit_coda(out: &mut String, cx: i32, cy: i32) {
    // Coda glyph: circle with cross. The cross arms extend
    // slightly past the circle (typical of SMuFL "coda" /
    // U+1D10C) so the cross is visible against any background.
    let r = HALF_GLYPH;
    let stroke_width = 2;
    let extension = 3;
    out.push_str(&format!(
        "    <circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"none\" stroke=\"black\" \
stroke-width=\"{stroke_width}\" class=\"music-symbol-coda-circle\"/>\n"
    ));
    out.push_str(&format!(
        "    <line x1=\"{x1}\" y1=\"{cy}\" x2=\"{x2}\" y2=\"{cy}\" stroke=\"black\" \
stroke-width=\"1\" class=\"music-symbol-coda-cross\"/>\n",
        x1 = cx - r - extension,
        x2 = cx + r + extension,
    ));
    out.push_str(&format!(
        "    <line x1=\"{cx}\" y1=\"{y1}\" x2=\"{cx}\" y2=\"{y2}\" stroke=\"black\" \
stroke-width=\"1\" class=\"music-symbol-coda-cross\"/>\n",
        y1 = cy - r - extension,
        y2 = cy + r + extension,
    ));
}

fn emit_text_directive(out: &mut String, x: i32, baseline_y: i32, text: &str) {
    let escaped = svg::escape_xml(text);
    out.push_str(&format!(
        "    <text x=\"{x}\" y=\"{baseline_y}\" font-family=\"serif\" font-size=\"11\" \
font-style=\"italic\" class=\"music-symbol-text\">{escaped}</text>\n"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute_layout;
    use chordsketch_ireal::{Bar, IrealSong, Section, SectionLabel};

    fn bar_with_symbol(symbol: MusicalSymbol) -> Bar {
        Bar {
            symbol: Some(symbol),
            ..Bar::new()
        }
    }

    fn empty_bar() -> Bar {
        Bar::new()
    }

    fn section(label: char, bars: Vec<Bar>) -> Section {
        Section {
            label: SectionLabel::Letter(label),
            bars,
        }
    }

    #[test]
    fn no_symbols_emit_no_output() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![empty_bar(), empty_bar()]));
        let layout = compute_layout(&song);
        assert!(render_music_symbols(&song, &layout).is_empty());
    }

    #[test]
    fn segno_emits_path_slash_and_dots() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::Segno)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains("class=\"music-symbol-segno-curve\""));
        assert!(svg.contains("class=\"music-symbol-segno-slash\""));
        // Two dots.
        assert_eq!(
            svg.matches("class=\"music-symbol-segno-dot\"").count(),
            2,
            "segno must emit two dots: {svg}"
        );
    }

    #[test]
    fn coda_emits_circle_with_horizontal_and_vertical_cross() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::Coda)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains("class=\"music-symbol-coda-circle\""));
        assert_eq!(
            svg.matches("class=\"music-symbol-coda-cross\"").count(),
            2,
            "coda must emit horizontal + vertical cross arms: {svg}"
        );
    }

    #[test]
    fn da_capo_emits_dc_text() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::DaCapo)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains(">D.C.</text>"));
        assert!(svg.contains("font-style=\"italic\""));
    }

    #[test]
    fn dal_segno_emits_ds_text() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::DalSegno)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains(">D.S.</text>"));
    }

    #[test]
    fn fine_emits_fine_text() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::Fine)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains(">Fine</text>"));
    }

    #[test]
    fn each_symbol_anchors_to_its_bar_y() {
        // Two bars, each with a different symbol. The two glyphs
        // should sit on the same `cy` since both bars are in row 0.
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![
                bar_with_symbol(MusicalSymbol::Segno),
                bar_with_symbol(MusicalSymbol::Coda),
            ],
        ));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        // Segno path appears at glyph_cx = first cell's left + HALF_GLYPH + 4.
        // Coda circle appears at glyph_cx = second cell's left + HALF_GLYPH + 4.
        assert!(svg.contains("class=\"music-symbol-segno-curve\""));
        assert!(svg.contains("class=\"music-symbol-coda-circle\""));
    }

    #[test]
    fn empty_song_emits_no_symbols() {
        let song = IrealSong::new();
        let layout = compute_layout(&song);
        assert!(render_music_symbols(&song, &layout).is_empty());
    }
}
