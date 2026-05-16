//! Music-symbol glyph rendering (segno / coda / D.C. / D.S. / fine).
//!
//! Each glyph is positioned above the bar that carries it (read
//! from `Bar.symbol`), in the same band that section labels and
//! ending brackets occupy. The drawn shape is a real SMuFL outline
//! from the Bravura font, baked as static SVG `<path>` data — see
//! [`crate::bravura`] for the source / extraction provenance and
//! [ADR-0014](../../../docs/adr/0014-bravura-glyphs-as-svg-paths.md)
//! for the bundling-architecture decision.
//!
//! ## Glyph shapes
//!
//! - **Segno** (`Segno`) — Bravura U+E047 outline, scaled and
//!   Y-flipped from font units to SVG.
//! - **Coda** (`Coda`) — Bravura U+E048 outline, same transform.
//! - **Fermata** (`Fermata`) — Bravura U+E4C0 (`fermataAbove`)
//!   outline, same transform. Spec: lowercase `f` in the iReal Pro
//!   Rehearsal Marks table.
//! - **D.C.** (`DaCapo`) / **D.S.** (`DalSegno`) / **Fine**
//!   (`Fine`) — italicised serif `<text>` runs (these are text
//!   directives in iReal Pro's data model, not SMuFL glyph
//!   codepoints, so they remain text rather than being rewritten
//!   onto Bravura's `dynamicForte` / `dynamicMezzo` clusters).

use crate::bravura;
use crate::layout::Layout;
use crate::svg;
use chordsketch_ireal::{IrealSong, MusicalSymbol};

/// Vertical gap between the row top and the symbol's bottom edge.
/// Larger than [`crate::markers`]'s `ENDING_BRACKET_GAP` so the
/// symbol sits above the bracket when both apply to the same bar.
const SYMBOL_BOTTOM_GAP: i32 = 10;

/// Em-size of the SMuFL glyph in SVG units. The visible glyph
/// height is intrinsic to each Bravura outline (segno occupies
/// ~786/1000 of the em, coda ~1056/1000), so the segno renders
/// slightly shorter than `GLYPH_SIZE` while the coda renders
/// slightly taller — matches SMuFL's design intent.
const GLYPH_SIZE: i32 = 18;

/// Half of [`GLYPH_SIZE`] — used as the vertical-anchor offset that
/// places the bbox center `HALF_GLYPH` above the bar row top.
const HALF_GLYPH: i32 = GLYPH_SIZE / 2;

/// Horizontal inset from the cell's left edge for both the
/// glyph-anchor (`glyph_cx = cell.x + HALF_GLYPH + GLYPH_LEFT_INSET`)
/// and the text-directive starting `x`. Keeps the glyph clear of
/// any barline overlay at the cell boundary and lets the segno /
/// coda glyphs share their left-most extent with the leading edge
/// of the `D.C.` / `D.S.` / `Fine` text directives.
const GLYPH_LEFT_INSET: i32 = 4;

/// Font size for the italicised text directives (`D.C.` / `D.S.`
/// / `Fine`). Smaller than the chord-name base font so the
/// directive does not visually compete with the chord text.
const TEXT_DIRECTIVE_FONT_SIZE: i32 = 11;

