//! Staff-text rendering (#2426).
//!
//! Each [`StaffText`] attached to a [`chordsketch_ireal::Bar`] is
//! painted as an italic serif `<text>` run anchored under the bar's
//! chord. The vertical placement follows the iReal Pro spec's
//! `*XY` raise semantics (00 below the system → 74 above the
//! system, linear interpolation between two anchor rows); plain
//! text without a position prefix sits below the bar's baseline
//! at the same `BELOW_OFFSET` the playground React chart uses for
//! its `.text-mark` span (sister-site parity per
//! `.claude/rules/renderer-parity.md`).
//!
//! `<Nx>` repeat-count entries render as italic `"Nx"` so the
//! directive intent stays visible — they have no `vertical_position`
//! per spec and always sit at the default baseline.

use crate::layout::Layout;
use crate::svg;
use chordsketch_ireal::{IrealSong, StaffText};

/// SVG y-distance from the bar's bottom edge to the default staff-
/// text baseline. Matches the playground React chart's
/// `.text-mark` margin so the SVG and React surfaces stay visually
/// aligned.
const BELOW_OFFSET: i32 = 12;

/// SVG y-distance from the bar's top edge to the `*74` (above-the-
/// system) anchor row. Mirrors `music_symbols.rs`'s
/// `SYMBOL_BOTTOM_GAP` so a `<*74Solo>` caption lands in the same
/// horizontal band as a `<Segno>` glyph.
const ABOVE_ANCHOR_GAP: i32 = 10;

/// Font size for staff-text captions. Smaller than the chord-name
/// base font so the caption does not visually compete with the
/// chord text — same magnitude as
/// `music_symbols::TEXT_DIRECTIVE_FONT_SIZE`.
const STAFF_TEXT_FONT_SIZE: i32 = 11;

/// Horizontal inset from the cell's left edge. Keeps the caption
/// clear of any barline overlay at the cell boundary.
const TEXT_LEFT_INSET: i32 = 4;

/// Paints every [`StaffText`] entry attached to every bar in
/// `song`. Bars with no staff text produce no output.
///
/// Multiple entries on one bar stack vertically with a fixed line-
/// height between adjacent lines so the source-order ordering of
/// `Bar::staff_texts` is visible in the rendered chart.
#[must_use]
pub(crate) fn render_staff_texts(song: &IrealSong, layout: &Layout) -> String {
    let mut out = String::new();
    for cell in &layout.bars {
        // Stale `BarCoord` for a bar that no longer exists in the AST:
        // share the defensive-skip pattern with `music_symbols.rs` so a
        // hand-rolled `Layout` cannot panic the renderer.
        let Some(bar) = song
            .sections
            .get(cell.section_index)
            .and_then(|s| s.bars.get(cell.bar_index_in_section))
        else {
            continue;
        };
        if bar.staff_texts.is_empty() {
            continue;
        }
        // Two anchor families: explicitly-positioned entries
        // (`vertical_position = Some(_)`) pin themselves at a Y
        // derived from the position and do NOT advance the running
        // stack; default-anchored entries (plain `Text` without a
        // position, plus every `RepeatCount`) stack downward at the
        // below-bar baseline so source order remains visible in
        // the rendered chart.
        let mut stack_y: i32 = below_baseline_y(cell.y, cell.height);
        for st in &bar.staff_texts {
            let (baseline_y, advances_stack) = match st {
                StaffText::Text {
                    vertical_position: Some(pos),
                    ..
                } => (positioned_baseline_y(cell.y, cell.height, *pos), false),
                _ => (stack_y, true),
            };
            let body = match st {
                StaffText::Text { text, .. } => text.clone(),
                StaffText::RepeatCount(n) => format!("{n}x", n = n.get()),
            };
            // `<` / `>` cannot survive into the body via the URL
            // round trip (the serializer strips them), but
            // defensively XML-escape so a hand-constructed AST
            // carrying raw `<`/`>`/`&`/`"`/`'` cannot corrupt the
            // SVG output stream.
            let escaped = svg::escape_xml(&body);
            out.push_str(&format!(
                "    <text x=\"{x}\" y=\"{baseline_y}\" font-family=\"serif\" \
font-size=\"{STAFF_TEXT_FONT_SIZE}\" \
font-style=\"italic\" class=\"staff-text\">{escaped}</text>\n",
                x = cell.x + TEXT_LEFT_INSET,
            ));
            if advances_stack {
                stack_y = baseline_y + STAFF_TEXT_FONT_SIZE + 1;
            }
        }
    }
    out
}

/// SVG y of the baseline that sits below the bar's bottom edge
/// at [`BELOW_OFFSET`]. The font-size offset places the baseline
/// `BELOW_OFFSET` units below the cell's bottom edge so the glyph
/// ink itself does not overlap the cell border.
fn below_baseline_y(cell_y: i32, cell_height: i32) -> i32 {
    cell_y + cell_height + BELOW_OFFSET + STAFF_TEXT_FONT_SIZE
}

