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
///
/// Sized to fit the engraved chord typography
/// (`CHORD_FONT_SIZE_BASE = 24` root + 14 superscript) plus the
/// 32-px inter-line gap pattern from
/// `design-system/ui_kits/web/editor-irealb.html`.
pub const BAR_ROW_HEIGHT: i32 = 64;

/// Pixel side of the section-marker square (black filled box with
/// the section letter in white). Anchored at the top-left of the
/// section's first bar — see
/// `design-system/ui_kits/web/editor-irealb.html` §"Section marker".
pub const SECTION_MARKER_SIZE: i32 = 18;

/// Inter-line vertical gap between rows. Mirrors the 32-px gap in
/// `editor-irealb.html` so section markers can sit in the gap
/// without colliding with the previous line's bars.
pub const ROW_GAP: i32 = 16;

/// Reserved indent at the left of every line. Holds the time
/// signature (line 1) and section-marker squares (`[A]`, `[B]`, …).
pub const LINE_LEFT_INDENT: i32 = 28;

/// Vertical padding (in SVG user units) added above a row per
/// level of `Bar::system_break_space` carried by the row's first
/// bar. Matches the iReal Pro spec's `Y` / `YY` / `YYY` tokens
/// (small / medium / large between-system gap); each `Y` adds
/// this many user-units of extra space above the row, multiplied
/// by the count (so `YYY` → 3 × this value).
pub const VERTICAL_BREAK_PER_LEVEL: i32 = 4;

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
///
/// Tuned to the engraved chord look in
/// `design-system/ui_kits/web/editor-irealb.html` — chord roots
/// dominate the bar visually so each chord reads at a glance.
pub const CHORD_FONT_SIZE_BASE: i32 = 32;

/// Narrower base font for chords carrying the iReal Pro `s`
/// marker ([`chordsketch_ireal::ChordSize::Small`]).
///
/// Sized at ~70 % of [`CHORD_FONT_SIZE_BASE`] (22 / 32 ≈ 0.6875),
/// matching the iReal Pro spec's "narrower" intent for the `s`
/// marker — dense bars with multiple chord changes stay legible
/// without overflowing the cell. The renderer scales the
/// accidental / extension spans and their baseline shifts
/// proportionally from this base so the engraved chord keeps its
/// visual hierarchy at the smaller size.
pub const CHORD_FONT_SIZE_BASE_SMALL: i32 = 22;

/// Smaller font size used for the quality / extension span
/// (`Δ7`, `−7`, `ø7`, `sus4`). Mirrors iReal Pro's quality-glyph
/// proportion — ≈ 50 % of the base size.
pub const CHORD_FONT_SIZE_SUPERSCRIPT: i32 = 16;

/// Font size for the accidental glyph (♯ / ♭) raised next to the
/// root letter. Slightly larger than the quality so the sharp /
/// flat reads at superscript size while still being legible.
pub const CHORD_FONT_SIZE_ACCIDENTAL: i32 = 20;

/// Baseline shift (positive = down in SVG coords) for the quality
/// span — small subscript so the quality hangs just below the
/// root's baseline. Matches `editor-irealb.html`'s
/// `.chord-qual { vertical-align: -0.15em }` (≈ +0.15 em from
/// baseline in SVG-down convention).
pub const CHORD_QUALITY_DY: i32 = 5;

/// Baseline shift (negative = up in SVG coords) for the
/// accidental glyph. Raises the sharp / flat as a superscript next
/// to the root letter. Matches `editor-irealb.html`'s
/// `.chord-acc { vertical-align: 0.18em }` flipped for SVG-down.
pub const CHORD_ACCIDENTAL_DY: i32 = -10;

/// Retained for backward-compat with callers that still read the
/// old "superscript dy" name; equals `CHORD_QUALITY_DY` because
/// the engraved-chart rewrite repurposed the quality span as a
/// subscript while the constant name stayed the same.
#[deprecated(note = "use CHORD_QUALITY_DY")]
pub const CHORD_SUPERSCRIPT_DY: i32 = CHORD_QUALITY_DY;

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
    // plus the maximum possible system-break offset stays within
    // `i32` for every row up to the cap. The break offset cap per
    // row is `3 * VERTICAL_BREAK_PER_LEVEL`; with one such bump
    // per row that is `3 * max_rows * VERTICAL_BREAK_PER_LEVEL`
    // total.
    let break_budget = 3 * (VERTICAL_BREAK_PER_LEVEL as usize);
    let per_row = (BAR_ROW_HEIGHT as usize) + break_budget;
    assert!(max_rows < (i32::MAX as usize) / per_row);
};