/// SVG `scale(s, -s)` factor that maps font units to SVG units. The
/// Y component is negated at the call site because OpenType
/// outlines have +Y up while SVG has +Y down. Emitted with `{:.4}`
/// so the golden snapshots pin a fixed digit count; without that,
/// the default `f32` `Display` formatter would expand the value to
/// however many digits round-trip — fine for parsing, but a future
/// `core::fmt` change to that round-trip width would silently
/// rewrite every iReal SVG snapshot.
fn glyph_scale() -> f32 {
    GLYPH_SIZE as f32 / bravura::UPEM as f32
}

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
        // Anchor the glyph horizontally to `cell.x + HALF_GLYPH +
        // GLYPH_LEFT_INSET` — the glyph's bbox center lands on this
        // X so segno and coda share a consistent left margin with
        // the text directives below.
        let glyph_cx = cell.x + HALF_GLYPH + GLYPH_LEFT_INSET;
        // Bottom edge of the em-square sits `SYMBOL_BOTTOM_GAP` above
        // the row top. The em-square center is `HALF_GLYPH` above
        // that — the actual glyph extents may differ from the em by
        // up to ~28% (coda) but always remain in the row's symbol
        // band.
        let glyph_bottom_y = cell.y - SYMBOL_BOTTOM_GAP;
        let glyph_cy = glyph_bottom_y - HALF_GLYPH;
        match symbol {
            MusicalSymbol::Segno => {
                emit_smufl_path(
                    &mut out,
                    "music-symbol-segno",
                    bravura::SEGNO_PATH_D,
                    glyph_cx,
                    glyph_cy,
                    bravura::SEGNO_FONT_CX as f32,
                    bravura::SEGNO_FONT_CY as f32,
                );
            }
            MusicalSymbol::Coda => {
                emit_smufl_path(
                    &mut out,
                    "music-symbol-coda",
                    bravura::CODA_PATH_D,
                    glyph_cx,
                    glyph_cy,
                    bravura::CODA_FONT_CX,
                    bravura::CODA_FONT_CY as f32,
                );
            }
            MusicalSymbol::Fermata => {
                emit_smufl_path(
                    &mut out,
                    "music-symbol-fermata",
                    bravura::FERMATA_PATH_D,
                    glyph_cx,
                    glyph_cy,
                    bravura::FERMATA_FONT_CX as f32,
                    bravura::FERMATA_FONT_CY as f32,
                );
            }
            MusicalSymbol::DaCapo => {
                emit_text_directive(&mut out, cell.x + GLYPH_LEFT_INSET, glyph_bottom_y, "D.C.");
            }
            MusicalSymbol::DalSegno => {
                emit_text_directive(&mut out, cell.x + GLYPH_LEFT_INSET, glyph_bottom_y, "D.S.");
            }
            MusicalSymbol::Fine => {
                emit_text_directive(&mut out, cell.x + GLYPH_LEFT_INSET, glyph_bottom_y, "Fine");
            }
        }
    }
    out
}

/// Emits one SMuFL glyph as a single `<path>` element with a
/// composite transform that places `(font_cx, font_cy)` at the SVG
/// anchor `(glyph_cx, glyph_cy)` while flipping the Y axis (font
/// outlines are +Y up, SVG is +Y down).
///
/// The transform is composed right-to-left (per SVG spec):
///   1. `translate(-font_cx, -font_cy)` — moves the glyph's bbox
///      center to the origin in font space.
///   2. `scale(s, -s)` — converts font units to SVG units and flips
///      Y.
///   3. `translate(glyph_cx, glyph_cy)` — moves the origin to the
///      caller's anchor point.
fn emit_smufl_path(
    out: &mut String,
    class: &str,
    path_d: &str,
    glyph_cx: i32,
    glyph_cy: i32,
    font_cx: f32,
    font_cy: f32,
) {
    let s = glyph_scale();
    out.push_str(&format!(
        "    <path class=\"{class}\" \
transform=\"translate({glyph_cx},{glyph_cy}) scale({s:.4},{neg_s:.4}) \
translate({tx:.1},{ty:.1})\" d=\"{path_d}\" fill=\"black\"/>\n",
        neg_s = -s,
        tx = -font_cx,
        ty = -font_cy,
    ));
}

