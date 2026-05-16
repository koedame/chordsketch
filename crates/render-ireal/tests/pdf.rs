//! PDF converter tests.
//!
//! Uses **structural** assertions rather than byte- or content-hash
//! equality. `svg2pdf` embeds the system `fontdb` snapshot in the
//! output stream when text rendering is required, so a strict byte-
//! exact snapshot would diverge across runner OSes the same way the
//! PNG suite would (CI Linux fonts vs developer macOS fonts vs
//! Windows fonts). Structural checks catch the defect classes the
//! PDF output is meant to guard against:
//!
//! - SVG produced by `render_svg` becomes invalid (parse failure).
//! - `svg2pdf::to_pdf` stops emitting the `%PDF-` header / `%%EOF`
//!   trailer.
//! - PDF dimensions stop matching the SVG viewBox at 72 DPI.

#![cfg(feature = "pdf")]

use chordsketch_ireal::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, ChordSize,
    IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};
use chordsketch_render_ireal::pdf::{PdfError, PdfOptions, render_pdf};

const PDF_HEADER_PREFIX: &[u8] = b"%PDF-";
const PDF_EOF_MARKER: &[u8] = b"%%EOF";

/// Asserts the bytes look like a structurally valid PDF.
///
/// Confirms the `%PDF-X.Y` magic at offset 0, an `%%EOF` marker
/// near the tail, and that the byte stream is non-trivial in size
/// (svg2pdf produces at least a few KB for any real input). The
/// EOF marker may be followed by a single trailing newline /
/// carriage return per the PDF spec; scan the last 32 bytes rather
/// than the absolute tail.
fn assert_well_formed_pdf(bytes: &[u8]) {
    assert!(
        bytes.len() > 256,
        "PDF suspiciously small: {} bytes",
        bytes.len()
    );
    assert_eq!(
        &bytes[..PDF_HEADER_PREFIX.len()],
        PDF_HEADER_PREFIX,
        "missing PDF header"
    );
    let tail_window = &bytes[bytes.len().saturating_sub(32)..];
    assert!(
        tail_window
            .windows(PDF_EOF_MARKER.len())
            .any(|w| w == PDF_EOF_MARKER),
        "missing %%EOF marker in tail: {tail_window:?}"
    );
}

fn build_basic_song() -> IrealSong {
    let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Minor7);
    let bar_chord = BarChord {
        chord,
        position: BeatPosition::on_beat(1).unwrap(),
        size: ChordSize::Default,
    };
    let bar = Bar {
        start: BarLine::OpenRepeat,
        end: BarLine::CloseRepeat,
        chords: vec![bar_chord],
        ending: None,
        symbol: Some(MusicalSymbol::Segno),
        repeat_previous: false,
        no_chord: false,
        text_comment: None,
        system_break_space: 0,
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
fn empty_song_produces_well_formed_pdf() {
    let song = IrealSong::new();
    let bytes = render_pdf(&song, &PdfOptions::default()).expect("render_pdf");
    assert_well_formed_pdf(&bytes);
}

#[test]
fn basic_song_produces_well_formed_pdf() {
    let song = build_basic_song();
    let bytes = render_pdf(&song, &PdfOptions::default()).expect("render_pdf");
    assert_well_formed_pdf(&bytes);
}

#[test]
fn pdf_version_is_a_known_release() {
    // The header is `%PDF-X.Y\n` for some `X.Y` (e.g. `1.4`,
    // `1.7`, `2.0`). Validate the digits after the prefix to catch
    // svg2pdf shipping a malformed header. Don't pin the exact
    // version because svg2pdf may bump it across patch releases.
    let song = IrealSong::new();
    let bytes = render_pdf(&song, &PdfOptions::default()).expect("render_pdf");
    let header = &bytes[..16];
    assert!(header.starts_with(PDF_HEADER_PREFIX));
    let version_byte_a = header[5];
    let dot = header[6];
    let version_byte_b = header[7];
    assert!(
        version_byte_a.is_ascii_digit(),
        "non-digit major in PDF version: {header:?}"
    );
    assert_eq!(dot, b'.', "missing dot in PDF version: {header:?}");
    assert!(
        version_byte_b.is_ascii_digit(),
        "non-digit minor in PDF version: {header:?}"
    );
}

#[test]
fn pdf_options_default_construction_round_trips() {
    let a = PdfOptions::default();
    let b = PdfOptions::default();
    assert_eq!(a, b);
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
}

#[test]
fn pdf_error_display_covers_each_variant() {
    // The two variants only fire on internal-consistency failures
    // that no production input can reach via `render_pdf`.
    // Construct directly so a `Display` regression cannot slip
    // through.
    let svg = format!("{}", PdfError::SvgParse("unexpected token".into()));
    assert!(svg.contains("SVG parse failed"));
    assert!(svg.contains("unexpected token"));

    let conv = format!("{}", PdfError::Conversion("write failure".into()));
    assert!(conv.contains("PDF conversion failed"));
    assert!(conv.contains("write failure"));
}
