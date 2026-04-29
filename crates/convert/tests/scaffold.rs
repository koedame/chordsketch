//! Smoke tests for the conversion scaffold.
//!
//! These tests exist to catch regressions in the public API surface
//! during the pre-implementation phase. Each test asserts a
//! property the follow-up issues (#2053, #2061) must preserve when
//! they replace the `NotImplemented` returns with real
//! conversions.

use chordsketch_chordpro::ast::Song;
use chordsketch_convert::{
    ChordProToIreal, ConversionError, ConversionOutput, ConversionWarning, Converter,
    IrealToChordPro, WarningKind, chordpro_to_ireal, ireal_to_chordpro,
};
use chordsketch_ireal::IrealSong;

#[test]
fn chordpro_to_ireal_returns_ireal_song_after_2061() {
    // #2061 landed, so this direction now produces an
    // `IrealSong`. Smoke check: an empty `Song::new()` source
    // converts cleanly with no warnings (no metadata, no lines,
    // nothing to drop). Thorough coverage lives in
    // `crates/convert/src/to_ireal.rs` unit tests.
    let song = Song::new();
    let output = chordpro_to_ireal(&song).expect("post-#2061 conversion succeeds");
    assert!(
        output.warnings.is_empty(),
        "empty Song should produce no warnings, got: {:?}",
        output.warnings
    );
}

#[test]
fn ireal_to_chordpro_returns_song_after_2053() {
    // #2053 landed, so this direction now produces a `Song`. The
    // smoke check is "the output has at least one directive that
    // came from the iReal metadata"; thorough coverage lives in
    // `crates/convert/src/from_ireal.rs` unit tests.
    let song = IrealSong::new();
    let output = ireal_to_chordpro(&song).expect("post-#2053 conversion succeeds");
    assert!(
        !output.output.lines.is_empty(),
        "iReal → ChordPro must emit at least the title directive even for an empty source"
    );
}

#[test]
fn marker_types_dispatch_through_trait_and_free_fn() {
    // The trait method and the free-function wrapper must agree
    // in both directions. The markers are stateless so the two
    // paths must produce byte-identical outputs; we compare the
    // serialised JSON shape (via `chordsketch_ireal::ToJson` /
    // `chordsketch-chordpro` line counts) as a coarse equality
    // check.
    let chordpro = Song::new();
    let ireal = IrealSong::new();

    let trait_a = ChordProToIreal
        .convert(&chordpro)
        .expect("ChordProToIreal succeeds post-#2061");
    let free_a = chordpro_to_ireal(&chordpro).expect("free-fn matches");
    assert_eq!(
        trait_a.output.title, free_a.output.title,
        "ChordProToIreal trait/free-fn divergence on title"
    );

    let trait_b = IrealToChordPro
        .convert(&ireal)
        .expect("iReal→ChordPro succeeds post-#2053");
    let free_b = ireal_to_chordpro(&ireal).expect("free-fn matches");
    assert_eq!(
        trait_b.output.lines.len(),
        free_b.output.lines.len(),
        "IrealToChordPro trait/free-fn divergence"
    );
}

#[test]
fn conversion_output_lossless_constructor_yields_empty_warnings() {
    let output = ConversionOutput::lossless(42_u32);
    assert_eq!(output.output, 42);
    assert!(output.warnings.is_empty());
}

#[test]
fn conversion_output_with_warnings_preserves_warning_list() {
    let warnings = vec![
        ConversionWarning::new(WarningKind::LossyDrop, "lyrics dropped"),
        ConversionWarning::new(WarningKind::Approximated, "section label mapped"),
    ];
    let output = ConversionOutput::with_warnings(0_u8, warnings.clone());
    assert_eq!(output.warnings, warnings);
}

#[test]
fn conversion_error_display_includes_tracking_url() {
    let err = ConversionError::NotImplemented("https://github.com/koedame/chordsketch/issues/2053");
    let s = format!("{err}");
    assert!(
        s.contains("issues/2053"),
        "Display impl should include tracking URL: got {s}"
    );
}

#[test]
fn version_is_nonempty() {
    let v = chordsketch_convert::version();
    assert!(!v.is_empty(), "version() must not return an empty string");
}

#[test]
fn warning_kind_variants_are_distinct() {
    assert_ne!(WarningKind::LossyDrop, WarningKind::Approximated);
    assert_ne!(WarningKind::Approximated, WarningKind::Unsupported);
    assert_ne!(WarningKind::LossyDrop, WarningKind::Unsupported);
}

#[test]
fn conversion_error_invalid_source_includes_message() {
    let err = ConversionError::InvalidSource("missing root".into());
    let s = format!("{err}");
    assert!(s.contains("missing root"), "Display: {s}");
}

#[test]
fn conversion_error_unrepresentable_target_includes_message() {
    let err = ConversionError::UnrepresentableTarget("13/4 time".into());
    let s = format!("{err}");
    assert!(s.contains("13/4 time"), "Display: {s}");
}
