//! 4-bars-per-line grid layout engine.
//!
//! Translates an [`IrealSong`]'s bar list into deterministic page
//! coordinates: each bar gets one [`BarCoord`] cell, sections start
//! a new line (even when the previous row is partially filled),
//! and bar widths absorb the integer-division remainder so the
//! rightmost cell of each row aligns exactly with the right margin.
//!
//! The layout is bounded by [`crate::MAX_BARS`] — surplus bars are
//! silently truncated, mirroring the renderer's saturating fold so
//! adversarial input cannot allocate unbounded coordinates.
//!
//! # Stability
//!
//! Pre-1.0. Mid-chart time-signature changes (#2054 deferred AST
//! scope), pickup-bar half-cell layout, and multi-bar repeat
//! brackets are NOT modelled yet — every bar receives one
//! full-width cell. The follow-up issues #2057 / #2059 / #2062
//! refine the cell content; this engine owns only the cell
//! coordinates.

use chordsketch_ireal::IrealSong;

use crate::page::{
    BAR_ROW_HEIGHT, BARS_PER_ROW, GRID_TOP, MARGIN_X, MAX_BARS, MAX_SECTIONS, PAGE_WIDTH,
};

/// Page coordinates of a single bar cell.
///
/// Coordinates are integer-valued so the SVG output remains
/// byte-stable for golden-snapshot tests. `width` is variable —
/// the rightmost cell of each row absorbs the integer-division
/// leftover so `x + width == PAGE_WIDTH - MARGIN_X` for that cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BarCoord {
    /// X coordinate of the cell's left edge, in SVG user units.
    pub x: i32,
    /// Y coordinate of the cell's top edge.
    pub y: i32,
    /// Width of the cell.
    pub width: i32,
    /// Height of the cell (always [`BAR_ROW_HEIGHT`]).
    pub height: i32,
    /// 0-based index of the section this bar belongs to in
    /// [`IrealSong::sections`]. Lets the renderer correlate cells
    /// back to section labels (#2059) without a second walk.
    pub section_index: usize,
    /// 0-based bar index within the parent section.
    pub bar_index_in_section: usize,
}

/// Coordinate of an empty cell that fills out the trailing
/// positions in a section's last row.
///
/// iReal Pro renders a full 4-cell row even when the section runs
/// short — the trailing cells are drawn empty so the page looks
/// complete. The renderer iterates [`Layout::trailing_empties`]
/// after [`Layout::bars`] and emits an unfilled `<rect>` for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyCell {
    /// X coordinate of the cell's left edge.
    pub x: i32,
    /// Y coordinate of the cell's top edge.
    pub y: i32,
    /// Width of the cell.
    pub width: i32,
    /// Height of the cell.
    pub height: i32,
}

/// Result of laying out a song.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// One [`BarCoord`] per laid-out bar, in source order. Length
    /// is `min(total_bars, MAX_BARS)`.
    pub bars: Vec<BarCoord>,
    /// Empty trailing cells filling out the rest of each section's
    /// final row (so the visible grid stays a clean rectangle even
    /// when a section ends mid-row).
    pub trailing_empties: Vec<EmptyCell>,
    /// Total number of grid rows, including any partially-filled
    /// trailing row. `0` when no bars are laid out.
    pub total_rows: usize,
    /// Row index at which each section begins. Length equals
    /// `song.sections.len()`. Sections that are empty (zero bars)
    /// still receive an entry pointing at the row they would have
    /// occupied; this lets the renderer position section labels
    /// even before chord text exists.
    pub section_row_starts: Vec<usize>,
}

impl Layout {
    /// Returns the cell width breakdown for one row: `(base_width,
    /// last_cell_width)` where `last_cell_width = base_width +
    /// leftover` so the rightmost cell aligns with
    /// `PAGE_WIDTH - MARGIN_X`. Helper exposed for golden / test
    /// inspection; runtime callers should read [`BarCoord::width`]
    /// directly.
    #[must_use]
    pub fn cell_widths() -> (i32, i32) {
        let inner_width = PAGE_WIDTH - 2 * MARGIN_X;
        let base = inner_width / BARS_PER_ROW as i32;
        let leftover = inner_width - base * BARS_PER_ROW as i32;
        (base, base + leftover)
    }
}

