//! Integration tests for the `irealb://` URL parser.
//!
//! Drives [`chordsketch_ireal::parse`] / [`parse_collection`]
//! against fixture URLs sourced from the
//! [`pianosnake/ireal-reader`][1] reference parser's test corpus
//! and asserts the resulting AST matches a JSON snapshot held under
//! `tests/fixtures/parser/<name>/expected.json`.
//!
//! Snapshot regeneration:
//!
//! ```bash
//! UPDATE_GOLDEN=1 cargo test -p chordsketch-ireal --test parser
//! cargo test -p chordsketch-ireal --test parser  # confirm round trip
//! ```
//!
//! Each fixture lives in its own directory:
//!
//! - `url.txt` — the percent-encoded `irealb://` URL.
//! - `expected.json` — JSON snapshot of the parsed `IrealSong[]`,
//!   one entry per song (single-song fixtures use a 1-element
//!   array). Generated via `IrealSong::to_json`; the deserialiser
//!   round-trips through `parse_json`.
//!
//! [1]: https://github.com/pianosnake/ireal-reader

use chordsketch_ireal::{ParseError, ToJson, parse, parse_collection};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("parser")
        .join(name)
}

fn run_collection_snapshot(name: &str) {
    let dir = fixture_dir(name);
    let url = fs::read_to_string(dir.join("url.txt"))
        .unwrap_or_else(|e| panic!("read {} url.txt: {}", name, e));
    let url = url.trim();

    let (songs, _name) =
        parse_collection(url).unwrap_or_else(|e| panic!("parse_collection {}: {}", name, e));

    // Serialize as a JSON array so multi-song fixtures fit the
    // same on-disk shape as single-song ones (one element).
    let mut buf = String::from("[");
    for (i, song) in songs.iter().enumerate() {
        if i > 0 {
            buf.push(',');
        }
        buf.push_str(&song.to_json_string());
    }
    buf.push(']');

    let expected_path = dir.join("expected.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        fs::write(&expected_path, &buf).expect("write expected.json");
        return;
    }
    let expected = fs::read_to_string(&expected_path).unwrap_or_else(|e| {
        panic!(
            "read {}; rerun with UPDATE_GOLDEN=1 to bootstrap: {}",
            expected_path.display(),
            e
        )
    });
    assert_eq!(
        buf, expected,
        "AST drift for {name}; rerun with UPDATE_GOLDEN=1 to regenerate"
    );
}

#[test]
fn parses_tiny() {
    run_collection_snapshot("tiny");
}

#[test]
fn parses_short() {
    run_collection_snapshot("short");
}

#[test]
fn parses_three_songs() {
    run_collection_snapshot("three_songs");
}

#[test]
fn parses_five_songs() {
    run_collection_snapshot("five_songs");
}

#[test]
fn parses_tester_corpus() {
    run_collection_snapshot("tester");
}

#[test]
fn three_songs_yields_three_results() {
    let url = fs::read_to_string(fixture_dir("three_songs").join("url.txt")).expect("read url");
    let url = url.trim();
    let (songs, name) = parse_collection(url).expect("parse");
    assert_eq!(songs.len(), 3);
    assert!(
        name.is_some(),
        "three-song fixture should expose a playlist name"
    );
}

#[test]
fn five_songs_fixture_yields_six_results() {
    // The fixture is named `fiveSongs` upstream but actually
    // carries 6 songs plus a trailing playlist name. We verify
    // the actual count rather than the upstream label so the
    // assertion catches a real regression.
    let url = fs::read_to_string(fixture_dir("five_songs").join("url.txt")).expect("read url");
    let url = url.trim();
    let (songs, name) = parse_collection(url).expect("parse");
    assert_eq!(songs.len(), 6);
    assert_eq!(name.as_deref(), Some("Small"));
}

#[test]
fn tester_corpus_yields_fourteen_songs() {
    // pianosnake's parser-spec asserts 14 songs in this corpus;
    // anything else means we miscounted the `===` separators.
    let url = fs::read_to_string(fixture_dir("tester").join("url.txt")).expect("read url");
    let url = url.trim();
    let (songs, _name) = parse_collection(url).expect("parse");
    assert_eq!(songs.len(), 14, "expected 14 songs in Tester.html corpus");
}

#[test]
fn parse_returns_first_song_of_collection() {
    let url = fs::read_to_string(fixture_dir("three_songs").join("url.txt")).expect("read url");
    let url = url.trim();
    let song = parse(url).expect("parse single");
    let (collection, _) = parse_collection(url).expect("parse collection");
    assert_eq!(song.title, collection[0].title);
}

#[test]
fn rejects_non_irealb_input() {
    let err = parse("https://example.com/").expect_err("must reject");
    assert!(matches!(err, ParseError::MissingPrefix));
}

#[test]
fn rejects_truncated_percent_escape() {
    let err = parse("irealb://body%4").expect_err("must reject");
    assert!(matches!(err, ParseError::InvalidPercentEscape));
}

#[test]
fn rejects_oversized_input() {
    let big = format!(
        "irealb://{}",
        "x".repeat(chordsketch_ireal::parser::MAX_INPUT_BYTES)
    );
    let err = parse(&big).expect_err("must reject");
    assert!(matches!(err, ParseError::InputTooLarge(_)));
}

#[test]
fn empty_body_errors() {
    let err = parse("irealb://").expect_err("must reject");
    assert!(matches!(
        err,
        ParseError::NoSongs | ParseError::MalformedBody(_)
    ));
}
