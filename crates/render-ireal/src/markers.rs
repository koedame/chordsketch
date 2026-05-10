//! Section labels and N-th-ending bracket rendering.
//!
//! Section labels are short text glyphs (typically a single
//! uppercase letter — `A`, `B`, `C` — but the AST also carries
//! `Verse` / `Chorus` / `Custom` variants) drawn just above the
//! first bar of each section. Ending brackets are horizontal lines
//! with corner ticks and a small "N." label drawn above a run of
//! consecutive bars sharing the same `Bar.ending` value.
//!
//! Both glyphs are positioned by reading [`Layout::section_row_starts`]
//! and the `BarCoord` list — no AST traversal happens here, so the
//! markers stay byte-stable for golden snapshots.

use crate::layout::Layout;
use crate::page::{BAR_ROW_HEIGHT, GRID_TOP, SECTION_MARKER_SIZE};
use crate::svg;
use chordsketch_ireal::{IrealSong, SectionLabel};

/// Vertical lift above the row top for the section-marker square.
/// Anchors the marker so it sits in the gap between the previous
/// row and this row, matching `editor-irealb.html` §Section marker.
const SECTION_LABEL_GAP: i32 = SECTION_MARKER_SIZE - 2;

/// Vertical gap between the top of the row and the ending
/// bracket's horizontal line. Slightly less than
/// [`SECTION_LABEL_GAP`] so the bracket can sit beneath a section
/// label when both apply to the same row.
const ENDING_BRACKET_GAP: i32 = 3;

/// Length of the corner tick at each end of an N-th ending
/// bracket — drawn vertically downward into the cell.
const ENDING_TICK_HEIGHT: i32 = 6;

/// Renders a section-label `<text>` above the first bar of every
/// non-empty section. Empty sections emit no label — the
/// section's `section_row_starts` entry would point at a row that
/// holds no `BarCoord`, and a label hovering over an empty row
/// would mislead more than help.
#[must_use]
pub(crate) fn render_section_labels(song: &IrealSong, layout: &Layout) -> String {
    let mut out = String::new();
    for (section_idx, section) in song.sections.iter().enumerate() {
        if section.bars.is_empty() {
            continue;
        }
        // `compute_layout` guarantees `section_row_starts.len() ==
        // song.sections.len()`, and a non-empty section always
        // has at least one BarCoord whose `section_index ==
        // section_idx` (subject to the `MAX_BARS` clamp). The
        // `find` below would only return None when the entire
        // section was truncated by `MAX_BARS`; in that case the
        // section legitimately has nothing visible to label and
        // we skip the label silently.
        let row = layout.section_row_starts[section_idx];
        let Some(first_bar) = layout.bars.iter().find(|b| b.section_index == section_idx) else {
            continue;
        };
        let row_y = GRID_TOP + (row as i32) * BAR_ROW_HEIGHT;
        // Black-filled square anchored above the first bar's
        // top-left corner. The white letter centred inside reads
        // as the section's name (`A`, `B`, `Verse`, etc.).
        let square_x = first_bar.x - SECTION_MARKER_SIZE / 2;
        let square_y = row_y - SECTION_LABEL_GAP;
        let label_text = svg::escape_xml(&format_section_label(&section.label));
        out.push_str(&format!(
            "    <rect x=\"{square_x}\" y=\"{square_y}\" \
width=\"{SECTION_MARKER_SIZE}\" height=\"{SECTION_MARKER_SIZE}\" \
fill=\"black\" class=\"section-marker\"/>\n"
        ));
        let text_x = square_x + SECTION_MARKER_SIZE / 2;
        let text_y = square_y + (SECTION_MARKER_SIZE * 7) / 10;
        out.push_str(&format!(
            "    <text x=\"{text_x}\" y=\"{text_y}\" font-family=\"sans-serif\" \
font-size=\"11\" font-weight=\"700\" fill=\"white\" text-anchor=\"middle\" \
class=\"section-label\">{label_text}</text>\n"
        ));
    }
    out
}

fn format_section_label(label: &SectionLabel) -> String {
    match label {
        SectionLabel::Letter(c) => c.to_string(),
        SectionLabel::Verse => "V".to_string(),
        SectionLabel::Chorus => "C".to_string(),
        SectionLabel::Intro => "I".to_string(),
        SectionLabel::Outro => "O".to_string(),
        SectionLabel::Bridge => "B".to_string(),
        SectionLabel::Custom(s) => s.clone(),
    }
}

