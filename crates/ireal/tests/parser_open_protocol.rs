//! Integration tests for the open-protocol `irealbook://` URL
//! parser + serializer round-trip.
//!
//! Drives [`chordsketch_ireal::parse`] +
//! [`chordsketch_ireal::serialize_open_protocol`] against the literal
//! "A Walkin Thing" example from the public open-protocol spec at
//! <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>
//! and asserts:
//!
//! - the URL parses without error;
//! - the resulting AST matches a JSON golden snapshot;
//! - serializing the AST back through [`serialize_open_protocol`] and
//!   re-parsing produces an equivalent AST (the 6-field shape has no
//!   tempo / transpose slots, so those reset to defaults on
//!   re-parse — verified field-by-field).
//!
//! Snapshot regeneration:
//!
//! ```bash
//! UPDATE_GOLDEN=1 cargo test -p chordsketch-ireal --test parser_open_protocol
//! cargo test -p chordsketch-ireal --test parser_open_protocol  # confirm
//! ```
//!
//! Fixture layout mirrors `tests/fixtures/parser/<name>/`:
//!
//! - `url.txt` — the spec's literal `irealbook://` URL.
//! - `expected.json` — JSON snapshot of the parsed [`IrealSong`].

use chordsketch_ireal::{IrealSong, ToJson, parse, serialize_open_protocol};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("parser_open_protocol")
        .join(name)
}

fn read_url(name: &str) -> String {
    let path = fixture_dir(name).join("url.txt");
    let raw =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    raw.trim().to_owned()
}

fn assert_snapshot(name: &str, song: &IrealSong) {
    let actual = song.to_json_string();
    let expected_path = fixture_dir(name).join("expected.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        fs::write(&expected_path, &actual).expect("write expected.json");
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
        actual, expected,
        "AST drift for {name}; rerun with UPDATE_GOLDEN=1 to regenerate"
    );
}

#[test]
fn a_walkin_thing_parses_to_snapshot() {
    // Asserts that the spec's literal example parses to a stable AST.
    // Drift here means either the parser changed or the spec example
    // file was edited — both are intentional events that need an
    // UPDATE_GOLDEN refresh.
    let url = read_url("a_walkin_thing");
    let song = parse(&url).expect("parse spec example");
    assert_snapshot("a_walkin_thing", &song);
}

#[test]
fn a_walkin_thing_round_trips_through_open_protocol_serializer() {
    // The load-bearing property: every field the open-protocol shape
    // carries (title, composer, style, key, sections + bar grid) must
    // survive a parse → serialize_open_protocol → parse cycle without
    // semantic loss. Tempo / transpose are intentionally absent from
    // the 6-field protocol body, so the original spec example carries
    // neither and the equality holds trivially.
    let url = read_url("a_walkin_thing");
    let original = parse(&url).expect("parse spec example");

    let reserialized = serialize_open_protocol(&original);
    let round_tripped = parse(&reserialized).expect("re-parse serialized output");

    assert_eq!(
        original, round_tripped,
        "open-protocol round trip lost data"
    );
}
