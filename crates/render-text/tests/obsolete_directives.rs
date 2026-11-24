//! The obsolete upstream directives, fed through the parser and the text
//! renderer.
//!
//! `docs/known-deviations.md` states that ChordSketch accepts `{grid}`,
//! `{g}`, `{no_grid}`, `{ng}`, `{titles}` and `{pagesize}` without error and
//! ignores them. `crates/chordpro/tests/upstream_directives.rs` checks how
//! those names resolve; the tests here check what happens to a song that
//! contains one.

use chordsketch_chordpro::ast::{DirectiveKind, Line};
use chordsketch_chordpro::parse;
use chordsketch_render_text::render_song;

const BEFORE: &str = "[G]Line before";
const AFTER: &str = "[C]Line after";

/// Asserts that `line` is a lyrics line carrying `chord` over `text`.
fn assert_lyrics(line: &Line, chord: &str, text: &str) {
    let Line::Lyrics(lyrics) = line else {
        panic!("expected a lyrics line, got: {line:?}");
    };
    assert_eq!(lyrics.segments.len(), 1, "segments of {lyrics:?}");
    assert_eq!(
        lyrics.segments[0].chord.as_ref().map(|c| c.name.as_str()),
        Some(chord)
    );
    assert_eq!(lyrics.segments[0].text, text);
}

/// Parses and renders a song with `directive` between two lyrics lines and
/// asserts that it is accepted, that the lines around it are parsed as
/// written, and that the text output is the output of the same song without
/// the directive.
fn assert_accepted_and_ignored(directive: &str) {
    let input = format!("{BEFORE}\n{directive}\n{AFTER}\n");
    let song = parse(&input).unwrap_or_else(|e| panic!("{directive} was rejected: {e}"));

    assert_eq!(song.lines.len(), 3, "lines of {song:?}");
    assert_lyrics(&song.lines[0], "G", "Line before");
    assert!(
        matches!(
            &song.lines[1],
            Line::Directive(d) if matches!(d.kind, DirectiveKind::Unknown(_))
        ),
        "{directive} should parse as an unrecognised directive, got: {:?}",
        song.lines[1]
    );
    assert_lyrics(&song.lines[2], "C", "Line after");

    let without = parse(&format!("{BEFORE}\n{AFTER}\n")).expect("parse failed");
    let output = render_song(&song);
    assert_eq!(output, render_song(&without));
    assert_eq!(output, "G\nLine before\nC\nLine after\n");
}

#[test]
fn obsolete_grid_directive_is_accepted_and_ignored() {
    assert_accepted_and_ignored("{grid}");
}

#[test]
fn obsolete_g_directive_is_accepted_and_ignored() {
    assert_accepted_and_ignored("{g}");
}

#[test]
fn obsolete_no_grid_directive_is_accepted_and_ignored() {
    assert_accepted_and_ignored("{no_grid}");
}

#[test]
fn obsolete_ng_directive_is_accepted_and_ignored() {
    assert_accepted_and_ignored("{ng}");
}

#[test]
fn deprecated_titles_directive_is_accepted_and_ignored() {
    assert_accepted_and_ignored("{titles: center}");
}

#[test]
fn unimplemented_pagesize_directive_is_accepted_and_ignored() {
    assert_accepted_and_ignored("{pagesize: a4}");
}
