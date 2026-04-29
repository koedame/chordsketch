//! PNG rasteriser tests.
//!
//! Uses **structural** assertions rather than byte- or pixel-hash
//! equality. Font rasterisation is non-deterministic across
//! `fontdb` populations (CI Linux fonts vs developer macOS fonts vs
//! Windows fonts), so a strict pixel-hash snapshot would either be
//! permanently flaky on non-Linux runners or force the test to skip
//! on every platform that does not match the snapshot author's box.
//! Structural checks let every supported platform exercise the full
//! rasterisation pipeline (`render_svg` → `usvg::Tree::from_str` →
//! `resvg::render` → `tiny_skia::Pixmap::encode_png`) and catch the
//! defect classes the PNG output is meant to guard against:
//!
//! - SVG produced by `render_svg` becomes invalid (parse failure).
//! - The image dimensions drift from the documented DPI scaling.
//! - The encoder stops emitting a valid PNG header / IEND marker.

#![cfg(feature = "png")]

use chordsketch_ireal::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, IrealSong,
    KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};
use chordsketch_render_ireal::{
    PAGE_HEIGHT, PAGE_WIDTH,
    png::{DEFAULT_DPI, MAX_DPI, PngError, PngOptions, render_png},
};

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

/// Decodes a PNG header to `(width, height)` in pixels. Panics on
/// malformed input — the test suite only feeds output from
/// [`render_png`], which must always be well-formed.
fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    assert!(bytes.len() >= 24, "PNG too short: {}", bytes.len());
    assert_eq!(&bytes[..8], &PNG_SIGNATURE, "missing PNG signature");
    // Bytes 8..12 are the IHDR length (always 13). 12..16 = "IHDR".
    assert_eq!(&bytes[12..16], b"IHDR", "first chunk is not IHDR");
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (width, height)
}

/// Asserts the trailing 12 bytes are the IEND chunk
/// (`00 00 00 00 49 45 4E 44 AE 42 60 82`).
fn assert_png_iend(bytes: &[u8]) {
    let tail = &bytes[bytes.len() - 12..];
    assert_eq!(
        tail,
        &[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82],
        "missing IEND footer"
    );
}

fn build_basic_song() -> IrealSong {
    let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Minor7);
    let bar_chord = BarChord {
        chord,
        position: BeatPosition::on_beat(1).unwrap(),
    };
    let bar = Bar {
        start: BarLine::OpenRepeat,
        end: BarLine::CloseRepeat,
        chords: vec![bar_chord],
        ending: None,
        symbol: Some(MusicalSymbol::Segno),
    };
    IrealSong {
        title: "Autumn Leaves".into(),
        composer: Some("Joseph Kosma".into()),
        style: Some("Medium Swing".into()),
        key_signature: KeySignature {
            root: ChordRoot {
                note: 'E',
                accidental: Accidental::Natural,
            },
            mode: KeyMode::Minor,
        },
        time_signature: TimeSignature::default(),
        tempo: Some(120),
        transpose: 0,
        sections: vec![Section {
            label: SectionLabel::Letter('A'),
            bars: vec![bar],
        }],
    }
}

#[test]
fn empty_song_produces_well_formed_png_at_default_dpi() {
    let song = IrealSong::new();
    let bytes = render_png(&song, &PngOptions::default()).expect("render_png");
    assert!(!bytes.is_empty());
    let (width, height) = png_dimensions(&bytes);
    // Default DPI = 300; CSS px/inch = 96; the SVG viewBox is
    // `PAGE_WIDTH × PAGE_HEIGHT` in CSS px. Use ceiling division so
    // the assertion matches the renderer's `ceil()` rounding.
    let expected_w = ((PAGE_WIDTH as u32) * DEFAULT_DPI).div_ceil(96);
    let expected_h = ((PAGE_HEIGHT as u32) * DEFAULT_DPI).div_ceil(96);
    assert_eq!(
        (width, height),
        (expected_w, expected_h),
        "PNG dimensions diverged from DPI scaling"
    );
    assert_png_iend(&bytes);
}

