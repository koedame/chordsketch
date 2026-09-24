//! Integration tests for the Guitar Pro 5 importer.
//!
//! The three fixtures are real GP5 files written by an open-source Guitar
//! Pro writer (see `tests/fixtures/README.md`). Each has a golden `.cho`
//! file with the exact ChordPro the CLI prints for it.

use chordsketch_chordpro::ast::{Line, Song};
use chordsketch_chordpro::{parse, song_to_chordpro};
use chordsketch_convert::WarningKind;
use chordsketch_import_gp::{GpError, ImportOptions, MAX_INPUT_BYTES, import_gp5};

const FIXTURES: [&str; 3] = ["amazing-grace", "harbor-lights", "greensleeves"];

fn fixture_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn gp5(name: &str) -> Vec<u8> {
    let path = fixture_path(&format!("{name}.gp5"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn import(name: &str) -> Song {
    import_gp5(&gp5(name), &ImportOptions::new())
        .unwrap_or_else(|e| panic!("{name}.gp5 should import: {e}"))
        .output
}

fn chords(song: &Song) -> Vec<String> {
    song.lines
        .iter()
        .filter_map(|l| match l {
            Line::Lyrics(ll) => Some(ll),
            _ => None,
        })
        .flat_map(|ll| ll.segments.iter().filter_map(|s| s.chord.as_ref()))
        .map(|c| c.name.clone())
        .collect()
}

fn directive_values<'a>(song: &'a Song, name: &str) -> Vec<&'a str> {
    song.lines
        .iter()
        .filter_map(|l| match l {
            Line::Directive(d) if d.name == name => d.value.as_deref(),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Golden output
// ---------------------------------------------------------------------------

#[test]
fn when_a_fixture_is_imported_the_chordpro_matches_its_golden_file() {
    for name in FIXTURES {
        let expected_path = fixture_path(&format!("{name}.cho"));
        let expected = std::fs::read_to_string(&expected_path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", expected_path.display()));
        assert_eq!(song_to_chordpro(&import(name)), expected, "{name}.gp5");
    }
}

#[test]
fn when_a_fixture_is_imported_the_output_is_valid_chordpro() {
    for name in FIXTURES {
        let text = song_to_chordpro(&import(name));
        let song = parse(&text).unwrap_or_else(|e| panic!("{name}: output does not parse: {e}"));
        assert!(
            !chords(&song).is_empty(),
            "{name}: no chords survive a re-parse"
        );
        assert!(
            song.metadata.title.is_some(),
            "{name}: no title after a re-parse"
        );
    }
}

// ---------------------------------------------------------------------------
// Amazing Grace — GP 5.10, one track, lyrics on the chord track
// ---------------------------------------------------------------------------

#[test]
fn when_the_file_has_score_information_it_becomes_metadata_directives() {
    let song = import("amazing-grace");
    assert_eq!(song.metadata.title.as_deref(), Some("Amazing Grace"));
    assert_eq!(song.metadata.artists, ["Traditional"]);
    assert_eq!(directive_values(&song, "lyricist"), ["John Newton"]);
    assert_eq!(directive_values(&song, "composer"), ["Traditional"]);
    assert_eq!(directive_values(&song, "copyright"), ["Public domain"]);
    assert_eq!(directive_values(&song, "key"), ["G"]);
    assert_eq!(directive_values(&song, "time"), ["3/4"]);
    assert_eq!(directive_values(&song, "tempo"), ["72"]);
    assert!(directive_values(&song, "capo").is_empty());
}

#[test]
fn when_a_word_is_hyphenated_over_notes_it_is_joined_back_around_its_chord() {
    let text = song_to_chordpro(&import("amazing-grace"));
    assert!(
        text.contains("A[G]mazing [G7]grace how [C]sweet the [G]sound\n"),
        "{text}"
    );
}

#[test]
fn when_a_chord_falls_on_a_rest_before_a_pickup_it_stays_with_the_pickups_line() {
    let text = song_to_chordpro(&import("amazing-grace"));
    assert!(
        text.contains("\n[G]That saved a [Em]wretch like [D]me\n"),
        "{text}"
    );
    assert!(text.contains("\n[D7]I [G]once was"), "{text}");
}

#[test]
fn when_a_measure_has_a_marker_it_opens_a_labelled_section() {
    let song = import("amazing-grace");
    assert_eq!(directive_values(&song, "start_of_verse"), ["Verse 1"]);
    assert!(
        song.lines
            .iter()
            .any(|l| matches!(l, Line::Directive(d) if d.name == "end_of_verse"))
    );
}

// ---------------------------------------------------------------------------
// Harbor Lights — GP 5.00, three tracks, capo, tempo change
// ---------------------------------------------------------------------------

#[test]
fn when_no_track_is_chosen_the_first_track_with_chord_diagrams_is_used() {
    // Track 1 is the vocal melody (no diagrams); track 2 is the rhythm guitar.
    let song = import("harbor-lights");
    assert_eq!(chords(&song).first().map(String::as_str), Some("F#m"));
}

#[test]
fn when_the_chord_track_has_a_capo_chords_are_written_at_sounding_pitch() {
    let song = import("harbor-lights");
    assert_eq!(directive_values(&song, "capo"), ["2"]);
    // The diagrams are Em / C / D shapes; with the capo on 2 they sound as
    // F#m / D / E.
    assert_eq!(chords(&song)[..3], ["F#m", "D", "E"]);
}

#[test]
fn when_the_lyrics_are_on_another_track_they_line_up_with_the_chords_by_time() {
    let text = song_to_chordpro(&import("harbor-lights"));
    assert!(
        text.contains("[F#m]Lanterns on [D]the [A]water\n"),
        "{text}"
    );
    assert!(text.contains("[A]Harbor lights are [E]calling\n"), "{text}");
}

#[test]
fn when_a_lyric_line_breaks_mid_measure_the_chordpro_line_breaks_there() {
    let text = song_to_chordpro(&import("harbor-lights"));
    assert!(
        text.contains("calling\nBring [F#m]me back [D]again to shore\n"),
        "{text}"
    );
}

#[test]
fn when_lyrics_use_plus_comments_and_underscores_they_are_cleaned_up() {
    let text = song_to_chordpro(&import("harbor-lights"));
    // `[verse]` is dropped, `Guide+me` shares a note, `night__` loses the
    // underscores.
    assert!(!text.contains("verse] "), "{text}");
    assert!(text.contains("[Bm7]Guide me home tonight"), "{text}");
    assert!(!text.contains("night_"), "{text}");
}

#[test]
fn when_the_tempo_changes_mid_song_a_tempo_directive_is_emitted_there() {
    let song = import("harbor-lights");
    assert_eq!(directive_values(&song, "tempo"), ["96", "104"]);
    let text = song_to_chordpro(&song);
    assert!(
        text.contains("{start_of_chorus: Chorus}\n{tempo: 104}\n"),
        "{text}"
    );
}

#[test]
fn when_a_section_has_no_lyrics_its_chords_form_a_chord_only_line() {
    let text = song_to_chordpro(&import("harbor-lights"));
    assert!(
        text.contains("{start_of_verse: Intro}\n[F#m] [D] [E]\n"),
        "{text}"
    );
}

#[test]
fn when_a_diagram_has_no_name_it_is_spelled_from_its_root_and_type_with_a_warning() {
    let result = import_gp5(&gp5("harbor-lights"), &ImportOptions::new()).unwrap();
    // A Gmaj7 shape under a capo on 2.
    assert!(chords(&result.output).contains(&"Amaj7".to_string()));
    assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
    assert_eq!(result.warnings[0].kind, WarningKind::Approximated);
    assert!(result.warnings[0].message.contains("measure 11"));
}

#[test]
fn when_a_chord_sits_in_the_second_voice_it_is_imported() {
    // Measure 6 of the rhythm guitar has its D shape (E at pitch) in voice 2.
    let text = song_to_chordpro(&import("harbor-lights"));
    assert!(text.contains("tonight [E][F#m]"), "{text}");
}

#[test]
fn when_a_track_is_chosen_its_chords_are_used() {
    let options = ImportOptions::new().with_track(2);
    let result = import_gp5(&gp5("harbor-lights"), &options).unwrap();
    assert_eq!(chords(&result.output), chords(&import("harbor-lights")));
}

#[test]
fn when_the_chosen_track_has_no_chords_the_lyrics_remain_and_a_warning_says_why() {
    let options = ImportOptions::new().with_track(3);
    let result = import_gp5(&gp5("harbor-lights"), &options).unwrap();
    assert!(chords(&result.output).is_empty());
    // No capo: the bass track has none.
    assert!(directive_values(&result.output, "capo").is_empty());
    let text = song_to_chordpro(&result.output);
    assert!(text.contains("Lanterns on the water\n"), "{text}");
    assert_eq!(result.warnings.len(), 1);
    assert_eq!(result.warnings[0].kind, WarningKind::LossyDrop);
    assert!(result.warnings[0].message.contains("track 3 (Bass)"));
}

#[test]
fn when_the_chosen_track_does_not_exist_the_error_lists_the_tracks() {
    for track in [0, 4] {
        let options = ImportOptions::new().with_track(track);
        let err = import_gp5(&gp5("harbor-lights"), &options).unwrap_err();
        assert_eq!(
            err,
            GpError::TrackOutOfRange {
                requested: track,
                tracks: vec![
                    "Vocal Melody".to_string(),
                    "Rhythm Guitar".to_string(),
                    "Bass".to_string()
                ],
            }
        );
    }
}

// ---------------------------------------------------------------------------
// Greensleeves — GP 5.10, 6/8, chords in the bass voice, no lyric breaks
// ---------------------------------------------------------------------------

#[test]
fn when_the_lyrics_have_no_line_breaks_lines_break_every_four_measures() {
    let text = song_to_chordpro(&import("greensleeves"));
    assert!(
        text.contains(
            "{start_of_verse: Verse}\n\
             [Am]Alas my love [Am]you do me wrong [G]to cast me off [E]discourteously\n\
             {end_of_verse}"
        ),
        "{text}"
    );
}

#[test]
fn when_the_key_is_minor_and_the_time_is_compound_the_directives_say_so() {
    let song = import("greensleeves");
    assert_eq!(directive_values(&song, "key"), ["Am"]);
    assert_eq!(directive_values(&song, "time"), ["6/8"]);
    assert_eq!(directive_values(&song, "start_of_chorus"), ["Refrain"]);
}

#[test]
fn when_chords_fall_mid_bar_in_compound_time_they_land_on_the_right_syllable() {
    // In 6/8 the second chord of measure 6 is on the fourth eighth, under
    // "Green-".
    let text = song_to_chordpro(&import("greensleeves"));
    assert!(
        text.contains("[G]my joy [E]Greensleeves [F]was my [E]delight"),
        "{text}"
    );
}

// ---------------------------------------------------------------------------
// Damaged and unsupported input
// ---------------------------------------------------------------------------

#[test]
fn when_a_fixture_is_cut_short_the_importer_returns_an_error_instead_of_panicking() {
    for name in FIXTURES {
        let bytes = gp5(name);
        // The last byte is the final measure's line-break marker, which the
        // importer tolerates missing; any shorter prefix is an error.
        for len in 0..bytes.len() - 1 {
            assert!(
                import_gp5(&bytes[..len], &ImportOptions::new()).is_err(),
                "{name}: a {len}-byte prefix imported"
            );
        }
    }
}

#[test]
fn when_any_single_byte_is_corrupted_the_importer_does_not_panic() {
    for name in FIXTURES {
        let bytes = gp5(name);
        for i in 0..bytes.len() {
            let mut corrupted = bytes.clone();
            corrupted[i] ^= 0xFF;
            // Either outcome is acceptable; the test fails only on a panic.
            let _ = import_gp5(&corrupted, &ImportOptions::new());
        }
    }
}

#[test]
fn when_the_file_is_another_guitar_pro_version_it_is_rejected_by_name() {
    let mut gp4 = vec![24u8];
    gp4.extend_from_slice(b"FICHIER GUITAR PRO v4.06");
    gp4.resize(31 + 64, 0);
    assert_eq!(
        import_gp5(&gp4, &ImportOptions::new()).unwrap_err(),
        GpError::UnsupportedVersion {
            version: "FICHIER GUITAR PRO v4.06".to_string()
        }
    );
}

#[test]
fn when_the_input_is_not_a_guitar_pro_file_it_is_rejected() {
    // A Guitar Pro 7 file is a ZIP archive; GP6 files start with "BCFZ".
    for bytes in [
        &b""[..],
        b"PK\x03\x04rest-of-a-zip",
        b"BCFZ\x00\x00\x00\x00",
    ] {
        assert_eq!(
            import_gp5(bytes, &ImportOptions::new()).unwrap_err(),
            GpError::UnsupportedVersion {
                version: String::new()
            }
        );
    }
}

#[test]
fn when_the_input_is_over_the_size_limit_it_is_rejected_before_parsing() {
    let bytes = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(
        import_gp5(&bytes, &ImportOptions::new()).unwrap_err(),
        GpError::TooLarge {
            size: MAX_INPUT_BYTES + 1
        }
    );
}
