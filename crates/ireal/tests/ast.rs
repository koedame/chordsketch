//! Unit tests for AST constructors and equality.
//!
//! Per #2055 AC, the scaffold ships with coverage that exercises the
//! `new()` / `default()` / `triad()` / `natural()` / `on_beat()` /
//! `Ending::new()` / `TimeSignature::new()` constructors, asserts
//! that two AST trees built from equal inputs compare `Eq`, and that
//! the JSON debug output is byte-stable for a known input.

use chordsketch_ireal::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, Ending,
    FromJson, IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel,
    TimeSignature, ToJson,
};

#[test]
fn empty_song_defaults() {
    let song = IrealSong::new();
    assert_eq!(song.title, "");
    assert!(song.composer.is_none());
    assert!(song.style.is_none());
    assert_eq!(song.key_signature, KeySignature::default());
    assert_eq!(song.time_signature, TimeSignature::default());
    assert!(song.tempo.is_none());
    assert_eq!(song.transpose, 0);
    assert!(song.sections.is_empty());
}

#[test]
fn default_key_is_c_major() {
    let key = KeySignature::default();
    assert_eq!(key.root, ChordRoot::natural('C'));
    assert_eq!(key.mode, KeyMode::Major);
}

#[test]
fn default_time_is_four_four() {
    let ts = TimeSignature::default();
    assert_eq!(ts.numerator, 4);
    assert_eq!(ts.denominator, 4);
}

#[test]
fn time_signature_rejects_invalid_inputs() {
    assert!(TimeSignature::new(0, 4).is_none());
    assert!(TimeSignature::new(13, 4).is_none());
    assert!(TimeSignature::new(4, 1).is_none());
    assert!(TimeSignature::new(4, 16).is_none());
    assert!(TimeSignature::new(4, 0).is_none());
    assert_eq!(TimeSignature::new(3, 4).unwrap().numerator, 3);
    assert_eq!(TimeSignature::new(6, 8).unwrap().denominator, 8);
    assert_eq!(TimeSignature::new(2, 2).unwrap().numerator, 2);
}

#[test]
fn ending_rejects_zero() {
    assert!(Ending::new(0).is_none());
    assert_eq!(Ending::new(1).unwrap().number(), 1);
    assert_eq!(Ending::new(2).unwrap().number(), 2);
    assert_eq!(Ending::new(255).unwrap().number(), 255);
}

#[test]
fn beat_position_rejects_zero() {
    assert!(BeatPosition::on_beat(0).is_none());
    let p = BeatPosition::on_beat(2).unwrap();
    assert_eq!(p.beat.get(), 2);
    assert_eq!(p.subdivision, 0);
}

#[test]
fn chord_triad_has_no_bass() {
    let chord = Chord::triad(ChordRoot::natural('G'), ChordQuality::Major);
    assert_eq!(chord.root.note, 'G');
    assert_eq!(chord.root.accidental, Accidental::Natural);
    assert!(chord.bass.is_none());
    assert_eq!(chord.quality, ChordQuality::Major);
}

#[test]
fn bar_default_has_single_barlines() {
    let bar = Bar::new();
    assert_eq!(bar.start, BarLine::Single);
    assert_eq!(bar.end, BarLine::Single);
    assert!(bar.chords.is_empty());
    assert!(bar.ending.is_none());
    assert!(bar.symbol.is_none());
}

#[test]
fn equality_is_structural() {
    // Two ASTs built from the same data compare equal. This is the
    // load-bearing property for golden tests in the follow-up
    // crates (#2052 / #2054 / #2058).
    let a = make_sample();
    let b = make_sample();
    assert_eq!(a, b);
}

#[test]
fn equality_distinguishes_chord_changes() {
    // Same input except the bass note differs — must compare unequal.
    let mut a = make_sample();
    let mut b = make_sample();
    if let Some(section) = b.sections.get_mut(0) {
        if let Some(bar) = section.bars.get_mut(0) {
            if let Some(bc) = bar.chords.get_mut(0) {
                bc.chord.bass = Some(ChordRoot::natural('G'));
            }
        }
    }
    assert_eq!(
        a.sections[0].bars[0].chords[0].chord.bass, None,
        "fixture invariant: original sample has no bass"
    );
    assert_ne!(a, b);
    a.sections[0].bars[0].chords[0].chord.bass = Some(ChordRoot::natural('G'));
    assert_eq!(a, b);
}

