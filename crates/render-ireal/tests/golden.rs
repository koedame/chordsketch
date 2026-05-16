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
use chordsketch_render_ireal::{RenderOptions, render_svg, version};

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
    // Title falls back to "Untitled"; style falls back to
    // "(Medium Swing)" italic label. The engraved-chart header
    // (`design-system/ui_kits/web/editor-irealb.html`) no longer
    // surfaces the key — that lives in the playground's meta-card
    // form. The composer text element is omitted entirely when
    // the AST has no composer value.
    let song = IrealSong::new();
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(svg.contains(">Untitled<"), "expected Untitled fallback");
    assert!(
        svg.contains("(Medium Swing)"),
        "expected default style placeholder: {svg}"
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
    // The engraved-chart header dropped the key text from the
    // SVG (the playground's meta-card edits it instead), but a
    // chord with a flat root must still render the U+266D glyph
    // in the chord-root span. Add a B♭ chord and assert the
    // glyph reaches the SVG unescaped.
    let mut song = IrealSong::new();
    let chord = Chord::triad(
        ChordRoot {
            note: 'B',
            accidental: Accidental::Flat,
        },
        ChordQuality::Major,
    );
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![Bar {
            chords: vec![BarChord {
                chord,
                position: BeatPosition::on_beat(1).unwrap(),
            }],
            ..Bar::new()
        }],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    // Engraved-chart layout splits root + accidental: "B" lives
    // in the chord-root span, "♭" in the chord-acc span.
    assert!(
        svg.contains("class=\"chord-root\">B</tspan>"),
        "missing root span: {svg}"
    );
    assert!(
        svg.contains("class=\"chord-acc\""),
        "missing acc span: {svg}"
    );
    assert!(svg.contains('\u{266D}'), "missing flat glyph: {svg}");
}

#[test]
fn multi_row_bar_grid_emits_one_barline_per_bar() {
    // 9 bars round up to 3 rows (4 + 4 + 1). The engraved chart
    // emits one left barline per bar plus one right barline at
    // the end of each row (3 rows × 1 right barline = 3) — total
    // 9 + 3 = 12 single barlines. Trailing empties are not drawn
    // (no cell rectangles in the engraved style).
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
    let single_barline_count = svg.matches("class=\"barline-single\"").count();
    assert_eq!(
        single_barline_count, 12,
        "expected 12 barlines (9 bars + 3 row-end), got {single_barline_count}: {svg}"
    );
}

#[test]
fn grid_aligns_to_right_margin() {
    // The rightmost barline of a fully-populated row must sit
    // exactly at `PAGE_WIDTH - MARGIN_X`. Use BARS_PER_ROW bars so
    // the row is full — partial rows end at the last bar's right
    // barline (intentional in the engraved chart; trailing empties
    // are no longer drawn).
    use chordsketch_render_ireal::{BARS_PER_ROW, MARGIN_X, PAGE_WIDTH};
    let mut song = IrealSong::new();
    let bars = (0..BARS_PER_ROW).map(|_| Bar::new()).collect();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars,
    });
    let svg = render_svg(&song, &RenderOptions::default());
    // Every barline appears as `<line x1="X" y1="..." x2="X" ...
    // class="barline-single"/>`. Collect every `x1` value of a
    // single barline and verify the maximum equals the right
    // margin — that is the "rightmost barline" of the only row.
    let needle = "class=\"barline-single\"";
    let max_x = svg
        .rmatch_indices(needle)
        .map(|(idx, _)| &svg[..idx])
        .filter_map(|prefix| prefix.rfind("<line").map(|start| &svg[start..]))
        .map(|line| {
            let close = line.find('>').expect("line tag closes");
            parse_attr(&line[..=close], "x1")
        })
        .max()
        .expect("at least one barline");
    assert_eq!(
        max_x,
        PAGE_WIDTH - MARGIN_X,
        "rightmost barline at {} but expected {}",
        max_x,
        PAGE_WIDTH - MARGIN_X
    );
}

fn parse_attr(tag: &str, name: &str) -> i32 {
    let needle = format!("{name}=\"");
    let start = tag
        .find(&needle)
        .unwrap_or_else(|| panic!("attr {name:?} missing in {tag}"))
        + needle.len();
    let rest = &tag[start..];
    let end = rest
        .find('"')
        .unwrap_or_else(|| panic!("attr {name:?} unterminated"));
    rest[..end]
        .parse()
        .unwrap_or_else(|_| panic!("attr {name:?} not an integer"))
}