fn emit_text_directive(out: &mut String, x: i32, baseline_y: i32, text: &str) {
    let escaped = svg::escape_xml(text);
    out.push_str(&format!(
        "    <text x=\"{x}\" y=\"{baseline_y}\" font-family=\"serif\" \
font-size=\"{TEXT_DIRECTIVE_FONT_SIZE}\" \
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

    /// Number of leading bytes of the path constants to compare
    /// against in `*_emits_bravura_outline`. Bravura outline path
    /// strings are pure ASCII (pinned by `bravura::tests::
    /// glyph_paths_are_ascii`), so byte-slicing on the `&str`
    /// borrows on a `char` boundary by construction — no
    /// `chars().take(N)` round-trip needed.
    const PREFIX_LEN: usize = 32;

    #[test]
    fn segno_emits_bravura_outline() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::Segno)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains("class=\"music-symbol-segno\""));
        // Bravura's segno outline starts with this absolute moveto;
        // catches a regression that swaps the path data for a
        // different glyph.
        assert!(
            svg.contains(&format!("d=\"{}", &bravura::SEGNO_PATH_D[..PREFIX_LEN])),
            "{svg}"
        );
    }

    #[test]
    fn coda_emits_bravura_outline() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::Coda)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains("class=\"music-symbol-coda\""));
        assert!(
            svg.contains(&format!("d=\"{}", &bravura::CODA_PATH_D[..PREFIX_LEN])),
            "{svg}"
        );
    }

    #[test]
    fn fermata_emits_bravura_outline() {
        let mut song = IrealSong::new();
        song.sections
            .push(section('A', vec![bar_with_symbol(MusicalSymbol::Fermata)]));
        let layout = compute_layout(&song);
        let svg = render_music_symbols(&song, &layout);
        assert!(svg.contains("class=\"music-symbol-fermata\""));
        // Bravura's fermataAbove outline starts with this absolute
        // moveto; catches a regression that swaps the path data
        // for a different glyph (e.g. fermataBelow U+E4C1).
        assert!(
            svg.contains(&format!("d=\"{}", &bravura::FERMATA_PATH_D[..PREFIX_LEN])),
            "{svg}"
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
        // Two bars in the same row, one with segno and one with
        // coda. The outer `translate(glyph_cx, glyph_cy)` of each
        // glyph's transform must share the same `glyph_cy` because
        // both bars sit on row 0 — catches *asymmetric* anchoring
        // regressions between segno and coda. A uniform y-baseline
        // shift (e.g. forgetting to subtract `HALF_GLYPH`) would
        // move both glyphs identically and the equality assertion
        // alone would still pass, so the test also pins the
        // absolute value to the expected
        // `cell.y - SYMBOL_BOTTOM_GAP - HALF_GLYPH` computation.
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
        let segno_cy = parse_outer_translate_cy(&svg, "music-symbol-segno");
        let coda_cy = parse_outer_translate_cy(&svg, "music-symbol-coda");
        assert_eq!(
            segno_cy, coda_cy,
            "segno and coda in adjacent same-row bars must share cy: \
             segno_cy={segno_cy} coda_cy={coda_cy}\n{svg}"
        );
        let row_top = layout.bars[0].y;
        let expected_cy = row_top - SYMBOL_BOTTOM_GAP - HALF_GLYPH;
        assert_eq!(
            segno_cy, expected_cy,
            "anchor drifted from cell.y - SYMBOL_BOTTOM_GAP - HALF_GLYPH = {expected_cy}: got {segno_cy}\n{svg}"
        );
    }

    /// Pulls the `Y` argument of the FIRST `translate(X,Y)` clause
    /// out of the `transform=` attribute on the element whose class
    /// is exactly `class_marker`. The match is anchored on
    /// `class="<marker>"` (closing quote included) so a hypothetical
    /// future `music-symbol-segno-foo` class would not false-positive
    /// against `music-symbol-segno`. The renderer's transform
    /// composition is
    /// `translate(glyph_cx,glyph_cy) scale(...) translate(...)`, so
    /// the first clause carries the SVG anchor.
    fn parse_outer_translate_cy(svg: &str, class_marker: &str) -> i32 {
        let needle = format!("class=\"{class_marker}\"");
        let class_idx = svg.find(&needle).expect("class marker present");
        let elem_start = svg[..class_idx].rfind('<').expect("element open present");
        let elem_end = elem_start + svg[elem_start..].find('>').expect("element close present");
        let elem = &svg[elem_start..elem_end];
        let translate_idx =
            elem.find("translate(").expect("translate present") + "translate(".len();
        let translate_end =
            translate_idx + elem[translate_idx..].find(')').expect("translate closed");
        let args = &elem[translate_idx..translate_end];
        let (_, cy) = args.split_once(',').expect("translate has two args");
        cy.trim().parse().expect("cy is i32")
    }

    #[test]
    fn empty_song_emits_no_symbols() {
        let song = IrealSong::new();
        let layout = compute_layout(&song);
        assert!(render_music_symbols(&song, &layout).is_empty());
    }
}
