//! Barline glyph rendering.
//!
//! Replaces the default cell-rectangle stroke at a bar boundary
//! with the iReal Pro convention for the bar's [`BarLine`] kind.
//! Glyph shapes:
//!
//! - [`BarLine::Single`] — handled by the cell rectangle stroke;
//!   no overlay emitted.
//! - [`BarLine::Double`] — two thin vertical lines drawn slightly
//!   inside the cell-edge stroke.
//! - [`BarLine::Final`] — one thin + one thick vertical line. The
//!   thick line is drawn over the cell stroke to make the
//!   final-barline emphasis visible.
//! - [`BarLine::OpenRepeat`] — thick line + thin line + two dots
//!   on the cell-interior side.
//! - [`BarLine::CloseRepeat`] — two dots + thin line + thick line
//!   (mirror image of `OpenRepeat`).
//!
//! All glyphs sit between the row's top and bottom y-coordinates
//! ([`BarCoord::y`] and `BarCoord::y + BarCoord::height`) so they
//! visually replace the cell-rectangle stroke at that x position.

use crate::layout::BarCoord;
use chordsketch_ireal::BarLine;

/// Pixel offset between the inner and outer line of a Double /
/// Final / repeat-barline pair. 3px keeps the two strokes
/// visually distinct without overlapping at the default 1px
/// stroke width.
const BARLINE_GAP: i32 = 3;

/// Half-width of the thick stroke used for the loud line of a
/// Final / repeat barline. The actual rendered width is
/// `2 * THICK_HALF_WIDTH`.
const THICK_HALF_WIDTH: i32 = 1;

/// Vertical-offset of a repeat dot from the cell's vertical
/// centre. 8px keeps the dots clear of the chord-text baseline
/// (which sits at `cell.y + 0.62 * cell.height`).
const REPEAT_DOT_OFFSET: i32 = 8;

/// Radius of a repeat dot.
const REPEAT_DOT_R: i32 = 2;

/// Renders the barline glyph for the bar at `cell.x` (left edge)
/// when the bar's [`BarLine`] is `kind` and the boundary is the
/// LEFT side of the cell.
///
/// Returns an empty string for [`BarLine::Single`] — the cell
/// rectangle's stroke already draws the simple line.
#[must_use]
pub(crate) fn render_left_barline(cell: &BarCoord, kind: BarLine) -> String {
    render_barline(cell, kind, BarlineSide::Left)
}

/// Same as [`render_left_barline`] but for the RIGHT side of the
/// cell (`cell.x + cell.width`).
#[must_use]
pub(crate) fn render_right_barline(cell: &BarCoord, kind: BarLine) -> String {
    render_barline(cell, kind, BarlineSide::Right)
}

#[derive(Copy, Clone)]
enum BarlineSide {
    Left,
    Right,
}

fn render_barline(cell: &BarCoord, kind: BarLine, side: BarlineSide) -> String {
    let edge_x = match side {
        BarlineSide::Left => cell.x,
        BarlineSide::Right => cell.x + cell.width,
    };
    let y_top = cell.y;
    let y_bottom = cell.y + cell.height;
    match kind {
        BarLine::Single => String::new(),
        BarLine::Double => double_line(edge_x, side, y_top, y_bottom),
        BarLine::Final => final_line(edge_x, side, y_top, y_bottom),
        BarLine::OpenRepeat => open_repeat(edge_x, side, y_top, y_bottom, cell.y, cell.height),
        BarLine::CloseRepeat => close_repeat(edge_x, side, y_top, y_bottom, cell.y, cell.height),
    }
}

fn vertical_line(x: i32, y1: i32, y2: i32, stroke_width: i32, class: &str) -> String {
    format!(
        "    <line x1=\"{x}\" y1=\"{y1}\" x2=\"{x}\" y2=\"{y2}\" \
stroke=\"black\" stroke-width=\"{stroke_width}\" class=\"{class}\"/>\n"
    )
}

fn dot(cx: i32, cy: i32, class: &str) -> String {
    format!(
        "    <circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"black\" class=\"{class}\"/>\n",
        r = REPEAT_DOT_R,
    )
}

fn double_line(edge_x: i32, side: BarlineSide, y_top: i32, y_bottom: i32) -> String {
    // The cell-rect stroke already draws one line at `edge_x`. Add
    // a second line offset toward the cell interior so the pair
    // forms a visible "||". Adjacent cells whose shared boundary
    // is `Double` will produce two overlay strokes (one from each
    // side) — both sit on the cell-interior side of `edge_x`, so
    // visually three strokes can appear at the boundary. This is
    // the documented limitation; sister-site coordination across
    // adjacent bars is deferred until #2062 / #2063 force a
    // single-pass barline emitter.
    let inner_x = match side {
        BarlineSide::Left => edge_x + BARLINE_GAP,
        BarlineSide::Right => edge_x - BARLINE_GAP,
    };
    vertical_line(inner_x, y_top, y_bottom, 1, "barline-double")
}

