//! Golden-snapshot test for the SVG skeleton.
//!
//! Builds the same `IrealSong` every run (an "Autumn Leaves" stub
//! with one bar) and asserts the renderer's output is byte-identical
//! to `tests/fixtures/basic/expected.svg`.
//!
//! When the renderer changes intentionally (constants, header
//! layout, grid math), regenerate the snapshot:
//!
//! ```bash
//! UPDATE_GOLDEN=1 cargo test -p chordsketch-render-ireal
//! ```
//!
//! and re-run the test without the env var to confirm parity. Drop
//! the env var from the commit — it is read only at test time.

use chordsketch_ireal::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, IrealSong,
    KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};
use chordsketch_render_ireal::{RenderOptions, render_svg};

const EXPECTED: &str = include_str!("fixtures/basic/expected.svg");

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
fn render_basic_song_matches_golden() {
    let song = build_basic_song();
    let actual = render_svg(&song, &RenderOptions::default());
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/basic/expected.svg"
        );
        std::fs::write(path, &actual).expect("write golden fixture");
    }
    assert_eq!(
        actual, EXPECTED,
        "render output drifted; rerun with UPDATE_GOLDEN=1 to regenerate"
    );
}

#[test]
fn empty_song_renders_well_formed_svg_with_no_grid() {
    // A song with zero bars must still produce a valid SVG: page
    // frame + header band, but the `<g class="bar-grid">` is
    // omitted because the row count rounds down to zero. The
    // renderer must not emit an empty `<g>` (which would change
    // the byte-stable layout once chord text lands).
    let song = IrealSong::new();
    let actual = render_svg(&song, &RenderOptions::default());
    assert!(actual.starts_with("<?xml version=\"1.0\""));
    assert!(actual.contains("<svg "));
    assert!(actual.ends_with("</svg>\n"));
    assert!(
        !actual.contains("class=\"bar-grid\""),
        "empty song must not emit a bar-grid group: {actual}"
    );
}

#[test]
fn header_uses_default_text_when_metadata_is_missing() {
    // Title falls back to "Untitled"; style and key fall back
    // to the default "Medium Swing" + "C major".
    let song = IrealSong::new();
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(svg.contains(">Untitled<"), "expected Untitled fallback");
    assert!(
        svg.contains("Medium Swing"),
        "expected default style placeholder: {svg}"
    );
    assert!(
        svg.contains("C major"),
        "expected default key placeholder: {svg}"
    );
    assert!(
        !svg.contains("class=\"composer\""),
        "absent composer must omit the composer text element"
    );
}

#[test]
fn xml_reserved_chars_in_title_are_escaped() {
    // Adversarial title is escaped before reaching the SVG so a
    // future caller cannot smuggle markup through the public API.
    let mut song = IrealSong::new();
    song.title = "<bad>&\"foo\"".into();
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(
        svg.contains("&lt;bad&gt;&amp;&quot;foo&quot;"),
        "title was not escaped: {svg}"
    );
    assert!(
        !svg.contains("<bad>"),
        "unescaped tag leaked into output: {svg}"
    );
}

#[test]
fn flat_key_emits_unicode_flat_glyph() {
    // The key formatter renders the flat sign as U+266D, which
    // passes through `escape_xml` unchanged because flats are not
    // XML-reserved.
    let mut song = IrealSong::new();
    song.key_signature.root = ChordRoot {
        note: 'B',
        accidental: Accidental::Flat,
    };
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(svg.contains("B\u{266D} major"), "missing flat glyph: {svg}");
}

#[test]
fn multi_row_bar_grid_emits_one_row_per_four_bars() {
    // 9 bars round up to 3 rows (4 + 4 + 1, with the last row's
    // trailing 3 cells still drawn empty per the documented
    // "fixed 4-cell grid" contract).
    let mut song = IrealSong::new();
    let mut bars = Vec::with_capacity(9);
    for _ in 0..9 {
        bars.push(Bar::new());
    }
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars,
    });
    let svg = render_svg(&song, &RenderOptions::default());
    let cell_count = svg.matches("<rect").count();
    // 1 page frame + 12 grid cells (3 rows × 4 cells) = 13.
    assert_eq!(
        cell_count, 13,
        "expected 13 <rect> elements (1 frame + 12 cells), got {cell_count}: {svg}"
    );
}
