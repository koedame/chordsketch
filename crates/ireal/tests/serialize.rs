//! Round-trip property tests for the `irealb_serialize`
//! function.
//!
//! The acceptance criterion for #2052 is:
//!
//! > parse(serialize(parse(url))) == parse(url)
//!
//! for every fixture URL the parser already handles. This file
//! drives every URL under `tests/fixtures/parser/<name>/url.txt`
//! through that round trip and asserts the resulting AST is
//! byte-identical (via the JSON serializer in `crate::json`) to
//! the AST produced by the first `parse`.

use chordsketch_ireal::{
    IrealSong, ToJson, irealb_serialize, irealbook_serialize, parse, parse_collection,
};
use std::fs;
use std::path::Path;

fn fixture_url(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("parser")
        .join(name)
        .join("url.txt");
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
        .trim()
        .to_owned()
}

fn ast_json_array(songs: &[IrealSong]) -> String {
    let mut s = String::from("[");
    for (i, song) in songs.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&song.to_json_string());
    }
    s.push(']');
    s
}

fn round_trip_collection(name: &str) {
    let url1 = fixture_url(name);
    let (ast1, name1) = parse_collection(&url1).expect("first parse");
    let url2 = irealbook_serialize(&ast1, name1.as_deref());
    let (ast2, name2) = parse_collection(&url2).expect("second parse");
    let json1 = ast_json_array(&ast1);
    let json2 = ast_json_array(&ast2);
    assert_eq!(
        json1, json2,
        "AST drift across serialize round trip for {name}; \
         the serializer is not the inverse of the parser for this fixture",
    );
    assert_eq!(name1, name2, "playlist name drifted for {name}");
}

#[test]
fn round_trip_tiny() {
    round_trip_collection("tiny");
}

#[test]
fn round_trip_short() {
    round_trip_collection("short");
}

#[test]
fn round_trip_three_songs() {
    round_trip_collection("three_songs");
}

#[test]
fn round_trip_five_songs() {
    round_trip_collection("five_songs");
}

#[test]
fn round_trip_tester_corpus() {
    round_trip_collection("tester");
}

#[test]
fn single_song_url_starts_with_irealb_prefix() {
    let url1 = fixture_url("tiny");
    let song = parse(&url1).expect("parse first");
    let url2 = irealb_serialize(&song);
    assert!(url2.starts_with("irealb://"));
    let song2 = parse(&url2).expect("parse round trip");
    assert_eq!(song.to_json_string(), song2.to_json_string());
}

#[test]
fn collection_serializer_uses_irealbook_prefix() {
    let url1 = fixture_url("three_songs");
    let (songs, name) = parse_collection(&url1).expect("parse first");
    let url2 = irealbook_serialize(&songs, name.as_deref());
    assert!(
        url2.starts_with("irealbook://"),
        "collection serializer must use the irealbook:// prefix"
    );
}

#[test]
fn empty_collection_with_only_playlist_name_handles_no_songs() {
    // The serializer permits an empty song slice; the emitted URL
    // contains the playlist name only and is not parseable
    // (parse_collection requires at least one non-empty song
    // segment), but constructing it must not panic.
    let url = irealbook_serialize(&[], Some("Playlist"));
    assert!(url.starts_with("irealbook://"));
}
