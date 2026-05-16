//! Error-path coverage for `chordsketch-ireal::json`.
//!
//! The happy paths are exercised by `tests/ast.rs` and `tests/parser.rs`.
//! This file targets the error variants and the rarely-touched
//! escape / truncation branches that account for the bulk of the
//! uncovered lines in `src/json.rs` (#2350).
//!
//! Tests that need to reach the AST extractor's "wrong JSON type"
//! arms construct minimal documents with one offending field — e.g.
//! `"title"` being an `Integer` to trigger
//! `JsonValue::as_str`'s Err arm.

use chordsketch_ireal::{
    Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, ChordSize, Ending,
    FromJson, IrealSong, JsonError, JsonValue, MusicalSymbol, Section, SectionLabel, ToJson,
    parse_json,
};

fn minimal_song_json_with(field: &str, value: &str) -> String {
    let mut s = String::from("{");
    let pairs = [
        ("title", "\"T\""),
        ("composer", "null"),
        ("style", "null"),
        (
            "key_signature",
            r#"{"root":{"note":"C","accidental":"natural"},"mode":"major"}"#,
        ),
        ("time_signature", r#"{"numerator":4,"denominator":4}"#),
        ("tempo", "null"),
        ("transpose", "0"),
        ("sections", "[]"),
    ];
    let mut first = true;
    for (k, v) in pairs {
        if !first {
            s.push(',');
        }
        first = false;
        let v = if k == field { value } else { v };
        s.push_str(&format!("\"{k}\":{v}"));
    }
    s.push('}');
    s
}

/// Constructs a song that round-trips so we can demonstrate the
/// serializer reaches every escape arm in `write_str` for control
/// characters embedded in `title`.
fn song_with_title(title: impl Into<String>) -> IrealSong {
    let mut s = IrealSong::new();
    s.title = title.into();
    s
}

// ---- write_str: rare escape sequences (\r, \b, \f, \u{0001}) -----------

#[test]
fn to_json_escapes_carriage_return() {
    let song = song_with_title("line1\rline2");
    let out = song.to_json_string();
    // Drives the `'\r' => "\\r"` arm of `write_str`.
    assert!(
        out.contains("\\r"),
        "carriage return must be escaped: {out}"
    );
}

#[test]
fn to_json_escapes_backspace_and_form_feed() {
    let song = song_with_title("a\x08b\x0cc");
    let out = song.to_json_string();
    // Drives the `'\x08' => "\\b"` and `'\x0c' => "\\f"` arms.
    assert!(out.contains("\\b"), "backspace must be escaped: {out}");
    assert!(out.contains("\\f"), "form feed must be escaped: {out}");
}

#[test]
fn to_json_escapes_other_c0_controls_as_unicode() {
    let song = song_with_title("\x01\x1f");
    let out = song.to_json_string();
    // U+0001 / U+001F are C0 controls without a named escape; they must
    // round-trip via the `\u{XXXX}` fallback path in `write_str`.
    assert!(out.contains("\\u0001"), "U+0001 must be escaped: {out}");
    assert!(out.contains("\\u001f"), "U+001F must be escaped: {out}");
}

// ---- Ending::to_json (a rare AST arm not hit by the round-trip suite) --

#[test]
fn ending_to_json_emits_decimal_number() {
    // Use a real Bar carrying an Ending so the Bar serializer drives
    // `Ending::to_json` (the trait method is not directly callable
    // from outside without `ToJson` in scope, which we have).
    let mut buf = String::new();
    Ending::new(2)
        .expect("Ending::new(2) is in range")
        .to_json(&mut buf);
    assert_eq!(
        buf, "2",
        "Ending serialises as a bare integer (matches the parser shape)"
    );
}

// ---- JsonError::Display::fmt -------------------------------------------

#[test]
fn json_error_display_includes_position_and_message() {
    let err = parse_json("not json").expect_err("expected parse failure");
    let formatted = format!("{err}");
    assert!(
        formatted.contains("at byte"),
        "Display impl must include byte offset; got {formatted:?}"
    );
}

// ---- parse_json malformed inputs ---------------------------------------

#[test]
fn parse_json_rejects_trailing_content_after_top_level() {
    let err = parse_json("[]extra").expect_err("trailing bytes must error");
    assert!(
        err.message.to_lowercase().contains("trailing"),
        "error must mention trailing content; got {:?}",
        err.message
    );
}

#[test]
fn parse_json_rejects_unexpected_byte_at_value_start() {
    let err = parse_json("@").expect_err("@ is not a JSON value start");
    assert!(
        err.message.to_lowercase().contains("unexpected"),
        "error must name the unexpected byte; got {:?}",
        err.message
    );
}

#[test]
fn parse_json_rejects_eof_at_value_start() {
    let err = parse_json("").expect_err("empty input is not a JSON value");
    assert!(err.message.to_lowercase().contains("end of input"));
}

#[test]
fn parse_json_rejects_malformed_null() {
    let err = parse_json("nul").expect_err("`nul` is not `null`");
    assert!(err.message.contains("null"));
}

#[test]
fn parse_json_rejects_lone_minus() {
    // `-` without digits hits the `expected digit` branch.
    let err = parse_json("-").expect_err("lone `-` is not an integer");
    assert!(err.message.to_lowercase().contains("digit"));
}

#[test]
fn parse_json_rejects_unterminated_string() {
    let err = parse_json("\"unterminated").expect_err("unterminated string must error");
    let msg = err.message.to_lowercase();
    assert!(
        msg.contains("unterminated") || msg.contains("end of input"),
        "error must indicate unterminated string; got {:?}",
        err.message
    );
}

#[test]
fn parse_json_rejects_invalid_escape() {
    let err = parse_json(r#""\q""#).expect_err("`\\q` is not a recognised escape");
    assert!(
        err.message.contains("escape") || err.message.contains("\\q"),
        "error must mention escape sequence; got {:?}",
        err.message
    );
}

#[test]
fn parse_json_rejects_object_with_duplicate_key() {
    let err = parse_json(r#"{"a":1,"a":2}"#).expect_err("duplicate keys must be rejected");
    assert!(
        err.message.to_lowercase().contains("duplicate"),
        "error must mention duplicate keys; got {:?}",
        err.message
    );
}

#[test]
fn parse_json_rejects_unterminated_array() {
    let err = parse_json("[1,2").expect_err("unterminated array must error");
    assert!(
        err.message.to_lowercase().contains("unterminated array"),
        "error must name the unterminated array; got {:?}",
        err.message
    );
}

#[test]
fn parse_json_rejects_unterminated_object() {
    let err = parse_json(r#"{"a":1"#).expect_err("unterminated object must error");
    assert!(
        err.message.to_lowercase().contains("unterminated object"),
        "error must name the unterminated object; got {:?}",
        err.message
    );
}

// ---- FromJson type-mismatch paths exercise JsonValue::as_* error arms --

#[test]
fn from_json_rejects_title_of_wrong_type() {
    // Title is required to be a string; passing 42 hits
    // `JsonValue::as_str`'s Err arm.
    let json = minimal_song_json_with("title", "42");
    let err = IrealSong::from_json_str(&json).expect_err("title must be a string");
    assert!(
        err.message.contains("string"),
        "error must point at the string type; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_sections_of_wrong_type() {
    let json = minimal_song_json_with("sections", "\"not an array\"");
    let err = IrealSong::from_json_str(&json).expect_err("sections must be an array");
    assert!(
        err.message.contains("array"),
        "error must point at the array type; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_time_signature_numerator_of_wrong_type() {
    // Hits `JsonValue::as_int`'s Err arm via the time_signature parser.
    let json = minimal_song_json_with("time_signature", r#"{"numerator":"four","denominator":4}"#);
    let err = IrealSong::from_json_str(&json).expect_err("numerator must be integer");
    assert!(
        err.message.contains("integer"),
        "error must mention integer expectation; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_composer_of_wrong_type() {
    // Composer is `Option<String>`; passing an integer hits
    // `JsonValue::as_opt_str`'s Err arm (neither Null nor String).
    let json = minimal_song_json_with("composer", "42");
    let err = IrealSong::from_json_str(&json).expect_err("composer must be string-or-null");
    assert!(
        err.message.contains("string"),
        "error must mention string-or-null; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_tempo_of_wrong_type() {
    // Tempo is `Option<u16>`; passing a string hits `as_opt_int`'s Err.
    let json = minimal_song_json_with("tempo", "\"fast\"");
    let err = IrealSong::from_json_str(&json).expect_err("tempo must be integer-or-null");
    assert!(
        err.message.contains("integer"),
        "error must mention integer-or-null; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_top_level_non_object() {
    // The deserializer expects an object at the top level — passing an
    // array hits the `expected object for ...` arm of `JsonValue::get`.
    let err = IrealSong::from_json_str("[]").expect_err("top-level array must error");
    assert!(
        err.message.contains("expected object") || err.message.contains("missing field"),
        "error must indicate object-shape mismatch; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_transpose_out_of_range() {
    // transpose has a documented range of [-11, 11].
    let json = minimal_song_json_with("transpose", "100");
    let err = IrealSong::from_json_str(&json).expect_err("transpose out of range must error");
    assert!(
        err.message.contains("transpose"),
        "error must name the transpose field; got {:?}",
        err.message
    );
}

// ---- enum variant validation -------------------------------------------

#[test]
fn from_json_rejects_unknown_chord_root_letter() {
    // ChordRoot::from_json_value must reject objects whose `note` is
    // not one of the canonical seven uppercase letters.
    let json = parse_json(r#"{"note":"H","accidental":"natural"}"#).unwrap();
    let result = ChordRoot::from_json_value(&json);
    assert!(result.is_err(), "H is not a valid chord root letter");
}

#[test]
fn from_json_rejects_unknown_section_label_string() {
    // SectionLabel from a single-letter string — Z is outside A..=Z
    // valid letters? Let's try a clearly invalid shape: a number.
    let json = parse_json("42").unwrap();
    let result = SectionLabel::from_json_value(&json);
    assert!(result.is_err());
}

#[test]
fn from_json_rejects_unknown_bar_line_kind() {
    let json = parse_json(r#""triple""#).unwrap();
    let result = BarLine::from_json_value(&json);
    assert!(result.is_err(), "triple is not a valid bar line kind");
}

#[test]
fn from_json_rejects_unknown_chord_quality() {
    // ChordQuality serialises as `{"kind":"<variant>"}`. Drive the
    // unknown-variant arm by submitting a syntactically valid object
    // with a bogus `kind`.
    let json = parse_json(r#"{"kind":"no-such-quality"}"#).unwrap();
    let result = ChordQuality::from_json_value(&json);
    assert!(result.is_err());
}

#[test]
fn from_json_rejects_unknown_musical_symbol() {
    let json = parse_json(r#""bogus""#).unwrap();
    let result = MusicalSymbol::from_json_value(&json);
    assert!(result.is_err());
}

// ---- JsonValue is sensitive to numeric range ---------------------------

#[test]
fn parse_json_rejects_integer_overflow() {
    // A value larger than i64::MAX must fail rather than silently
    // saturate. The parser reports `i64::FromStr` failures verbatim
    // through the "integer parse:" prefix so the byte position points
    // at the offending token.
    let huge = format!("{}0", i64::MAX);
    let err = parse_json(&huge).expect_err("> i64::MAX must error");
    assert!(
        err.message.contains("integer parse"),
        "overflow error must carry the `integer parse` prefix; got {:?}",
        err.message
    );
}

// ---- truncate_for_message escape branches ------------------------------

#[test]
fn unknown_quality_error_quotes_offending_value_with_escapes() {
    // Drives `truncate_for_message`'s `"` and `\\` escape arms when
    // present in the offending string. ChordQuality::from_json_value
    // surfaces the offending `kind` string verbatim through this
    // helper.
    let json = parse_json(r#"{"kind":"quote-\"-bs-\\-end"}"#).unwrap();
    let err = ChordQuality::from_json_value(&json).expect_err("unknown quality");
    let msg = err.message.clone();
    // The escaped quote / backslash must appear escaped in the error
    // message — this is the truncate_for_message contract.
    assert!(
        msg.contains("\\\"") || msg.contains("\\\\"),
        "error must surface the escaped offending value; got {msg:?}"
    );
}

// ---- Smoke: a full IrealSong with every enum exercised round-trips -----

#[test]
fn full_song_round_trips_through_deserializer() {
    let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Major);
    let bar = Bar {
        start: BarLine::Single,
        end: BarLine::Single,
        chords: vec![BarChord {
            chord,
            position: BeatPosition::on_beat(1).unwrap(),
            size: ChordSize::Default,
        }],
        ending: None,
        symbol: None,
        repeat_previous: false,
        no_chord: false,
        text_comment: None,
        system_break_space: 0,
    };
    let mut song = IrealSong::new();
    song.title = "T".to_string();
    song.sections = vec![Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    }];
    let json = song.to_json_string();
    let parsed = IrealSong::from_json_str(&json).expect("round-trip must succeed");
    assert_eq!(parsed, song);

    // Cross-check `parse_json` exposes the top-level value as an
    // `Object` (sanity test for the JsonValue enum being public).
    let value = parse_json(&json).unwrap();
    assert!(
        matches!(value, JsonValue::Object(_)),
        "top-level value must be an Object"
    );

    // Sanity guard for the public JsonError type — constructed
    // implicitly above on the success path; assert the type is
    // re-exported so consumers of this crate have a stable error
    // type to match against.
    let _: JsonError = IrealSong::from_json_str("bogus").unwrap_err();
}

#[test]
fn parse_json_rejects_partial_true_literal() {
    // `tru` (truncated `true`) — no boundary between literal and
    // EOF, but the partial-match path must still error rather than
    // silently accepting any prefix.
    assert!(parse_json("tru").is_err());
}

#[test]
fn parse_json_rejects_partial_false_literal() {
    assert!(parse_json("fals").is_err());
}

#[test]
fn parse_json_accepts_bool_literals() {
    // True / false at the document root must round-trip via
    // `JsonValue::Bool(_)`.
    match parse_json("true").expect("parse") {
        JsonValue::Bool(b) => assert!(b),
        other => panic!("expected Bool(true), got {other:?}"),
    }
    match parse_json("false").expect("parse") {
        JsonValue::Bool(b) => assert!(!b),
        other => panic!("expected Bool(false), got {other:?}"),
    }
}

#[test]
fn from_json_bar_without_repeat_previous_defaults_false() {
    // The serializer omits `repeat_previous` when false; the
    // deserializer must accept the missing-field shape and
    // default to `false`. Locks the invariant so a future
    // tightening (require the field) is a deliberate API break.
    let json = r#"{"start":"single","end":"single","chords":[],"ending":null,"symbol":null}"#;
    let bar = Bar::from_json_str(json).expect("parse");
    assert!(!bar.repeat_previous);
    assert!(!bar.no_chord);
    assert!(bar.text_comment.is_none());
}

#[test]
fn from_json_chord_alternate_null_round_trips_to_none() {
    // Explicit `null` and the missing-field shape must both decode
    // to `Chord::alternate = None`.
    let with_null = r#"{
        "root":{"note":"C","accidental":"natural"},
        "quality":{"kind":"major"},
        "bass":null,
        "alternate":null
    }"#;
    let without = r#"{
        "root":{"note":"C","accidental":"natural"},
        "quality":{"kind":"major"},
        "bass":null
    }"#;
    let a = Chord::from_json_str(with_null).expect("parse explicit null");
    let b = Chord::from_json_str(without).expect("parse missing");
    assert!(a.alternate.is_none());
    assert!(b.alternate.is_none());
    assert_eq!(a, b);
}

#[test]
fn from_json_section_label_removed_kinds_are_rejected() {
    // `chorus` / `bridge` / `outro` were removed from
    // `SectionLabel` per #2450 because the iReal Pro app does not
    // emit them. JSON inputs that still reference these kinds
    // (e.g. snapshots produced by older parser versions) must
    // surface as a clear `unknown section label kind` error
    // rather than silently degrade.
    use chordsketch_ireal::SectionLabel;
    for kind in ["chorus", "bridge", "outro"] {
        let json = format!("{{\"kind\":\"{kind}\"}}");
        let result = SectionLabel::from_json_str(&json);
        assert!(
            result.is_err(),
            "kind {kind:?} must be rejected after #2450, got {result:?}"
        );
    }
}

#[test]
fn from_json_section_label_surviving_kinds_decode() {
    use chordsketch_ireal::SectionLabel;
    assert_eq!(
        SectionLabel::from_json_str(r#"{"kind":"verse"}"#).unwrap(),
        SectionLabel::Verse,
    );
    assert_eq!(
        SectionLabel::from_json_str(r#"{"kind":"intro"}"#).unwrap(),
        SectionLabel::Intro,
    );
    assert_eq!(
        SectionLabel::from_json_str(r#"{"kind":"letter","value":"A"}"#).unwrap(),
        SectionLabel::Letter('A'),
    );
    assert_eq!(
        SectionLabel::from_json_str(r#"{"kind":"custom","value":"Chorus"}"#).unwrap(),
        SectionLabel::Custom("Chorus".into()),
    );
}

#[test]
fn from_json_chord_alternate_present_round_trips() {
    // Nested alternate decodes recursively. One-level nesting
    // (which is what the parser produces from `(altchord)`) is
    // the load-bearing case.
    let json = r#"{
        "root":{"note":"E","accidental":"natural"},
        "quality":{"kind":"minor7"},
        "bass":null,
        "alternate":{
            "root":{"note":"E","accidental":"natural"},
            "quality":{"kind":"custom","value":"7#9"},
            "bass":null
        }
    }"#;
    let chord = Chord::from_json_str(json).expect("parse");
    let alt = chord.alternate.as_ref().expect("alternate present");
    assert_eq!(alt.root.note, 'E');
    assert!(matches!(&alt.quality, ChordQuality::Custom(s) if s == "7#9"));
}

// ---- system_break_space JSON round-trip coverage (#2434) ---------------

/// A bar with `system_break_space = 2` must serialise to JSON
/// (emitting the field because it is > 0) and deserialise back with
/// the same value. Covers the `if self.system_break_space > 0 { … }`
/// branch in `ToJson` and the `Some(other)` arm in `FromJson`.
#[test]
fn bar_system_break_space_nonzero_round_trips_through_json() {
    let bar = Bar {
        start: BarLine::Single,
        end: BarLine::Single,
        chords: vec![],
        ending: None,
        symbol: None,
        repeat_previous: false,
        no_chord: false,
        text_comment: None,
        system_break_space: 2,
    };
    let json = bar.to_json_string();
    // The field must be emitted when non-zero.
    assert!(
        json.contains("\"system_break_space\""),
        "system_break_space must appear in JSON when non-zero, got {json:?}"
    );
    let parsed = Bar::from_json_str(&json).expect("deserialise");
    assert_eq!(parsed.system_break_space, 2);
}

/// `system_break_space` values > 3 are out of range; `FromJson` must
/// return a `JsonError` rather than silently clamping. Covers the
/// `if n > 3 { return Err(…) }` branch in `FromJson`.
#[test]
fn bar_system_break_space_out_of_range_is_rejected() {
    let json = r#"{"start":"single","end":"single","chords":[],"ending":null,"symbol":null,"system_break_space":4}"#;
    let result = Bar::from_json_str(json);
    assert!(
        result.is_err(),
        "system_break_space 4 must be rejected (out of range [0, 3])"
    );
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.contains("system_break_space") && msg.contains("range"),
        "error message must mention the field and the range violation, got {msg:?}"
    );
}

// ---- ChordSize::Small JSON round-trip (#2433) --------------------------

/// `BarChord` with `ChordSize::Small` must emit `"size":"small"` and
/// round-trip back through `from_json_value`. Covers:
/// - the conditional `if self.size != ChordSize::Default` branch in
///   `BarChord::to_json` (normally `Default` is not emitted),
/// - the `ChordSize::Small` arm in `ChordSize::to_json`,
/// - the `Some(v) => ChordSize::from_json_value(v)?` arm in
///   `BarChord::from_json_value`.
#[test]
fn bar_chord_small_size_serialises_and_round_trips_through_json() {
    let bc = BarChord {
        chord: Chord::triad(ChordRoot::natural('D'), ChordQuality::Minor7),
        position: BeatPosition::on_beat(1).unwrap(),
        size: ChordSize::Small,
    };
    let json = bc.to_json_string();
    // The field must be present when non-default.
    assert!(
        json.contains("\"size\":\"small\""),
        "size must appear as \"small\" when ChordSize::Small, got {json:?}"
    );
    // Default-size chords must NOT emit the field (snapshot-byte-stability).
    let default_bc = BarChord {
        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
        position: BeatPosition::on_beat(1).unwrap(),
        size: ChordSize::Default,
    };
    let default_json = default_bc.to_json_string();
    assert!(
        !default_json.contains("\"size\""),
        "Default-size chord must NOT emit size field, got {default_json:?}"
    );
    // Round-trip: deserialise back and check equality.
    let parsed = BarChord::from_json_str(&json).expect("deserialise");
    assert_eq!(parsed.size, ChordSize::Small);
    assert_eq!(parsed, bc);
}

/// Explicit `"size":"default"` must deserialise to `ChordSize::Default`.
/// Covers the `"default"` arm of `ChordSize::from_json_value` (distinct
/// from the missing-field path, which goes through `None` in
/// `BarChord::from_json_value`).
#[test]
fn chord_size_explicit_default_decodes_to_default() {
    let value = parse_json(r#""default""#).unwrap();
    let size = ChordSize::from_json_value(&value).expect("decode");
    assert_eq!(size, ChordSize::Default);
}

/// Unknown chord-size string must surface a `JsonError`.
/// Covers the `other => Err(...)` arm in `ChordSize::from_json_value`.
#[test]
fn from_json_rejects_unknown_chord_size() {
    let value = parse_json(r#""jumbo""#).unwrap();
    let result = ChordSize::from_json_value(&value);
    assert!(
        result.is_err(),
        "unknown chord size must be rejected, got {result:?}"
    );
    let msg = result.unwrap_err().message;
    assert!(
        msg.contains("chord size") || msg.contains("jumbo"),
        "error must mention the offending value; got {msg:?}"
    );
}
