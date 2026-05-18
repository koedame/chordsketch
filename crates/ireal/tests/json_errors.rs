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
    Bar, BarChord, BarChordKind, BarLine, BeatGrouping, BeatPosition, Chord, ChordQuality,
    ChordRoot, ChordSize, Ending, FromJson, IrealSong, JsonError, JsonValue, MusicalSymbol,
    Section, SectionLabel, ToJson, parse_json,
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

#[test]
fn ending_untitled_to_json_emits_zero_sentinel() {
    // `Ending::Untitled` (spec `N0`) serialises as the sentinel
    // `0`, distinct from `null` ("no ending"). The previous
    // `Ending::new` API rejected `0`, so no pre-`Untitled`
    // fixture carries this byte sequence and the new value
    // cannot collide with existing snapshots.
    let mut buf = String::new();
    Ending::Untitled.to_json(&mut buf);
    assert_eq!(buf, "0");
}

#[test]
fn from_json_accepts_zero_as_untitled_sentinel() {
    // Positive coverage for the `n == 0 → Ending::Untitled`
    // deserializer arm. Without this assertion a future refactor
    // that swapped the branch (e.g. `if n == 1`) or removed the
    // sentinel would only be caught by the inverse `to_json`
    // assertion; this test locks the parse direction so the
    // round-trip stays symmetric.
    let json = r#"{"start":"single","end":"single","chords":[],"ending":0,"symbol":null}"#;
    let bar = Bar::from_json_str(json).expect("0 is the Untitled sentinel");
    assert_eq!(bar.ending, Some(Ending::Untitled));
}