#[test]
fn render_clamps_bar_count_to_max_bars() {
    // An adversarial AST with > MAX_BARS bars must not allocate
    // an unbounded number of barlines; surplus bars are silently
    // truncated. This keeps the renderer's memory cost bounded
    // and the y-coordinate arithmetic safe.
    use chordsketch_render_ireal::{BARS_PER_ROW, MAX_BARS};
    let mut song = IrealSong::new();
    let bar_count = MAX_BARS + 100;
    let mut bars = Vec::with_capacity(bar_count);
    for _ in 0..bar_count {
        bars.push(Bar::new());
    }
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars,
    });
    let svg = render_svg(&song, &RenderOptions::default());
    // Expected: MAX_BARS left barlines + (MAX_BARS / BARS_PER_ROW)
    // row-end right barlines.
    let expected_rows = MAX_BARS.div_ceil(BARS_PER_ROW);
    let expected_lines = MAX_BARS + expected_rows;
    let actual = svg.matches("class=\"barline-single\"").count();
    assert_eq!(
        actual, expected_lines,
        "expected {expected_lines} barlines (MAX_BARS + row-ends), got {actual}"
    );
}

#[test]
fn out_of_range_chord_root_falls_back_to_question_mark() {
    // Direct field assignment on `pub` AST fields can produce an
    // out-of-range note letter; the renderer falls back to `?` so
    // a corrupted root produces a deterministic, visually distinct
    // output rather than nonsense.
    use chordsketch_ireal::{Accidental, ChordRoot};
    let mut song = IrealSong::new();
    let chord = Chord::triad(
        ChordRoot {
            note: 'X',
            accidental: Accidental::Natural,
        },
        ChordQuality::Major,
    );
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![Bar {
            chords: vec![BarChord {
                chord,
                position: BeatPosition::on_beat(1).unwrap(),
            }],
            ..Bar::new()
        }],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(
        svg.contains("class=\"chord-root\">?</tspan>"),
        "expected `?` fallback for out-of-range note: {svg}"
    );
    assert!(
        !svg.contains("class=\"chord-root\">X</tspan>"),
        "out-of-range note must not flow into the SVG: {svg}"
    );
}

#[test]
fn xml_illegal_control_chars_are_stripped_from_title() {
    // Adversarial title containing C0 controls (NUL, BEL, ESC)
    // must not appear in the SVG output — they are stripped, not
    // escaped, because XML 1.0 forbids them entirely.
    let mut song = IrealSong::new();
    song.title = "ti\u{0000}tle\u{001B}".into();
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(svg.contains(">title<"), "expected stripped title: {svg}");
    assert!(
        !svg.contains('\u{0000}'),
        "NUL must be stripped from the SVG"
    );
    assert!(
        !svg.contains('\u{001B}'),
        "ESC must be stripped from the SVG"
    );
}

#[test]
fn sharp_key_emits_unicode_sharp_glyph() {
    // Sharp glyph (U+266F) reaches the SVG via the chord-root span;
    // sharp signs are not XML-reserved so they pass through
    // `escape_xml` unchanged.
    let mut song = IrealSong::new();
    let chord = Chord::triad(
        ChordRoot {
            note: 'F',
            accidental: Accidental::Sharp,
        },
        ChordQuality::Major,
    );
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![Bar {
            chords: vec![BarChord {
                chord,
                position: BeatPosition::on_beat(1).unwrap(),
            }],
            ..Bar::new()
        }],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(
        svg.contains("class=\"chord-root\">F</tspan>"),
        "missing root span: {svg}"
    );
    assert!(
        svg.contains("class=\"chord-acc\""),
        "missing acc span: {svg}"
    );
    assert!(svg.contains('\u{266F}'), "missing sharp glyph: {svg}");
}

#[test]
fn slash_chord_renders_with_chord_slash_and_chord_bass_classes() {
    // Exercises the `SpanKind::Slash` + `SpanKind::Bass` SVG-emit
    // path. Without a slash chord in any progression fixture, the
    // `chord-slash` / `chord-bass` `<tspan>` branches were
    // unexercised for coverage purposes.
    let bar = Bar {
        chords: vec![BarChord {
            chord: Chord {
                root: ChordRoot::natural('C'),
                quality: ChordQuality::Major7,
                bass: Some(ChordRoot::natural('G')),
                alternate: None,
            },
            position: BeatPosition::on_beat(1).unwrap(),
        }],
        ..Bar::new()
    };
    let mut song = IrealSong::new();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(
        svg.contains("class=\"chord-root\">C</tspan>"),
        "expected root span: {svg}"
    );
    assert!(
        svg.contains("class=\"chord-ext\""),
        "expected extension span: {svg}"
    );
    assert!(
        svg.contains("class=\"chord-slash\""),
        "expected slash span: {svg}"
    );
    assert!(
        svg.contains("class=\"chord-bass\""),
        "expected bass span: {svg}"
    );
    // The slash span must reset font-size + apply an inverse
    // `dy` so the baseline returns to the chord baseline after
    // the subscript-positioned quality. The shift equals the
    // negation of `CHORD_QUALITY_DY` (currently +5 → -5).
    assert!(
        svg.contains("class=\"chord-slash\" font-size=\"32\" dy=\"-5\""),
        "expected baseline restore on slash span: {svg}"
    );
}