#[test]
fn section_label_variants_are_distinct() {
    assert_ne!(SectionLabel::Letter('A'), SectionLabel::Verse);
    assert_ne!(SectionLabel::Verse, SectionLabel::Chorus);
    assert_ne!(
        SectionLabel::Custom("Pre-chorus".into()),
        SectionLabel::Custom("Bridge 2".into())
    );
    assert_eq!(SectionLabel::Letter('B'), SectionLabel::Letter('B'));
}

#[test]
fn json_serialization_is_byte_stable() {
    // Byte-stable JSON debug output is what golden-snapshot tests
    // in the follow-up crates rely on. If this assertion changes,
    // the field-order documentation in `ARCHITECTURE.md` and the
    // module-level `json.rs` doc comment both need a refresh.
    let song = make_sample();
    let json = song.to_json_string();
    let expected = "{\
        \"title\":\"Autumn Leaves\",\
        \"composer\":\"Joseph Kosma\",\
        \"style\":\"Medium Swing\",\
        \"key_signature\":{\"root\":{\"note\":\"E\",\"accidental\":\"natural\"},\"mode\":\"minor\"},\
        \"time_signature\":{\"numerator\":4,\"denominator\":4},\
        \"tempo\":120,\
        \"transpose\":0,\
        \"sections\":[\
            {\
                \"label\":{\"kind\":\"letter\",\"value\":\"A\"},\
                \"bars\":[\
                    {\
                        \"start\":\"open_repeat\",\
                        \"end\":\"close_repeat\",\
                        \"chords\":[\
                            {\"chord\":{\"root\":{\"note\":\"C\",\"accidental\":\"natural\"},\"quality\":{\"kind\":\"minor7\"},\"bass\":null},\"position\":{\"beat\":1,\"subdivision\":0}}\
                        ],\
                        \"ending\":1,\
                        \"symbol\":\"segno\"\
                    }\
                ]\
            }\
        ]\
    }";
    assert_eq!(json, expected);
}

#[test]
fn json_round_trips_through_deserializer() {
    // The serializer + deserializer are AC-required to round-trip an
    // arbitrary AST. Asserting `parsed == original` catches every
    // class of mismatch in one assertion: missing fields, wrong
    // variants, incorrect numeric handling, lost optional `None`s.
    let song = make_sample();
    let json = song.to_json_string();
    let parsed = IrealSong::from_json_str(&json).expect("round-trip parse must succeed");
    assert_eq!(song, parsed);
}

#[test]
fn json_round_trip_handles_every_enum_variant() {
    // Walk every named enum variant once — variants that only fail to
    // round-trip in isolation (e.g. a missing `from_json` arm) would
    // otherwise hide behind whichever variant `make_sample` happens
    // to use.
    let mut song = IrealSong::new();
    song.title = "Variants".into();
    song.composer = None;
    song.key_signature = KeySignature {
        root: ChordRoot {
            note: 'F',
            accidental: Accidental::Sharp,
        },
        mode: KeyMode::Minor,
    };
    song.time_signature = TimeSignature::new(6, 8).unwrap();
    song.tempo = Some(90);
    song.transpose = -3;
    let qualities = [
        ChordQuality::Major,
        ChordQuality::Minor,
        ChordQuality::Diminished,
        ChordQuality::Augmented,
        ChordQuality::Major7,
        ChordQuality::Minor7,
        ChordQuality::Dominant7,
        ChordQuality::HalfDiminished,
        ChordQuality::Diminished7,
        ChordQuality::Suspended2,
        ChordQuality::Suspended4,
        ChordQuality::Custom("7\u{266F}9".into()),
    ];
    let labels = [
        SectionLabel::Letter('A'),
        SectionLabel::Verse,
        SectionLabel::Chorus,
        SectionLabel::Intro,
        SectionLabel::Outro,
        SectionLabel::Bridge,
        SectionLabel::Custom("Pre-chorus".into()),
    ];
    let symbols = [
        MusicalSymbol::Segno,
        MusicalSymbol::Coda,
        MusicalSymbol::DaCapo,
        MusicalSymbol::DalSegno,
        MusicalSymbol::Fine,
    ];
    let barlines = [
        BarLine::Single,
        BarLine::Double,
        BarLine::Final,
        BarLine::OpenRepeat,
        BarLine::CloseRepeat,
    ];
    for (i, quality) in qualities.iter().enumerate() {
        let label = labels[i % labels.len()].clone();
        let symbol = symbols[i % symbols.len()];
        let start = barlines[i % barlines.len()];
        let end = barlines[(i + 1) % barlines.len()];
        let bar = Bar {
            start,
            end,
            chords: vec![BarChord {
                chord: Chord {
                    root: ChordRoot::natural('A'),
                    quality: quality.clone(),
                    bass: Some(ChordRoot {
                        note: 'D',
                        accidental: Accidental::Flat,
                    }),
                    alternate: None,
                },
                position: BeatPosition::on_beat(u8::try_from(i % 4 + 1).unwrap()).unwrap(),
            }],
            ending: Ending::new(u8::try_from(i % 3 + 1).unwrap()),
            symbol: Some(symbol),
            repeat_previous: false,
            no_chord: false,
            text_comment: None,
        };
        song.sections.push(Section {
            label,
            bars: vec![bar],
        });
    }
    let json = song.to_json_string();
    let parsed = IrealSong::from_json_str(&json).expect("variant round-trip must succeed");
    assert_eq!(song, parsed);
}