#[test]
fn basic_song_produces_well_formed_png() {
    let song = build_basic_song();
    let bytes = render_png(&song, &PngOptions::default()).expect("render_png");
    assert!(
        bytes.len() > 1024,
        "PNG suspiciously small: {} bytes",
        bytes.len()
    );
    let (width, height) = png_dimensions(&bytes);
    let expected_w = ((PAGE_WIDTH as u32) * DEFAULT_DPI).div_ceil(96);
    let expected_h = ((PAGE_HEIGHT as u32) * DEFAULT_DPI).div_ceil(96);
    assert_eq!((width, height), (expected_w, expected_h));
    assert_png_iend(&bytes);
}

#[test]
fn custom_dpi_changes_pixel_dimensions() {
    let song = IrealSong::new();
    let opts = PngOptions::with_dpi(150);
    let bytes = render_png(&song, &opts).expect("render_png");
    let (width, height) = png_dimensions(&bytes);
    let expected_w = ((PAGE_WIDTH as u32) * 150).div_ceil(96);
    let expected_h = ((PAGE_HEIGHT as u32) * 150).div_ceil(96);
    assert_eq!(
        (width, height),
        (expected_w, expected_h),
        "150 DPI did not produce the expected dimensions"
    );
}

#[test]
fn dpi_zero_returns_dpi_out_of_range() {
    let song = IrealSong::new();
    let bad = PngOptions::with_dpi(0);
    let err = render_png(&song, &bad).expect_err("zero DPI must error");
    assert!(matches!(err, PngError::DpiOutOfRange(0)));
}

#[test]
fn dpi_above_max_returns_dpi_out_of_range() {
    let song = IrealSong::new();
    let bad = PngOptions::with_dpi(MAX_DPI + 1);
    let err = render_png(&song, &bad).expect_err("oversized DPI must error");
    assert!(matches!(err, PngError::DpiOutOfRange(d) if d == MAX_DPI + 1));
}

#[test]
fn dpi_at_boundary_succeeds() {
    let song = IrealSong::new();
    let one_dpi = PngOptions::with_dpi(1);
    let bytes = render_png(&song, &one_dpi).expect("dpi=1 is in range");
    let (width, height) = png_dimensions(&bytes);
    let expected_w = (PAGE_WIDTH as u32).div_ceil(96);
    let expected_h = (PAGE_HEIGHT as u32).div_ceil(96);
    assert_eq!((width, height), (expected_w, expected_h));
}

#[test]
fn default_options_use_default_dpi() {
    let song = IrealSong::new();
    let default_bytes = render_png(&song, &PngOptions::default()).expect("default");
    let explicit = PngOptions::with_dpi(DEFAULT_DPI);
    let explicit_bytes = render_png(&song, &explicit).expect("explicit default");
    assert_eq!(
        default_bytes, explicit_bytes,
        "PngOptions::default() must equal explicit DEFAULT_DPI"
    );
}

#[test]
fn png_error_display_includes_dpi() {
    let err = PngError::DpiOutOfRange(9999);
    let msg = format!("{err}");
    assert!(
        msg.contains("9999"),
        "error message dropped DPI value: {msg}"
    );
    assert!(msg.contains(&MAX_DPI.to_string()));
}

#[test]
fn png_error_display_covers_remaining_variants() {
    // The other three variants (`SvgParse`, `PixmapAlloc`,
    // `PngEncode`) only fire on internal-consistency / OOM bugs that
    // are not reachable via `render_png` with any production input.
    // Construct each variant directly and assert the `Display` arm
    // includes the diagnostic payload — this is the only path that
    // exercises the formatter for those branches and keeps the
    // patch-coverage gate from regressing if a maintainer tweaks one
    // of the messages.
    let svg = format!("{}", PngError::SvgParse("unexpected token".into()));
    assert!(svg.contains("SVG parse failed"));
    assert!(svg.contains("unexpected token"));

    let alloc = format!("{}", PngError::PixmapAlloc(123, 456));
    assert!(alloc.contains("123"));
    assert!(alloc.contains("456"));
    assert!(alloc.contains("pixmap allocation failed"));

    let encode = format!("{}", PngError::PngEncode("io error".into()));
    assert!(encode.contains("PNG encode failed"));
    assert!(encode.contains("io error"));
}
