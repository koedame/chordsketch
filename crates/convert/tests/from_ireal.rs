//! Integration tests for the iReal Pro → ChordPro converter
//! (#2053). Exercises the full pipeline:
//! `chordsketch_ireal::parse` → `chordsketch_convert::ireal_to_chordpro`
//! → `chordsketch_chordpro` AST.

use chordsketch_chordpro::ast::{DirectiveKind, Line, Song};
use chordsketch_convert::ireal_to_chordpro;
use chordsketch_ireal::{Bar, Ending, IrealSong, Section, SectionLabel, parse};

const TINY_IREAL_URL: &str = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

fn directive_value(song: &Song, kind: DirectiveKind) -> Option<&str> {
    song.lines.iter().find_map(|line| match line {
        Line::Directive(d) if d.kind == kind => d.value.as_deref(),
        _ => None,
    })
}

#[test]
fn parses_tiny_url_then_converts_cleanly() {
    let ireal = parse(TINY_IREAL_URL).expect("parse tiny");
    let result = ireal_to_chordpro(&ireal).expect("convert succeeds");
    let song = &result.output;

    // Title field came through.
    assert_eq!(directive_value(song, DirectiveKind::Title), Some("T"));
    // Tempo (140) came through.
    assert_eq!(directive_value(song, DirectiveKind::Tempo), Some("140"));
    // Time signature (default 4/4 since the iReal `T34` mid-chart
    // packs to 3/4 — assert the actual value rather than hardcoding
    // either, so the test catches drift but stays grounded in the
    // iReal AST's own value).
    let expected_time = format!(
        "{}/{}",
        ireal.time_signature.numerator, ireal.time_signature.denominator
    );
    assert_eq!(
        directive_value(song, DirectiveKind::Time).map(String::from),
        Some(expected_time)
    );
    // Meta-routed style.
    let meta = song.lines.iter().find_map(|line| match line {
        Line::Directive(d) if d.name == "meta" => d.value.as_deref(),
        _ => None,
    });
    assert!(meta.unwrap_or("").starts_with("style "));
}

#[test]
fn warnings_for_clean_input_are_empty() {
    let ireal = parse(TINY_IREAL_URL).expect("parse tiny");
    let result = ireal_to_chordpro(&ireal).expect("convert succeeds");
    // The current mapping does not warn for the tiny fixture (no
    // pathological repeat-bar). Make the assertion explicit so a
    // future regression that surfaces noise is visible.
    assert!(
        result.warnings.is_empty(),
        "tiny fixture should convert without warnings, got: {:?}",
        result.warnings
    );
}

#[test]
fn converted_song_renders_via_render_text() {
    // The render-text crate is the canonical proof that the
    // converter's output is structurally a valid `Song`. We do
    // not assert specific text content because render-text's
    // output format (where directives surface, how barlines
    // render) is render-text's own concern; this test guards
    // only the structural integrity of the converter's output.
    use chordsketch_render_text::render_song;
    let ireal = parse(TINY_IREAL_URL).expect("parse tiny");
    let song = ireal_to_chordpro(&ireal).expect("convert").output;
    let text = render_song(&song);
    assert!(!text.is_empty(), "render-text returned empty");
    // The bar boundaries we emit are inline `|` text segments;
    // they must survive the renderer.
    assert!(text.contains('|'), "rendered text missing barlines: {text}");
}