#[test]
fn json_rejects_malformed_input() {
    // The parser is intentionally strict — these are the failure
    // shapes a hand-written debug snapshot is most likely to drift
    // into. The deserializer is round-trip-only and rejecting drift
    // is the load-bearing property.
    assert!(IrealSong::from_json_str("").is_err());
    assert!(IrealSong::from_json_str("{").is_err());
    assert!(IrealSong::from_json_str("{}").is_err()); // missing fields
    assert!(IrealSong::from_json_str("null").is_err()); // wrong shape
    let bad_trailing_comma = "{\"title\":\"x\",}";
    assert!(IrealSong::from_json_str(bad_trailing_comma).is_err());
}

#[test]
fn json_escapes_special_characters() {
    let mut song = IrealSong::new();
    song.title = String::from("a\"b\\c\nd\te\x01f");
    let json = song.to_json_string();
    // Title field encodes the four standard escapes plus a ``
    // for the C0 control. The rest of the song is left at defaults.
    assert!(
        json.contains("\"title\":\"a\\\"b\\\\c\\nd\\te\\u0001f\""),
        "unexpected title encoding: {json}"
    );
    let parsed = IrealSong::from_json_str(&json).expect("escape round-trip must succeed");
    assert_eq!(parsed.title, song.title);
}

#[test]
fn musical_symbol_variants_are_distinct() {
    assert_ne!(MusicalSymbol::Segno, MusicalSymbol::Coda);
    assert_ne!(MusicalSymbol::DaCapo, MusicalSymbol::DalSegno);
    assert_eq!(MusicalSymbol::Fine, MusicalSymbol::Fine);
}

#[test]
fn json_rejects_recursion_depth_overflow() {
    // Stack-overflow protection: deeply nested input is rejected with a
    // structured error rather than crashing the process. The cap is
    // documented as `MAX_DEPTH` (currently 128) — pick a depth above
    // that so the test fails when the cap is removed.
    let depth = chordsketch_ireal::json::MAX_DEPTH as usize + 16;
    let nested = "[".repeat(depth) + &"]".repeat(depth);
    let err = chordsketch_ireal::parse_json(&nested).expect_err("must reject deep nesting");
    assert!(err.message.contains("MAX_DEPTH"), "unexpected error: {err}");
}

#[test]
fn json_rejects_oversized_input() {
    // Inputs above `MAX_INPUT_BYTES` are rejected up-front, before any
    // parser allocation runs.
    let oversized = String::from("[") + &"0,".repeat(chordsketch_ireal::json::MAX_INPUT_BYTES);
    assert!(chordsketch_ireal::parse_json(&oversized).is_err());
}

#[test]
fn json_rejects_leading_zeros_and_negative_zero() {
    // RFC 8259 §6 forbids leading zeros. The serializer never emits
    // them, so accepting them would let hand-written snapshots round-
    // trip through paths the serializer cannot produce.
    assert!(chordsketch_ireal::parse_json("01").is_err());
    assert!(chordsketch_ireal::parse_json("-01").is_err());
    assert!(chordsketch_ireal::parse_json("-0").is_err());
    assert!(chordsketch_ireal::parse_json("0").is_ok());
    assert!(chordsketch_ireal::parse_json("10").is_ok());
}