/// SVG y of the baseline that corresponds to vertical position
/// `pos` in `0..=74`. Linear interpolation:
///
/// - `pos = 0`   → below the bar's bottom edge (matches the default
///   anchor in [`below_baseline_y`]).
/// - `pos = 74`  → above the bar's top edge at the same offset
///   `music_symbols.rs` uses for its glyph band.
///
/// Out-of-range values (> 74) are clamped at construction time by
/// [`StaffText::raised`] / the JSON deserializer, but the parser-
/// produced AST always satisfies the contract; the `min` here is
/// defense in depth against a hand-rolled AST.
fn positioned_baseline_y(cell_y: i32, cell_height: i32, pos: u8) -> i32 {
    let clamped = pos.min(StaffText::MAX_VERTICAL_POSITION);
    let below = below_baseline_y(cell_y, cell_height);
    let above = cell_y - ABOVE_ANCHOR_GAP;
    let max = i32::from(StaffText::MAX_VERTICAL_POSITION);
    // y(0)  = below
    // y(74) = above
    // y(p)  = below + (above - below) * (p / 74)
    below + (above - below) * i32::from(clamped) / max
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute_layout;
    use chordsketch_ireal::{Bar, IrealSong, Section, SectionLabel};

    fn bar_with_staff_texts(entries: Vec<StaffText>) -> Bar {
        Bar {
            staff_texts: entries,
            ..Bar::new()
        }
    }

    fn section(label: char, bars: Vec<Bar>) -> Section {
        Section {
            label: SectionLabel::Letter(label),
            bars,
        }
    }

    #[test]
    fn empty_staff_texts_emit_no_output() {
        let mut song = IrealSong::new();
        song.sections.push(section('A', vec![Bar::new()]));
        let layout = compute_layout(&song);
        assert!(render_staff_texts(&song, &layout).is_empty());
    }

    #[test]
    fn plain_text_renders_class_staff_text() {
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![StaffText::plain("solo break")])],
        ));
        let layout = compute_layout(&song);
        let svg = render_staff_texts(&song, &layout);
        assert!(
            svg.contains("class=\"staff-text\""),
            "expected staff-text class, got {svg:?}"
        );
        assert!(
            svg.contains("solo break"),
            "expected caption body, got {svg:?}"
        );
    }

    #[test]
    fn repeat_count_renders_nx() {
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![
                StaffText::repeat_count(8).expect("8 is non-zero"),
            ])],
        ));
        let layout = compute_layout(&song);
        let svg = render_staff_texts(&song, &layout);
        assert!(
            svg.contains(">8x<"),
            "expected `8x` rendered between `<text>` tags, got {svg:?}"
        );
    }

    #[test]
    fn multi_byte_utf8_body_round_trips_to_svg() {
        // `さくら` (3 chars × 3 bytes each = 9 bytes) must survive
        // intact into the SVG output. Regression guard for any
        // future renderer change that byte-slices the body.
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![StaffText::plain("さくら")])],
        ));
        let layout = compute_layout(&song);
        let svg = render_staff_texts(&song, &layout);
        assert!(
            svg.contains(">さくら</text>"),
            "expected `さくら` in SVG output, got {svg:?}"
        );
    }

    #[test]
    fn xml_special_chars_in_body_are_escaped() {
        // The URL serializer strips `<` / `>` from staff-text
        // bodies, so the parser-built AST never carries them. A
        // hand-constructed AST (per the public-field contract on
        // `Bar::staff_texts`) MAY carry them, and the renderer
        // MUST escape so the SVG output stays well-formed XML.
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![StaffText::plain("a & b < c")])],
        ));
        let layout = compute_layout(&song);
        let svg = render_staff_texts(&song, &layout);
        assert!(
            svg.contains(">a &amp; b &lt; c</text>"),
            "expected XML-escaped body, got {svg:?}"
        );
    }

    #[test]
    fn vertical_position_zero_paints_below_default_baseline() {
        // pos=0 must paint at the same Y as the default
        // (None / RepeatCount) anchor — both are "below the system".
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![
                StaffText::raised("at zero", 0),
                StaffText::plain("default"),
            ])],
        ));
        let layout = compute_layout(&song);
        let cell = &layout.bars[0];
        let svg = render_staff_texts(&song, &layout);
        let default_y = below_baseline_y(cell.y, cell.height);
        assert!(
            svg.contains(&format!("y=\"{default_y}\"")),
            "default-anchored entry must paint at the below-baseline Y, got {svg:?}"
        );
    }

    #[test]
    fn vertical_position_74_paints_above_the_bar() {
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![StaffText::raised("solo", 74)])],
        ));
        let layout = compute_layout(&song);
        let cell = &layout.bars[0];
        let svg = render_staff_texts(&song, &layout);
        let above_y = cell.y - ABOVE_ANCHOR_GAP;
        assert!(
            svg.contains(&format!("y=\"{above_y}\"")),
            "`*74` caption must paint above the bar at the music-symbol band, got {svg:?}"
        );
    }

    #[test]
    fn stacked_default_entries_advance_the_y_stack() {
        // Two default-positioned captions must paint at distinct y
        // coordinates so the source order remains visible.
        let mut song = IrealSong::new();
        song.sections.push(section(
            'A',
            vec![bar_with_staff_texts(vec![
                StaffText::plain("first"),
                StaffText::plain("second"),
            ])],
        ));
        let layout = compute_layout(&song);
        let svg = render_staff_texts(&song, &layout);
        let cell = &layout.bars[0];
        let first_y = below_baseline_y(cell.y, cell.height);
        let second_y = first_y + STAFF_TEXT_FONT_SIZE + 1;
        assert!(svg.contains(&format!("y=\"{first_y}\"")));
        assert!(svg.contains(&format!("y=\"{second_y}\"")));
    }
}
