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
fn chordpro_to_ireal_currently_returns_not_implemented() {
    let song = Song::new();
    match chordpro_to_ireal(&song) {
        Err(ConversionError::NotImplemented(tracking)) => {
            assert!(
                tracking.contains("/2061"),
                "tracking pointer should reference #2061, got {tracking}"
            );
        }
        other => panic!("expected NotImplemented, got {other:?}"),
    }
}

#[test]
fn ireal_to_chordpro_currently_returns_not_implemented() {
    let song = IrealSong::new();
    match ireal_to_chordpro(&song) {
        Err(ConversionError::NotImplemented(tracking)) => {
            assert!(
                tracking.contains("/2053"),
                "tracking pointer should reference #2053, got {tracking}"
            );
        }
        other => panic!("expected NotImplemented, got {other:?}"),
    }
}

#[test]
fn marker_types_implement_converter_via_trait() {
    // The free-function wrappers and the trait-method paths must
    // produce structurally equal results; if a future change
    // implements only one, this test catches the asymmetry.
    // Asserting on the `NotImplemented` variant directly (rather
    // than relying on `assert_eq!` of the wrapping `Result`) keeps
    // the failure mode legible once #2053 / #2061 land and the
    // `Ok` arm becomes reachable: a divergence would surface as a
    // mismatched tracking URL or an unexpected variant rather than
    // an opaque `Result` inequality.
    let chordpro = Song::new();
    let ireal = IrealSong::new();

    let trait_a = match ChordProToIreal.convert(&chordpro) {
        Err(ConversionError::NotImplemented(url)) => url,
        other => panic!("expected NotImplemented, got {other:?}"),
    };
    let free_a = match chordpro_to_ireal(&chordpro) {
        Err(ConversionError::NotImplemented(url)) => url,
        other => panic!("expected NotImplemented, got {other:?}"),
    };
    assert_eq!(trait_a, free_a, "ChordProToIreal trait/free-fn divergence");

    let trait_b = match IrealToChordPro.convert(&ireal) {
        Err(ConversionError::NotImplemented(url)) => url,
        other => panic!("expected NotImplemented, got {other:?}"),
    };
    let free_b = match ireal_to_chordpro(&ireal) {
        Err(ConversionError::NotImplemented(url)) => url,
        other => panic!("expected NotImplemented, got {other:?}"),
    };
    assert_eq!(trait_b, free_b, "IrealToChordPro trait/free-fn divergence");
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