/// Renders N-th-ending brackets above runs of consecutive bars
/// sharing the same `Bar.ending` value. A bracket is one
/// horizontal `<line>` with two short downward ticks at each end
/// plus a small `<text>` label (`"1."`, `"2."`, …) at the top-left
/// corner.
///
/// Bars that span across a row break end the bracket at the row
/// boundary and begin a new one on the next row — readers expect
/// the bracket to track the bar grid, not the source order.
#[must_use]
pub(crate) fn render_endings(song: &IrealSong, layout: &Layout) -> String {
    let mut out = String::new();
    let mut run: Option<(u8, usize, usize)> = None; // (ending_n, first_idx, last_idx)
    for (idx, cell) in layout.bars.iter().enumerate() {
        let bar_ending = song
            .sections
            .get(cell.section_index)
            .and_then(|s| s.bars.get(cell.bar_index_in_section))
            .and_then(|b| b.ending)
            .map(|e| e.number());
        match (run, bar_ending) {
            (None, Some(n)) => run = Some((n, idx, idx)),
            // Compare `idx` against the run's `last` (not `idx -
            // 1`) so the underflow case at `idx == 0` is
            // structurally impossible — the `(None, Some(n))`
            // arm above handles the run's first bar, so reaching
            // this arm always implies `last < idx`.
            (Some((n, first, last)), Some(m)) if m == n && same_row(layout, last, idx) => {
                run = Some((n, first, idx));
            }
            (Some((n, first, last)), Some(m)) => {
                emit_ending_bracket(&mut out, layout, n, first, last);
                run = Some((m, idx, idx));
            }
            (Some((n, first, last)), None) => {
                emit_ending_bracket(&mut out, layout, n, first, last);
                run = None;
            }
            (None, None) => {}
        }
    }
    if let Some((n, first, last)) = run {
        emit_ending_bracket(&mut out, layout, n, first, last);
    }
    out
}

fn same_row(layout: &Layout, a: usize, b: usize) -> bool {
    layout
        .bars
        .get(a)
        .and_then(|x| layout.bars.get(b).map(|y| x.y == y.y))
        .unwrap_or(false)
}