fn final_line(edge_x: i32, side: BarlineSide, y_top: i32, y_bottom: i32) -> String {
    // The Final glyph reads "thin → thick" toward the chart's
    // outer edge — the convention shows the loud line at the bar
    // boundary and a thinner line just inside it. We emit both:
    // the thick line ON the boundary (`edge_x`) overrides the
    // cell-rect's thin stroke there; the thin overlay sits on
    // the cell-interior side at `± BARLINE_GAP` so a final bar
    // surrounded by Single neighbours reads as a clear pair.
    let mut out = String::new();
    let inner_x = match side {
        BarlineSide::Left => edge_x + BARLINE_GAP,
        BarlineSide::Right => edge_x - BARLINE_GAP,
    };
    out.push_str(&vertical_line(
        edge_x,
        y_top,
        y_bottom,
        2 * THICK_HALF_WIDTH + 1,
        "barline-final",
    ));
    out.push_str(&vertical_line(inner_x, y_top, y_bottom, 1, "barline-final"));
    out
}

fn open_repeat(
    edge_x: i32,
    side: BarlineSide,
    y_top: i32,
    y_bottom: i32,
    cell_y: i32,
    cell_h: i32,
) -> String {
    // `OpenRepeat` opens a repeat block, so the loud edge faces
    // out (toward the previous bar / row start). Layout from
    // outside to inside:
    //   thick — gap — thin — gap — dots
    let mut out = String::new();
    let inner_x = match side {
        BarlineSide::Left => edge_x + BARLINE_GAP,
        BarlineSide::Right => edge_x - BARLINE_GAP,
    };
    let dots_x = match side {
        BarlineSide::Left => edge_x + 2 * BARLINE_GAP + REPEAT_DOT_R + 1,
        BarlineSide::Right => edge_x - 2 * BARLINE_GAP - REPEAT_DOT_R - 1,
    };
    let thick_y_top = y_top;
    let thick_y_bottom = y_bottom;
    out.push_str(&vertical_line(
        edge_x,
        thick_y_top,
        thick_y_bottom,
        2 * THICK_HALF_WIDTH + 1,
        "barline-repeat-thick",
    ));
    out.push_str(&vertical_line(
        inner_x,
        y_top,
        y_bottom,
        1,
        "barline-repeat-thin",
    ));
    let cell_centre = cell_y + cell_h / 2;
    out.push_str(&dot(
        dots_x,
        cell_centre - REPEAT_DOT_OFFSET,
        "barline-repeat-dot",
    ));
    out.push_str(&dot(
        dots_x,
        cell_centre + REPEAT_DOT_OFFSET,
        "barline-repeat-dot",
    ));
    out
}