/// Lays out the bars in `song` according to the documented rules:
///
/// - Bars wrap every [`BARS_PER_ROW`] cells within a section.
/// - Each new section starts on a new row, even if the previous
///   row is only partially filled.
/// - Bar count is clamped to [`MAX_BARS`]; surplus bars are not
///   emitted (matches the renderer's allocation cap).
#[must_use]
pub fn compute_layout(song: &IrealSong) -> Layout {
    let (base_cell_width, last_cell_width) = Layout::cell_widths();
    let mut bars = Vec::new();
    let mut trailing_empties = Vec::new();
    let mut section_row_starts = Vec::with_capacity(song.sections.len());
    let mut row: usize = 0;
    let mut col: usize = 0;
    // Highest row index that holds rendered content (bar OR
    // trailing empty). Used to derive `total_rows` cleanly even
    // when an empty trailing section bumps `row` past the last
    // visible content.
    let mut last_visible_row: Option<usize> = None;
    // Clamp the section iterator to `MAX_SECTIONS` so an
    // adversarially-large `Vec<Section>` cannot dominate
    // `section_row_starts` allocation. The cap mirrors the
    // `MAX_BARS` / `MAX_CHORDS_PER_BAR` truncation posture.
    for (section_idx, section) in song.sections.iter().take(MAX_SECTIONS).enumerate() {
        // Before opening a new section that does not start at the
        // row's left margin, emit empty trailers to fill the rest
        // of the current row so the visible grid stays a clean
        // rectangle. The trailers carry the same width treatment
        // as a real bar's last cell.
        if col > 0 {
            fill_trailing_empties(
                &mut trailing_empties,
                row,
                col,
                base_cell_width,
                last_cell_width,
            );
            last_visible_row = Some(row);
            row += 1;
            col = 0;
        }
        section_row_starts.push(row);
        if section.bars.is_empty() {
            // Empty section consumed no rows; the next non-empty
            // section will land on the same row this one would
            // have occupied. The pointer in `section_row_starts`
            // still records the intended row for label placement.
            continue;
        }
        for (bar_idx, _bar) in section.bars.iter().enumerate() {
            if bars.len() >= MAX_BARS {
                break;
            }
            if col >= BARS_PER_ROW {
                row += 1;
                col = 0;
            }
            let cell_width = if col == BARS_PER_ROW - 1 {
                last_cell_width
            } else {
                base_cell_width
            };
            let x = MARGIN_X + (col as i32) * base_cell_width;
            let y = row_y(row);
            bars.push(BarCoord {
                x,
                y,
                width: cell_width,
                height: BAR_ROW_HEIGHT,
                section_index: section_idx,
                bar_index_in_section: bar_idx,
            });
            last_visible_row = Some(row);
            col += 1;
        }
        // Continue (rather than break) so every section pushes a
        // `section_row_starts` entry even when its bars were
        // entirely truncated by `MAX_BARS`. The marker layer
        // (#2059) reads this slice in lockstep with `song.sections`
        // and would otherwise index out of bounds.
        if bars.len() >= MAX_BARS {
            continue;
        }
    }
    // Fill trailers for the very last partial row (no following
    // section to trigger the wrap above).
    if col > 0 {
        fill_trailing_empties(
            &mut trailing_empties,
            row,
            col,
            base_cell_width,
            last_cell_width,
        );
        last_visible_row = Some(row);
    }
    let total_rows = match last_visible_row {
        Some(r) => r + 1,
        None => 0,
    };
    Layout {
        bars,
        trailing_empties,
        total_rows,
        section_row_starts,
    }
}

fn fill_trailing_empties(
    out: &mut Vec<EmptyCell>,
    row: usize,
    start_col: usize,
    base_cell_width: i32,
    last_cell_width: i32,
) {
    let y = row_y(row);
    for col in start_col..BARS_PER_ROW {
        let cell_width = if col == BARS_PER_ROW - 1 {
            last_cell_width
        } else {
            base_cell_width
        };
        let x = MARGIN_X + (col as i32) * base_cell_width;
        out.push(EmptyCell {
            x,
            y,
            width: cell_width,
            height: BAR_ROW_HEIGHT,
        });
    }
}

fn row_y(row: usize) -> i32 {
    // `MAX_BARS` keeps the row count bounded, so the cast and
    // multiplication cannot overflow `i32`. Belt-and-braces with
    // `try_from` in case `MAX_BARS` ever grows past that bound.
    let row_offset = i32::try_from(row).unwrap_or(i32::MAX);
    GRID_TOP + row_offset * BAR_ROW_HEIGHT
}

#[cfg(test)]
mod tests {
    use super::{Layout, compute_layout};
    use crate::page::{BAR_ROW_HEIGHT, BARS_PER_ROW, GRID_TOP, MARGIN_X, MAX_BARS, PAGE_WIDTH};
    use chordsketch_ireal::{Bar, IrealSong, Section, SectionLabel};

