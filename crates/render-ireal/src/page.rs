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

/// Maximum bar count the renderer accepts before truncating.
///
/// Mirrors the bounds-check pattern used by `chordsketch-chordpro`
/// chord-diagram rendering and the `MAX_COLUMNS = 32` clamp in the
/// HTML renderer (per `.claude/rules/renderer-parity.md`'s
/// "Validation Parity" clause). Without this cap, a malicious or
/// malformed AST with millions of bars would (a) waste unbounded
/// memory in `format!` and (b) overflow the `(row as i32) *
/// BAR_ROW_HEIGHT` y-coordinate computation in the grid emitter.
///
/// `4096` bars is well past any real chart length (a typical jazz
/// standard is 16–64 bars). When this cap is hit, surplus bars are
/// silently truncated; documenting the limit in the public-API
/// rustdoc lets future callers (#2059) detect when they need to
/// surface a warning instead.
pub const MAX_BARS: usize = 4096;

/// Base font size for chord-name typography (root, slash, bass).
pub const CHORD_FONT_SIZE_BASE: i32 = 14;

/// Smaller font size used for raised-baseline extension spans
/// (e.g. `maj7`, `m7♭5`, `sus4`). Mirrors iReal Pro's superscript
/// proportion — ≈ 70% of the base size.
pub const CHORD_FONT_SIZE_SUPERSCRIPT: i32 = 10;

/// Baseline shift for the extension span — negative is "up" in
/// SVG coordinates. Approximately a third of the base font size,
/// matching iReal Pro's visual offset for superscript chord
/// extensions.
pub const CHORD_SUPERSCRIPT_DY: i32 = -4;

/// Maximum number of sections the renderer lays out before
/// truncating.
///
/// `IrealSong.sections` is `pub Vec<Section>` and unvalidated; an
/// in-process AST consumer (FFI / NAPI / library) can therefore
/// hand the renderer a `Vec` of arbitrary length. Without this
/// cap, `compute_layout`'s `section_row_starts` bookkeeping would
/// allocate proportionally to `song.sections.len()`. `1024` is
/// far above any practical iReal Pro chart (a typical jazz
/// standard has 1–8 sections); when the cap is hit, surplus
/// sections are silently truncated, mirroring the `MAX_BARS` /
/// `MAX_CHORDS_PER_BAR` posture.
pub const MAX_SECTIONS: usize = 1024;

/// Maximum number of chords the renderer lays out inside a single
/// bar before truncating.
///
/// `BarChord` is `pub` and the AST allows direct field assignment,
/// so a malformed in-process `Vec<BarChord>` could in principle
/// hold `usize::MAX/2` entries. The flat-layout chord-name
/// formatter joins them with a space into a single `<text>`
/// element; without this cap, an adversarial AST could OOM the
/// renderer on one bar. `64` is far above the iReal Pro grid's
/// practical limit (an 8/8 bar with sub-beat changes tops out at
/// ~16 chord placements). When the cap is hit, surplus chords are
/// silently truncated.
pub const MAX_CHORDS_PER_BAR: usize = 64;

// Compile-time invariants. Asserting `MAX_BARS` and `BARS_PER_ROW`
// at build time keeps the y-coordinate arithmetic in `lib.rs`
// safe-by-construction: even with `MAX_BARS = 4096`, the highest
// `row_y` is well within `i32` range.
const _: () = assert!(BARS_PER_ROW > 0);
const _: () = assert!(MAX_BARS > 0);
const _: () = assert!(MAX_CHORDS_PER_BAR > 0);
const _: () = assert!(MAX_SECTIONS > 0);
const _: () = {
    let max_rows = MAX_BARS.div_ceil(BARS_PER_ROW);
    // Conservatively check that `row_y = GRID_TOP + row * BAR_ROW_HEIGHT`
    // stays within `i32` for every row up to the cap.
    assert!(max_rows < (i32::MAX as usize) / (BAR_ROW_HEIGHT as usize));
};