#[test]
fn converter_preserves_section_count_for_multi_section_input() {
    // Build a hand-crafted multi-section song with named labels
    // so the converter exercises both the environment-directive
    // path (Verse) and the comment-fallback path (Letter).
    let mut song = IrealSong::new();
    song.title = "Multi".into();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: Vec::new(),
    });
    song.sections.push(Section {
        label: SectionLabel::Verse,
        bars: Vec::new(),
    });
    let result = ireal_to_chordpro(&song).expect("convert");
    let directive_names: Vec<&str> = result
        .output
        .lines
        .iter()
        .filter_map(|line| match line {
            Line::Directive(d) => Some(d.name.as_str()),
            _ => None,
        })
        .collect();
    assert!(directive_names.contains(&"start_of_verse"));
    assert!(directive_names.contains(&"end_of_verse"));
    let comments: Vec<&str> = result
        .output
        .lines
        .iter()
        .filter_map(|line| match line {
            Line::Comment(_, text) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(comments.iter().any(|c| c.contains("Section A")));
}

/// Verifies that `BarChordKind::SlashRepeat` entries are dropped when converting
/// iReal Pro → ChordPro. ChordPro is a lyric-line format with no per-beat repeat
/// marker; emitting the snapshot chord would produce duplicate chord tokens.
/// Covers the `continue` branch at `from_ireal.rs:248` added in #2435.
#[test]
fn slash_repeat_bar_chords_are_not_emitted_as_chord_tokens() {
    // Build `|C7ppF7|`: C7 Played + two SlashRepeat + F7 Played.
    use chordsketch_ireal::{BarChord, BeatPosition, Chord, ChordQuality, ChordRoot, ChordSize};
    let c7 = Chord::triad(ChordRoot::natural('C'), ChordQuality::Dominant7);
    let f7 = Chord::triad(ChordRoot::natural('F'), ChordQuality::Dominant7);
    let bar = Bar {
        chords: vec![
            BarChord::played(
                c7.clone(),
                BeatPosition::on_beat(1).unwrap(),
                ChordSize::Default,
            ),
            BarChord::slash_repeat(
                c7.clone(),
                BeatPosition::on_beat(2).unwrap(),
                ChordSize::Default,
            ),
            BarChord::slash_repeat(
                c7.clone(),
                BeatPosition::on_beat(3).unwrap(),
                ChordSize::Default,
            ),
            BarChord::played(f7, BeatPosition::on_beat(4).unwrap(), ChordSize::Default),
        ],
        ..Bar::new()
    };
    let mut song = IrealSong::new();
    song.title = "Slash Drop Test".into();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    });
    let result = ireal_to_chordpro(&song).expect("convert");
    // Collect chord name strings from every LyricsSegment in the output.
    let chord_names: Vec<&str> = result
        .output
        .lines
        .iter()
        .filter_map(|line| match line {
            Line::Lyrics(ll) => Some(ll),
            _ => None,
        })
        .flat_map(|ll| ll.segments.iter())
        .filter_map(|seg| seg.chord.as_ref().map(|c| c.name.as_str()))
        .collect();
    // Only the two Played chords must appear — the SlashRepeat entries must not
    // produce duplicate chord tokens ("C7 C7 C7 F7").
    assert_eq!(
        chord_names,
        vec!["C7", "F7"],
        "SlashRepeat entries must be dropped; expected [C7, F7], got {chord_names:?}"
    );
}

/// Returns all text segments (concatenated) from every lyrics line in the song.
fn all_lyrics_text(song: &Song) -> String {
    song.lines
        .iter()
        .filter_map(|line| match line {
            Line::Lyrics(ll) => Some(ll),
            _ => None,
        })
        .flat_map(|ll| ll.segments.iter())
        .map(|seg| seg.text.as_str())
        .collect()
}

#[test]
fn numbered_ending_emits_digit_period_text_marker() {
    // A bar carrying `Ending::Numbered(2)` must produce "2. " in the
    // lyrics text so downstream ChordPro renderers can display the
    // second-ending bracket label. Locks `push_pre_bar_marker`'s
    // `Some(n)` arm against regression.
    let mut song = IrealSong::new();
    song.title = "Ending Numbered Test".into();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![Bar {
            ending: Ending::new(2),
            ..Bar::new()
        }],
    });
    let result = ireal_to_chordpro(&song).expect("convert");
    let text = all_lyrics_text(&result.output);
    assert!(
        text.contains("2. "),
        "numbered ending must produce '2. ' in lyrics, got: {text:?}"
    );
}

#[test]
fn untitled_ending_emits_bare_period_text_marker() {
    // A bar carrying `Ending::Untitled` (spec token `N0`) must
    // produce ". " in the lyrics text — a visible marker without
    // an invented digit. Locks `push_pre_bar_marker`'s `None` arm
    // (new in #2436) against regression.
    let mut song = IrealSong::new();
    song.title = "Ending Untitled Test".into();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: vec![Bar {
            ending: Some(Ending::Untitled),
            ..Bar::new()
        }],
    });
    let result = ireal_to_chordpro(&song).expect("convert");
    let text = all_lyrics_text(&result.output);
    assert!(
        text.contains(". "),
        "untitled ending must produce '. ' in lyrics, got: {text:?}"
    );
    assert!(
        !text.contains("0. "),
        "untitled ending must NOT emit a '0.' digit label, got: {text:?}"
    );
}