#[test]
fn slash_chord_without_quality_uses_unshifted_slash_span() {
    // When the chord has no quality (Major triad), the slash and
    // bass run on the original baseline directly — no `dy`
    // restore is needed because no extension preceded them.
    let bar = Bar {
        chords: vec![BarChord {
            chord: Chord {
                root: ChordRoot::natural('C'),
                quality: ChordQuality::Major,
                bass: Some(ChordRoot::natural('E')),
                alternate: None,
            },
            position: BeatPosition::on_beat(1).unwrap(),
        }],
        ..Bar::new()
    };
    let mut song = IrealSong::new();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(svg.contains("<tspan class=\"chord-slash\">/</tspan>"));
    assert!(svg.contains("<tspan class=\"chord-bass\">E</tspan>"));
    assert!(
        !svg.contains("class=\"chord-slash\" font-size"),
        "no font-size override expected when no extension precedes slash"
    );
}

#[test]
fn multi_chord_bar_emits_one_text_per_chord() {
    // Engraved chart layout (`design-system/ui_kits/web/
    // editor-irealb.html`) positions each chord at its own beat
    // column inside the bar, so multi-chord bars render as one
    // `<text>` per chord rather than a single space-separated
    // line. Verify both chords appear with their own root spans
    // (the engraved layout does not need an inter-chord baseline-
    // restore separator).
    let bar = Bar {
        chords: vec![
            BarChord {
                chord: Chord::triad(ChordRoot::natural('A'), ChordQuality::Minor7),
                position: BeatPosition::on_beat(1).unwrap(),
            },
            BarChord {
                chord: Chord::triad(ChordRoot::natural('D'), ChordQuality::Minor7),
                position: BeatPosition::on_beat(3).unwrap(),
            },
        ],
        ..Bar::new()
    };
    let mut song = IrealSong::new();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(
        svg.contains("<tspan class=\"chord-root\">A</tspan>"),
        "first chord root must appear: {svg}"
    );
    assert!(
        svg.contains("<tspan class=\"chord-root\">D</tspan>"),
        "second chord root must appear: {svg}"
    );
}

#[test]
fn excess_chords_per_bar_render_at_most_max_chords_per_bar_root_spans() {
    // Regression test ported from the deleted `chord_format.rs`
    // (`excess_chords_per_bar_are_truncated`). An adversarial AST
    // with > MAX_CHORDS_PER_BAR chords in a single bar must
    // produce exactly `MAX_CHORDS_PER_BAR` chord-root spans —
    // surplus chords are truncated to keep the renderer's
    // allocation bounded.
    use chordsketch_render_ireal::MAX_CHORDS_PER_BAR;
    let mut chords = Vec::with_capacity(MAX_CHORDS_PER_BAR + 100);
    for _ in 0..(MAX_CHORDS_PER_BAR + 100) {
        chords.push(BarChord {
            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
            position: BeatPosition::on_beat(1).unwrap(),
        });
    }
    let bar = Bar {
        chords,
        ..Bar::new()
    };
    let mut song = IrealSong::new();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    let root_spans = svg.matches("class=\"chord-root\"").count();
    assert_eq!(
        root_spans, MAX_CHORDS_PER_BAR,
        "expected exactly MAX_CHORDS_PER_BAR={MAX_CHORDS_PER_BAR} root spans"
    );
}

#[test]
fn custom_quality_xml_reserved_chars_are_escaped_at_emit_boundary() {
    // `ChordQuality::Custom` is attacker-controlled in principle.
    // The typography splitter passes it through verbatim by
    // design (XML escaping is the renderer's job); this test
    // asserts the contract end-to-end so a refactor that
    // bypasses `escape_xml` at the embedding boundary cannot
    // smuggle markup through.
    let bar = Bar {
        chords: vec![BarChord {
            chord: Chord::triad(
                ChordRoot::natural('C'),
                ChordQuality::Custom("<x>&\"'".into()),
            ),
            position: BeatPosition::on_beat(1).unwrap(),
        }],
        ..Bar::new()
    };
    let mut song = IrealSong::new();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    });
    let svg = render_svg(&song, &RenderOptions::default());
    assert!(
        svg.contains("&lt;x&gt;&amp;&quot;&apos;"),
        "custom quality not escaped: {svg}"
    );
    assert!(
        !svg.contains("<x>"),
        "raw custom-quality markup leaked: {svg}"
    );
}

#[test]
fn version_returns_nonempty_semver_string() {
    let v = version();
    assert!(!v.is_empty(), "version() must not return an empty string");
    // The version is baked in from Cargo.toml at compile time; it must
    // start with a digit (semver major component).
    assert!(
        v.chars().next().is_some_and(|c| c.is_ascii_digit()),
        "version() should start with a digit: {v}"
    );
}