fn close_repeat(
    edge_x: i32,
    side: BarlineSide,
    y_top: i32,
    y_bottom: i32,
    cell_y: i32,
    cell_h: i32,
) -> String {
    // Mirror of `open_repeat`: the loud edge faces the bar's exit
    // boundary, so the dots sit on the cell-interior side and the
    // thick line sits on the outside.
    let mut out = String::new();
    let inner_x = match side {
        BarlineSide::Left => edge_x + BARLINE_GAP,
        BarlineSide::Right => edge_x - BARLINE_GAP,
    };
    let dots_x = match side {
        BarlineSide::Left => edge_x + 2 * BARLINE_GAP + REPEAT_DOT_R + 1,
        BarlineSide::Right => edge_x - 2 * BARLINE_GAP - REPEAT_DOT_R - 1,
    };
    out.push_str(&dot(
        dots_x,
        cell_y + cell_h / 2 - REPEAT_DOT_OFFSET,
        "barline-repeat-dot",
    ));
    out.push_str(&dot(
        dots_x,
        cell_y + cell_h / 2 + REPEAT_DOT_OFFSET,
        "barline-repeat-dot",
    ));
    out.push_str(&vertical_line(
        inner_x,
        y_top,
        y_bottom,
        1,
        "barline-repeat-thin",
    ));
    out.push_str(&vertical_line(
        edge_x,
        y_top,
        y_bottom,
        2 * THICK_HALF_WIDTH + 1,
        "barline-repeat-thick",
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::{render_left_barline, render_right_barline};
    use crate::layout::BarCoord;
    use crate::page::BAR_ROW_HEIGHT;
    use chordsketch_ireal::BarLine;

    fn coord() -> BarCoord {
        BarCoord {
            x: 40,
            y: 120,
            width: 128,
            height: BAR_ROW_HEIGHT,
            section_index: 0,
            bar_index_in_section: 0,
        }
    }

    #[test]
    fn single_barline_emits_no_overlay() {
        assert!(render_left_barline(&coord(), BarLine::Single).is_empty());
        assert!(render_right_barline(&coord(), BarLine::Single).is_empty());
    }

    #[test]
    fn double_barline_emits_one_inner_line() {
        let svg = render_right_barline(&coord(), BarLine::Double);
        assert_eq!(svg.matches("<line").count(), 1);
        assert!(svg.contains("class=\"barline-double\""));
    }

    #[test]
    fn final_barline_emits_thick_plus_thin_line_pair() {
        // Standard music notation reads "thin → thick" toward the
        // chart's outer edge for a Final barline. The renderer
        // emits the thick line on the cell boundary and the thin
        // line on the cell-interior side.
        let svg = render_right_barline(&coord(), BarLine::Final);
        assert_eq!(svg.matches("<line").count(), 2);
        assert!(svg.contains("stroke-width=\"3\""));
        assert!(svg.contains("stroke-width=\"1\""));
        // Both lines carry the `barline-final` class so styling
        // can target the pair as one logical glyph.
        assert_eq!(svg.matches("class=\"barline-final\"").count(), 2);
    }

    #[test]
    fn open_repeat_emits_thick_thin_and_two_dots() {
        let svg = render_left_barline(&coord(), BarLine::OpenRepeat);
        assert_eq!(svg.matches("<line").count(), 2);
        assert_eq!(svg.matches("<circle").count(), 2);
        assert!(svg.contains("class=\"barline-repeat-thick\""));
        assert!(svg.contains("class=\"barline-repeat-thin\""));
        assert!(svg.contains("class=\"barline-repeat-dot\""));
    }

    #[test]
    fn close_repeat_emits_two_dots_thin_and_thick() {
        let svg = render_right_barline(&coord(), BarLine::CloseRepeat);
        assert_eq!(svg.matches("<line").count(), 2);
        assert_eq!(svg.matches("<circle").count(), 2);
        assert!(svg.contains("class=\"barline-repeat-thick\""));
    }

    #[test]
    fn open_repeat_dots_offset_to_cell_interior_on_left_side() {
        // Open-repeat dots should appear inside the cell, not on
        // the bar boundary. For the left side of a cell at x=40,
        // the dots should sit at x > 40.
        let svg = render_left_barline(&coord(), BarLine::OpenRepeat);
        // Find the first cx attribute on a `<circle>`.
        let cx_pos = svg.find("cx=\"").unwrap() + "cx=\"".len();
        let cx_end = svg[cx_pos..].find('"').unwrap();
        let cx: i32 = svg[cx_pos..cx_pos + cx_end].parse().unwrap();
        assert!(
            cx > 40,
            "left-side repeat dot must sit inside the cell, got cx={cx}"
        );
    }

    #[test]
    fn close_repeat_dots_offset_to_cell_interior_on_right_side() {
        // Close-repeat dots on the right side should sit inside
        // the cell — i.e. cx < cell.x + cell.width.
        let svg = render_right_barline(&coord(), BarLine::CloseRepeat);
        let cx_pos = svg.find("cx=\"").unwrap() + "cx=\"".len();
        let cx_end = svg[cx_pos..].find('"').unwrap();
        let cx: i32 = svg[cx_pos..cx_pos + cx_end].parse().unwrap();
        assert!(
            cx < 40 + 128,
            "right-side repeat dot must sit inside the cell, got cx={cx}"
        );
    }

    #[test]
    fn final_barline_on_left_side_emits_thick_plus_thin() {
        // The Final glyph on the LEFT side of a cell pairs the
        // thick line on the boundary (cell.x = 40) with the thin
        // line on the cell-interior side (40 + BARLINE_GAP = 43).
        // Final is usually a `bar.end`, but the AST allows it on
        // either side.
        let svg = render_left_barline(&coord(), BarLine::Final);
        assert!(svg.contains(" x1=\"40\""), "expected boundary x1=40: {svg}");
        assert!(svg.contains(" x1=\"43\""), "expected interior x1=43: {svg}");
        assert_eq!(svg.matches("stroke-width=\"3\"").count(), 1);
    }

    #[test]
    fn double_barline_on_left_side_offsets_inner_line_into_cell() {
        let svg = render_left_barline(&coord(), BarLine::Double);
        assert!(svg.contains(" x1=\"43\""), "expected x1=43: {svg}");
        assert!(svg.contains("class=\"barline-double\""));
    }

    #[test]
    fn open_repeat_on_right_side_mirrors_the_glyph() {
        // OpenRepeat as a `bar.end` sits on the right edge with
        // dots offset toward the cell interior (left of the
        // boundary). This case is unusual but the AST allows it.
        let svg = render_right_barline(&coord(), BarLine::OpenRepeat);
        let cx_pos = svg.find("cx=\"").unwrap() + "cx=\"".len();
        let cx_end = svg[cx_pos..].find('"').unwrap();
        let cx: i32 = svg[cx_pos..cx_pos + cx_end].parse().unwrap();
        assert!(
            cx < 40 + 128,
            "right-side open-repeat dot must sit inside the cell, got cx={cx}"
        );
    }

    #[test]
    fn close_repeat_on_left_side_mirrors_the_glyph() {
        let svg = render_left_barline(&coord(), BarLine::CloseRepeat);
        let cx_pos = svg.find("cx=\"").unwrap() + "cx=\"".len();
        let cx_end = svg[cx_pos..].find('"').unwrap();
        let cx: i32 = svg[cx_pos..cx_pos + cx_end].parse().unwrap();
        assert!(
            cx > 40,
            "left-side close-repeat dot must sit inside the cell, got cx={cx}"
        );
    }
}