    fn song_with_bars(per_section: &[usize]) -> IrealSong {
        let mut song = IrealSong::new();
        for (i, count) in per_section.iter().enumerate() {
            song.sections.push(Section {
                label: SectionLabel::Letter(['A', 'B', 'C', 'D'][i]),
                bars: (0..*count).map(|_| Bar::new()).collect(),
            });
        }
        song
    }

    #[test]
    fn empty_song_has_zero_rows_and_no_bars() {
        let layout = compute_layout(&IrealSong::new());
        assert_eq!(layout.bars.len(), 0);
        assert!(layout.trailing_empties.is_empty());
        assert_eq!(layout.total_rows, 0);
        assert!(layout.section_row_starts.is_empty());
    }

    #[test]
    fn partial_row_emits_trailing_empties_to_complete_the_grid() {
        // 3 bars in a single section → 1 row, 3 filled cells +
        // 1 trailing empty so the visible grid is a complete
        // 4-cell rectangle.
        let layout = compute_layout(&song_with_bars(&[3]));
        assert_eq!(layout.bars.len(), 3);
        assert_eq!(layout.trailing_empties.len(), 1);
        let trailer = &layout.trailing_empties[0];
        // The trailing empty sits in column 3 (the rightmost) and
        // absorbs the leftover pixels so the grid right edge
        // hits PAGE_WIDTH - MARGIN_X.
        assert_eq!(
            trailer.x + trailer.width,
            PAGE_WIDTH - MARGIN_X,
            "trailing empty must align with the right margin"
        );
    }

    #[test]
    fn section_break_fills_trailing_empties_in_previous_row() {
        // 3 bars in section A (row 0) + 2 bars in section B (row 1).
        // Row 0 needs 1 trailing empty; row 1 needs 2.
        let layout = compute_layout(&song_with_bars(&[3, 2]));
        assert_eq!(layout.bars.len(), 5);
        assert_eq!(layout.trailing_empties.len(), 3);
        // Row 0 trailer at y = GRID_TOP.
        assert_eq!(layout.trailing_empties[0].y, GRID_TOP);
        // Row 1 trailers at y = GRID_TOP + BAR_ROW_HEIGHT.
        assert_eq!(layout.trailing_empties[1].y, GRID_TOP + BAR_ROW_HEIGHT);
        assert_eq!(layout.trailing_empties[2].y, GRID_TOP + BAR_ROW_HEIGHT);
    }

    #[test]
    fn complete_rows_emit_no_trailing_empties() {
        // 4 + 4 → both rows fully filled.
        let layout = compute_layout(&song_with_bars(&[4, 4]));
        assert!(layout.trailing_empties.is_empty());
    }

    #[test]
    fn single_full_row_aligns_to_right_margin() {
        let layout = compute_layout(&song_with_bars(&[4]));
        assert_eq!(layout.total_rows, 1);
        assert_eq!(layout.bars.len(), 4);
        let last = layout.bars.last().unwrap();
        assert_eq!(
            last.x + last.width,
            PAGE_WIDTH - MARGIN_X,
            "rightmost cell must align with the right margin"
        );
    }

    #[test]
    fn nine_bars_round_up_to_three_rows() {
        let layout = compute_layout(&song_with_bars(&[9]));
        assert_eq!(layout.total_rows, 3);
        assert_eq!(layout.bars.len(), 9);
        assert_eq!(layout.bars[0].y, GRID_TOP);
        assert_eq!(layout.bars[4].y, GRID_TOP + BAR_ROW_HEIGHT);
        assert_eq!(layout.bars[8].y, GRID_TOP + 2 * BAR_ROW_HEIGHT);
    }

    #[test]
    fn section_break_starts_new_row_even_with_partial_previous_row() {
        // 3 bars in section A (row 0), then section B starts on row 1.
        let layout = compute_layout(&song_with_bars(&[3, 4]));
        assert_eq!(layout.total_rows, 2);
        assert_eq!(layout.bars.len(), 7);
        assert_eq!(layout.bars[0].y, GRID_TOP);
        assert_eq!(layout.bars[2].y, GRID_TOP, "last bar of section A on row 0");
        assert_eq!(
            layout.bars[3].y,
            GRID_TOP + BAR_ROW_HEIGHT,
            "first bar of section B starts row 1"
        );
        assert_eq!(layout.section_row_starts, vec![0, 1]);
    }