#[test]
fn json_rejects_surrogate_pair_escapes() {
    // The serializer never emits surrogate pairs (only C0-control
    // escapes). Rejecting them makes the round-trip-only contract
    // explicit.
    assert!(chordsketch_ireal::parse_json("\"\\uD800\"").is_err());
    assert!(chordsketch_ireal::parse_json("\"\\uDFFF\"").is_err());
}

#[test]
fn json_rejects_oversized_array() {
    let n = chordsketch_ireal::json::MAX_ARRAY_LEN + 1;
    let mut s = String::from("[");
    for i in 0..n {
        if i > 0 {
            s.push(',');
        }
        s.push('0');
    }
    s.push(']');
    // Rejected by MAX_ARRAY_LEN (the string fits within MAX_INPUT_BYTES at
    // current constants — both caps are independent rejection paths anyway).
    assert!(chordsketch_ireal::parse_json(&s).is_err());
}

#[test]
fn json_round_trip_rejects_out_of_range_transpose() {
    // Documented contract on `IrealSong.transpose` is `[-11, 11]`. The
    // deserializer enforces the contract so a hand-written snapshot
    // outside the range cannot land an invalid AST.
    let json = "{\
\"title\":\"\",\
\"composer\":null,\
\"style\":null,\
\"key_signature\":{\"root\":{\"note\":\"C\",\"accidental\":\"natural\"},\"mode\":\"major\"},\
\"time_signature\":{\"numerator\":4,\"denominator\":4},\
\"tempo\":null,\
\"transpose\":12,\
\"sections\":[]\
}";
    let err = IrealSong::from_json_str(json).expect_err("must reject transpose=12");
    assert!(err.message.contains("transpose"), "unexpected: {err}");
}

#[test]
fn json_round_trip_rejects_invalid_chord_root_note() {
    // `ChordRoot.note` is documented A..=G uppercase ASCII. A lowercase
    // letter or non-letter is a structural lie that must not survive a
    // round-trip.
    let json = "{\
\"title\":\"\",\
\"composer\":null,\
\"style\":null,\
\"key_signature\":{\"root\":{\"note\":\"x\",\"accidental\":\"natural\"},\"mode\":\"major\"},\
\"time_signature\":{\"numerator\":4,\"denominator\":4},\
\"tempo\":null,\
\"transpose\":0,\
\"sections\":[]\
}";
    let err = IrealSong::from_json_str(json).expect_err("must reject note='x'");
    assert!(err.message.contains("A..=G"), "unexpected: {err}");
}

#[test]
fn json_round_trip_rejects_zero_tempo() {
    // 0 BPM is meaningless; the serializer emits `null` for "no tempo
    // recorded" and never `0`.
    let json = "{\
\"title\":\"\",\
\"composer\":null,\
\"style\":null,\
\"key_signature\":{\"root\":{\"note\":\"C\",\"accidental\":\"natural\"},\"mode\":\"major\"},\
\"time_signature\":{\"numerator\":4,\"denominator\":4},\
\"tempo\":0,\
\"transpose\":0,\
\"sections\":[]\
}";
    let err = IrealSong::from_json_str(json).expect_err("must reject tempo=0");
    assert!(err.message.contains("tempo"), "unexpected: {err}");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_sample() -> IrealSong {
    let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Minor7);
    let bar_chord = BarChord {
        chord,
        position: BeatPosition::on_beat(1).unwrap(),
    };
    let bar = Bar {
        start: BarLine::OpenRepeat,
        end: BarLine::CloseRepeat,
        chords: vec![bar_chord],
        ending: Ending::new(1),
        symbol: Some(MusicalSymbol::Segno),
        repeat_previous: false,
        no_chord: false,
        text_comment: None,
    };
    let section = Section {
        label: SectionLabel::Letter('A'),
        bars: vec![bar],
    };
    IrealSong {
        title: String::from("Autumn Leaves"),
        composer: Some(String::from("Joseph Kosma")),
        style: Some(String::from("Medium Swing")),
        key_signature: KeySignature {
            root: ChordRoot::natural('E'),
            mode: KeyMode::Minor,
        },
        time_signature: TimeSignature::default(),
        tempo: Some(120),
        transpose: 0,
        sections: vec![section],
    }
}