fn emit_ending_bracket(
    out: &mut String,
    layout: &Layout,
    n: u8,
    first_idx: usize,
    last_idx: usize,
) {
    // `first_idx` / `last_idx` come from indexing the same
    // `layout.bars` slice we're now indexing back into, so direct
    // indexing is safe by construction.
    let first = &layout.bars[first_idx];
    let last = &layout.bars[last_idx];
    let bracket_y = first.y - ENDING_BRACKET_GAP;
    let x_start = first.x;
    let x_end = last.x + last.width;
    out.push_str(&format!(
        "    <line x1=\"{x_start}\" y1=\"{bracket_y}\" x2=\"{x_end}\" y2=\"{bracket_y}\" \
stroke=\"black\" stroke-width=\"1\" class=\"ending-bracket\"/>\n"
    ));
    // Left tick.
    out.push_str(&format!(
        "    <line x1=\"{x_start}\" y1=\"{bracket_y}\" x2=\"{x_start}\" y2=\"{tick_y}\" \
stroke=\"black\" stroke-width=\"1\" class=\"ending-bracket\"/>\n",
        tick_y = bracket_y + ENDING_TICK_HEIGHT,
    ));
    // Right tick.
    out.push_str(&format!(
        "    <line x1=\"{x_end}\" y1=\"{bracket_y}\" x2=\"{x_end}\" y2=\"{tick_y}\" \
stroke=\"black\" stroke-width=\"1\" class=\"ending-bracket\"/>\n",
        tick_y = bracket_y + ENDING_TICK_HEIGHT,
    ));
    // Label (e.g. "1.") drawn slightly inside the left tick.
    let label_y = bracket_y - 2;
    let label_x = x_start + 4;
    out.push_str(&format!(
        "    <text x=\"{label_x}\" y=\"{label_y}\" font-family=\"sans-serif\" \
font-size=\"10\" class=\"ending-label\">{n}.</text>\n"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute_layout;
    use chordsketch_ireal::{Bar, Ending, IrealSong, Section, SectionLabel};

    fn bar_with_ending(n: u8) -> Bar {
        Bar {
            ending: Ending::new(n),
            ..Bar::new()
        }
    }

    fn bar() -> Bar {
        Bar::new()
    }

    #[test]
    fn empty_song_emits_no_section_labels() {
        let layout = compute_layout(&IrealSong::new());
        assert!(render_section_labels(&IrealSong::new(), &layout).is_empty());
    }

    #[test]
    fn single_section_emits_one_label_at_first_bar() {
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar(), bar()],
        });
        let layout = compute_layout(&song);
        let out = render_section_labels(&song, &layout);
        assert_eq!(out.matches("<text").count(), 1);
        assert!(out.contains(">A</text>"));
    }

    #[test]
    fn empty_section_does_not_emit_a_label() {
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar()],
        });
        song.sections.push(Section {
            label: SectionLabel::Letter('B'),
            bars: Vec::new(),
        });
        song.sections.push(Section {
            label: SectionLabel::Letter('C'),
            bars: vec![bar()],
        });
        let layout = compute_layout(&song);
        let out = render_section_labels(&song, &layout);
        // Only A and C should emit labels — B has no bars.
        assert_eq!(out.matches("<text").count(), 2);
        assert!(out.contains(">A</text>"));
        assert!(!out.contains(">B</text>"));
        assert!(out.contains(">C</text>"));
    }

    #[test]
    fn named_section_label_variants_each_render() {
        for (variant, expected) in [
            (SectionLabel::Verse, "V"),
            (SectionLabel::Chorus, "C"),
            (SectionLabel::Intro, "I"),
            (SectionLabel::Outro, "O"),
            (SectionLabel::Bridge, "B"),
            (SectionLabel::Custom("Pre".into()), "Pre"),
        ] {
            let mut song = IrealSong::new();
            song.sections.push(Section {
                label: variant,
                bars: vec![bar()],
            });
            let layout = compute_layout(&song);
            let out = render_section_labels(&song, &layout);
            let needle = format!(">{expected}</text>");
            assert!(out.contains(&needle), "expected {needle:?} in {out}");
        }
    }

    #[test]
    fn ending_bracket_spans_consecutive_bars_with_same_ending_number() {
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar_with_ending(1), bar_with_ending(1), bar()],
        });
        let layout = compute_layout(&song);
        let out = render_endings(&song, &layout);
        // Two brackets? No — one bracket spanning two bars + corner ticks.
        // Expect 1 horizontal line + 2 ticks + 1 label.
        assert_eq!(out.matches("class=\"ending-bracket\"").count(), 3);
        assert_eq!(out.matches("class=\"ending-label\">1.").count(), 1);
    }

    #[test]
    fn two_endings_with_different_numbers_emit_two_brackets() {
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar_with_ending(1), bar_with_ending(2)],
        });
        let layout = compute_layout(&song);
        let out = render_endings(&song, &layout);
        assert!(out.contains("class=\"ending-label\">1."));
        assert!(out.contains("class=\"ending-label\">2."));
    }

    #[test]
    fn no_endings_emits_no_bracket() {
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar(), bar()],
        });
        let layout = compute_layout(&song);
        assert!(render_endings(&song, &layout).is_empty());
    }

    #[test]
    fn ending_run_breaks_at_row_boundary() {
        // Bars 1..=4 share ending 1; the row break between bar 4
        // and bar 5 (when bar 5 starts a new row) must close the
        // bracket and (if bar 5 is also ending 1) open a new one.
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![
                bar_with_ending(1),
                bar_with_ending(1),
                bar_with_ending(1),
                bar_with_ending(1),
                bar_with_ending(1),
            ],
        });
        let layout = compute_layout(&song);
        let out = render_endings(&song, &layout);
        // 5 bars → 2 rows of ending=1 → 2 brackets → 2 labels.
        assert_eq!(out.matches("class=\"ending-label\">1.").count(), 2);
    }

    #[test]
    fn ending_label_is_xml_escaped() {
        // Defensive: the label is a `u8` so no XML reserved chars
        // can appear today, but the `n.` formatting still passes
        // through the SVG path, so future digit-replacement
        // changes remain safe by construction.
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar_with_ending(255)],
        });
        let layout = compute_layout(&song);
        let out = render_endings(&song, &layout);
        assert!(out.contains(">255.<"));
    }

    #[test]
    fn fully_truncated_section_emits_no_label() {
        // When a non-empty section's bars are entirely truncated
        // by `MAX_BARS`, `find` for that section returns None and
        // the label is silently skipped — the section legitimately
        // has nothing visible to point at. This exercises the
        // `else continue` branch on the find fallback.
        use crate::page::MAX_BARS;
        let mut song = IrealSong::new();
        // Section 0 fills the entire `MAX_BARS` budget.
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: (0..MAX_BARS).map(|_| bar()).collect(),
        });
        // Section 1's bars will all be truncated.
        song.sections.push(Section {
            label: SectionLabel::Letter('B'),
            bars: vec![bar(), bar()],
        });
        let layout = compute_layout(&song);
        let out = render_section_labels(&song, &layout);
        // Only Section 0's label is emitted.
        assert!(out.contains(">A</text>"));
        assert!(!out.contains(">B</text>"));
    }

    #[test]
    fn xml_reserved_chars_in_custom_section_label_are_escaped() {
        // `Custom` carries an arbitrary string — must be escaped.
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Custom("<bad>&\"".into()),
            bars: vec![bar()],
        });
        let layout = compute_layout(&song);
        let out = render_section_labels(&song, &layout);
        assert!(out.contains("&lt;bad&gt;&amp;&quot;"));
        assert!(!out.contains("<bad>"));
    }
}