    #[test]
    fn aligned_section_break_does_not_skip_a_row() {
        // 4 bars in section A fills row 0 exactly. Section B
        // starts on row 1 — it must NOT skip to row 2.
        let layout = compute_layout(&song_with_bars(&[4, 4]));
        assert_eq!(layout.total_rows, 2);
        assert_eq!(layout.bars[3].y, GRID_TOP);
        assert_eq!(layout.bars[4].y, GRID_TOP + BAR_ROW_HEIGHT);
        assert_eq!(layout.section_row_starts, vec![0, 1]);
    }

    #[test]
    fn empty_section_is_recorded_but_consumes_no_row() {
        // Sections: 4 bars / 0 bars / 4 bars. The middle section
        // is empty, so the third section's bars sit immediately
        // after the first.
        let layout = compute_layout(&song_with_bars(&[4, 0, 4]));
        assert_eq!(layout.total_rows, 2);
        assert_eq!(layout.bars.len(), 8);
        assert_eq!(layout.section_row_starts, vec![0, 1, 1]);
        assert_eq!(layout.bars[4].y, GRID_TOP + BAR_ROW_HEIGHT);
    }

    #[test]
    fn cell_widths_helper_matches_actual_layout() {
        let (base, last) = Layout::cell_widths();
        assert!(last >= base, "last cell absorbs the leftover");
        let layout = compute_layout(&song_with_bars(&[4]));
        assert_eq!(layout.bars[0].width, base);
        assert_eq!(layout.bars[3].width, last);
    }

    #[test]
    fn bar_count_clamps_to_max_bars() {
        let layout = compute_layout(&song_with_bars(&[MAX_BARS + 100]));
        assert_eq!(
            layout.bars.len(),
            MAX_BARS,
            "surplus bars must be truncated"
        );
        let expected_rows = MAX_BARS.div_ceil(BARS_PER_ROW);
        assert_eq!(layout.total_rows, expected_rows);
    }

    #[test]
    fn truncated_sections_still_record_section_row_starts() {
        // Direct regression for the `break → continue` invariant
        // in `compute_layout`: when section 0 fills the entire
        // `MAX_BARS` budget, every subsequent section must still
        // push a `section_row_starts` entry so marker layers
        // (#2059) can index in lockstep with `song.sections`.
        let mut song = IrealSong::new();
        song.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: (0..MAX_BARS).map(|_| Bar::new()).collect(),
        });
        song.sections.push(Section {
            label: SectionLabel::Letter('B'),
            bars: vec![Bar::new(), Bar::new()],
        });
        let layout = compute_layout(&song);
        assert_eq!(
            layout.section_row_starts.len(),
            2,
            "section_row_starts must align 1:1 with song.sections"
        );
        assert_eq!(layout.bars.len(), MAX_BARS, "MAX_BARS clamp preserved");
    }

    #[test]
    fn excess_section_count_clamps_to_max_sections() {
        use crate::page::MAX_SECTIONS;
        let mut song = IrealSong::new();
        for _ in 0..(MAX_SECTIONS + 100) {
            song.sections.push(Section {
                label: SectionLabel::Letter('A'),
                bars: Vec::new(),
            });
        }
        let layout = compute_layout(&song);
        assert!(
            layout.section_row_starts.len() <= MAX_SECTIONS,
            "compute_layout must clamp to MAX_SECTIONS, got {}",
            layout.section_row_starts.len()
        );
    }

    #[test]
    fn trailing_empty_section_row_start_can_exceed_total_rows() {
        // When a song ends with empty section(s) following a non-
        // empty one, `section_row_starts` records a row index for
        // the empty section that is past `total_rows` — i.e. the
        // row would have been used had the section had bars. The
        // renderer's section-label path (#2059) reads
        // `section_row_starts` and must tolerate this case rather
        // than indexing an out-of-bounds row.
        let layout = compute_layout(&song_with_bars(&[4, 0]));
        assert_eq!(layout.total_rows, 1);
        assert_eq!(layout.section_row_starts, vec![0, 1]);
        assert!(
            layout.section_row_starts[1] >= layout.total_rows,
            "trailing empty section's row pointer should sit past total_rows"
        );
    }

    #[test]
    fn each_bar_carries_its_section_index_and_position() {
        let layout = compute_layout(&song_with_bars(&[2, 3]));
        assert_eq!(layout.bars[0].section_index, 0);
        assert_eq!(layout.bars[0].bar_index_in_section, 0);
        assert_eq!(layout.bars[1].section_index, 0);
        assert_eq!(layout.bars[1].bar_index_in_section, 1);
        assert_eq!(layout.bars[2].section_index, 1);
        assert_eq!(layout.bars[2].bar_index_in_section, 0);
        assert_eq!(layout.bars[4].section_index, 1);
        assert_eq!(layout.bars[4].bar_index_in_section, 2);
    }
}
