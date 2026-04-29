//! Page-layout constants used by the SVG skeleton.
//!
//! The constants are integer-valued so golden snapshots stay byte-
//! stable. Changing any of them is a behavioural change that
//! requires a fixture regen — the `render_basic_song_matches_golden`
//! test in `tests/golden.rs` will fail and the maintainer
//! intentionally regenerates the snapshot.

/// Page width in SVG user units (matches A4 portrait at 72 DPI).
pub const PAGE_WIDTH: i32 = 595;

/// Page height in SVG user units (matches A4 portrait at 72 DPI).
pub const PAGE_HEIGHT: i32 = 842;

/// Horizontal margin from the page edge to the header / grid.
pub const MARGIN_X: i32 = 40;

/// Vertical margin from the top edge to the header band.
pub const MARGIN_Y: i32 = 40;

/// Vertical extent reserved for the metadata header band.
pub const HEADER_BAND_HEIGHT: i32 = 80;

/// Top edge of the bar grid (header band ends here).
pub const GRID_TOP: i32 = MARGIN_Y + HEADER_BAND_HEIGHT;

/// Number of bar cells per row in the 4-bar-per-line grid.
pub const BARS_PER_ROW: usize = 4;

/// Vertical extent of one bar-grid row.
pub const BAR_ROW_HEIGHT: i32 = 50;