#[test]
fn from_json_rejects_ending_out_of_u8_range() {
    // The deserializer routes the integer through `extract_u8`,
    // which must reject 256 (out of u8 range) rather than
    // silently truncating to 0 (which would alias Untitled).
    let json = r#"{"start":"single","end":"single","chords":[],"ending":256,"symbol":null}"#;
    let err = Bar::from_json_str(json).expect_err("256 must reject");
    assert!(
        err.message.to_lowercase().contains("u8") || err.message.to_lowercase().contains("range"),
        "error must point at the u8 range; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_ending_of_wrong_type() {
    // A non-integer value must be rejected by `as_int`'s Err arm
    // (the deserializer never coerces strings to integers).
    let json = r#"{"start":"single","end":"single","chords":[],"ending":"two","symbol":null}"#;
    let err = Bar::from_json_str(json).expect_err("string must reject");
    assert!(
        err.message.contains("integer"),
        "error must mention integer expectation; got {:?}",
        err.message
    );
}

#[test]
fn from_json_rejects_negative_ending() {
    // `extract_u8` rejects negative integers before they can be
    // truncated. Without this rejection a hand-edited debug JSON
    // could silently land on `Untitled` (via two's-complement
    // wrap to 0) or `Numbered(255)` (via wrap to -1 → 255).
    let json = r#"{"start":"single","end":"single","chords":[],"ending":-1,"symbol":null}"#;
    let err = Bar::from_json_str(json).expect_err("negative must reject");
    // `extract_u8` produces "integer -1 out of u8 range"; match on the
    // same terms as `from_json_rejects_ending_out_of_u8_range` so the
    // assertion proves it is the right error path, not merely that
    // *some* error was raised.
    assert!(
        err.message.to_lowercase().contains("u8") || err.message.to_lowercase().contains("range"),
        "error must point at the u8 range; got {:?}",
        err.message
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
            kind: BarChordKind::Played,
        }],
        ending: None,
        symbol: None,
        repeat_previous: false,
        no_chord: false,
        staff_texts: Vec::new(),
        system_break_space: 0,
        beat_grouping_override: None,
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
    assert!(bar.staff_texts.is_empty());
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
        staff_texts: Vec::new(),
        system_break_space: 2,
        beat_grouping_override: None,
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
        kind: BarChordKind::Played,
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
        kind: BarChordKind::Played,
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

/// Sister-test of `bar_chord_small_size_serialises_and_round_trips_through_json`
/// for the `kind` field (#2435). Verifies the additive-omit pattern:
/// default `Played` does NOT emit `"kind"`, non-default `SlashRepeat`
/// DOES, and the round-trip preserves the kind.
#[test]
fn bar_chord_slash_repeat_serialises_and_round_trips_through_json() {
    let snapshot = Chord::triad(ChordRoot::natural('C'), ChordQuality::Dominant7);
    let bc = BarChord::slash_repeat(
        snapshot.clone(),
        BeatPosition::on_beat(2).unwrap(),
        ChordSize::Default,
    );
    let json = bc.to_json_string();
    // The field must be present when non-default.
    assert!(
        json.contains("\"kind\":\"slash_repeat\""),
        "kind must appear as \"slash_repeat\" when SlashRepeat, got {json:?}"
    );
    // Played BarChords must NOT emit the field (snapshot-byte-stability).
    let played_bc = BarChord::played(
        snapshot,
        BeatPosition::on_beat(1).unwrap(),
        ChordSize::Default,
    );
    let played_json = played_bc.to_json_string();
    // Check both BarChordKind values are absent — a bare
    // `contains("\"kind\"")` collides with `ChordQuality`'s
    // own `"kind":` JSON tag, so look for the specific
    // value strings BarChord uses.
    assert!(
        !played_json.contains("\"kind\":\"played\""),
        "Played BarChord must NOT emit its kind field, got {played_json:?}"
    );
    assert!(
        !played_json.contains("\"kind\":\"slash_repeat\""),
        "Played BarChord must NOT emit slash_repeat, got {played_json:?}"
    );
    // Round-trip: deserialise back and check equality.
    let parsed = BarChord::from_json_str(&json).expect("deserialise");
    assert_eq!(parsed.kind, BarChordKind::SlashRepeat);
    assert_eq!(parsed, bc);
}

/// The `"played"` string in `BarChordKind::from_json_value` is never
/// emitted by the encoder (Played is the default and is omitted), but
/// it must still deserialise correctly for hand-crafted JSON consumers.
/// This test covers the `"played" => Ok(Self::Played)` arm that Codecov
/// marks uncovered because the omit-when-default policy prevents it from
/// being exercised by round-trip tests alone.
#[test]
fn bar_chord_kind_played_explicit_string_decodes() {
    let value = parse_json(r#""played""#).unwrap();
    let kind =
        BarChordKind::from_json_value(&value).expect("\"played\" must deserialise without error");
    assert_eq!(
        kind,
        BarChordKind::Played,
        "\"played\" must decode to Played"
    );
}

/// Unknown `kind` string must surface a `JsonError`. Covers the
/// `other => Err(...)` arm in `BarChordKind::from_json_value`.
#[test]
fn from_json_rejects_unknown_bar_chord_kind() {
    let value = parse_json(r#""mystery""#).unwrap();
    let result = BarChordKind::from_json_value(&value);
    assert!(
        result.is_err(),
        "unknown bar-chord kind must be rejected, got {result:?}"
    );
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

// ---- MusicalSymbol::Break JSON round-trip (#2448) ----------------------

/// `MusicalSymbol::Break` must serialise to the JSON string `"break"`
/// and deserialise back to `Break`. Covers:
/// - the `Self::Break => "break"` arm in `MusicalSymbol::to_json`,
/// - the `"break" => Ok(Self::Break)` arm in `MusicalSymbol::from_json_value`.
#[test]
fn musical_symbol_break_round_trips_through_json() {
    let json = MusicalSymbol::Break.to_json_string();
    assert_eq!(
        json, "\"break\"",
        "Break must serialise to the JSON string \"break\""
    );
    let parsed_json = parse_json(&json).expect("parse JSON");
    let result = MusicalSymbol::from_json_value(&parsed_json)
        .expect("Break must deserialise from \"break\"");
    assert_eq!(result, MusicalSymbol::Break);
}

// ---- BeatGrouping JSON round-trip (#2449) ---------------------------------

/// `beat_grouping_override` with a `[3, 2]` grouping must emit
/// `"beat_grouping_override":[3,2]` and deserialise back to the
/// same grouping. Covers:
/// - the `if let Some(grouping) = &self.beat_grouping_override` branch
///   in `Bar::to_json` (omitted when `None`, present when `Some`),
/// - `BeatGrouping::to_json` (the array serialiser),
/// - the `Some(v) => BeatGrouping::from_json_value(v)?` arm in
///   `Bar::from_json_value`.
#[test]
fn beat_grouping_override_some_serialises_and_round_trips_through_json() {
    use std::num::NonZeroU8;
    let grouping = BeatGrouping::new(vec![NonZeroU8::new(3).unwrap(), NonZeroU8::new(2).unwrap()])
        .expect("non-empty grouping");
    let bar = Bar {
        start: BarLine::Single,
        end: BarLine::Single,
        chords: vec![],
        ending: None,
        symbol: None,
        repeat_previous: false,
        no_chord: false,
        staff_texts: Vec::new(),
        system_break_space: 0,
        beat_grouping_override: Some(grouping),
    };
    let json = bar.to_json_string();
    // The field must be emitted when `Some`.
    assert!(
        json.contains("\"beat_grouping_override\""),
        "beat_grouping_override must appear in JSON when Some, got {json:?}"
    );
    assert!(
        json.contains("[3,2]"),
        "beat_grouping_override [3,2] must serialise to [3,2], got {json:?}"
    );
    // A `None` bar must NOT emit the field (snapshot-byte-stability).
    let none_bar = Bar::default();
    let none_json = none_bar.to_json_string();
    assert!(
        !none_json.contains("\"beat_grouping_override\""),
        "beat_grouping_override must be absent from JSON when None, got {none_json:?}"
    );
    // Round-trip: deserialise back and check the grouping.
    let parsed = Bar::from_json_str(&json).expect("deserialise");
    let g = parsed
        .beat_grouping_override
        .expect("beat_grouping_override must survive round-trip");
    assert_eq!(g.parts().len(), 2);
    assert_eq!(g.parts()[0].get(), 3);
    assert_eq!(g.parts()[1].get(), 2);
}

/// An empty `beat_grouping_override` array `[]` must be rejected —
/// a grouping with no subgroups is semantically undefined.
/// Covers the `BeatGrouping::new(parts).ok_or_else(…)` Err arm
/// in `BeatGrouping::from_json_value`.
#[test]
fn beat_grouping_override_empty_array_is_rejected() {
    let json = r#"{"start":"single","end":"single","chords":[],"ending":null,"symbol":null,"beat_grouping_override":[]}"#;
    let result = Bar::from_json_str(json);
    assert!(
        result.is_err(),
        "empty beat_grouping_override array must be rejected, got {result:?}"
    );
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.contains("subgroup") || msg.contains("beat_grouping"),
        "error must mention the field, got {msg:?}"
    );
}

/// A `beat_grouping_override` containing a zero subgroup `[0,3]`
/// must be rejected — zero-sized subgroups have no internal-feel
/// meaning. Covers the `NonZeroU8::new(n).ok_or_else(…)` Err arm
/// in `BeatGrouping::from_json_value`.
#[test]
fn beat_grouping_override_zero_subgroup_is_rejected() {
    let json = r#"{"start":"single","end":"single","chords":[],"ending":null,"symbol":null,"beat_grouping_override":[0,3]}"#;
    let result = Bar::from_json_str(json);
    assert!(
        result.is_err(),
        "zero subgroup in beat_grouping_override must be rejected, got {result:?}"
    );
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.contains("non-zero") || msg.contains("subgroup"),
        "error must mention the zero constraint, got {msg:?}"
    );
}

/// A `beat_grouping_override` containing a single subgroup `[5]`
/// must be rejected — a single-subgroup grouping is a no-op ("5
/// played as 5" is the default). Covers the `len() < 2` branch of
/// `BeatGrouping::new` reached via `BeatGrouping::from_json_value`.
/// This path is distinct from the empty-array case (`[]` → `len()
/// == 0`) even though both hit the same `len() < 2` guard; the
/// delta that introduced the `len() >= 2` requirement (#2449 fix)
/// adds `"5"` to the parser malformed-input test but leaves the
/// symmetric JSON path untested without this case.
#[test]
fn beat_grouping_override_single_subgroup_is_rejected() {
    let json = r#"{"start":"single","end":"single","chords":[],"ending":null,"symbol":null,"beat_grouping_override":[5]}"#;
    let result = Bar::from_json_str(json);
    assert!(
        result.is_err(),
        "single-subgroup beat_grouping_override [5] must be rejected, got {result:?}"
    );
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.contains("two") || msg.contains("subgroup"),
        "error must mention the two-subgroup requirement, got {msg:?}"
    );
}
