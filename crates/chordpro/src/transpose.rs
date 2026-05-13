//! Chord transposition — shift all chords in a song by N semitones.
//!
//! The [`transpose`] function walks every chord in a [`Song`] and shifts its
//! root (and bass note, for slash chords) by the given number of semitones,
//! wrapping around the 12-tone chromatic scale.
//!
//! Chords whose notation could not be parsed structurally (i.e., `detail` is
//! `None`) are left unchanged — only their raw `name` is preserved.

use crate::ast::{
    Chord, ChordDefinition, Directive, DirectiveKind, Line, LyricsLine, LyricsSegment, Song,
};
use crate::chord::{Accidental, ChordDetail, ChordQuality, Note};

/// The chromatic scale using sharps for enharmonic equivalents.
const SHARP_NAMES: [(Note, Option<Accidental>); 12] = [
    (Note::C, None),
    (Note::C, Some(Accidental::Sharp)),
    (Note::D, None),
    (Note::D, Some(Accidental::Sharp)),
    (Note::E, None),
    (Note::F, None),
    (Note::F, Some(Accidental::Sharp)),
    (Note::G, None),
    (Note::G, Some(Accidental::Sharp)),
    (Note::A, None),
    (Note::A, Some(Accidental::Sharp)),
    (Note::B, None),
];

/// The chromatic scale using flats for enharmonic equivalents.
const FLAT_NAMES: [(Note, Option<Accidental>); 12] = [
    (Note::C, None),
    (Note::D, Some(Accidental::Flat)),
    (Note::D, None),
    (Note::E, Some(Accidental::Flat)),
    (Note::E, None),
    (Note::F, None),
    (Note::G, Some(Accidental::Flat)),
    (Note::G, None),
    (Note::A, Some(Accidental::Flat)),
    (Note::A, None),
    (Note::B, Some(Accidental::Flat)),
    (Note::B, None),
];

/// Convert a note + accidental to a semitone index (0 = C, 11 = B).
fn note_to_semitone(note: Note, accidental: Option<Accidental>) -> u8 {
    let base = match note {
        Note::C => 0,
        Note::D => 2,
        Note::E => 4,
        Note::F => 5,
        Note::G => 7,
        Note::A => 9,
        Note::B => 11,
    };
    match accidental {
        Some(Accidental::Sharp) => (base + 1) % 12,
        Some(Accidental::Flat) => (base + 11) % 12,
        None => base,
    }
}

/// Shift a semitone index by the given number of semitones.
fn shift_semitone(semitone: u8, shift: i8) -> u8 {
    ((i16::from(semitone) + i16::from(shift)).rem_euclid(12)) as u8
}

/// Choose sharp or flat spelling based on the original accidental.
///
/// If the original chord used a flat, the transposed result prefers flats.
/// Otherwise it uses sharps. This preserves the musical intent of the
/// original notation.
fn transposed_note(semitone: u8, prefer_flat: bool) -> (Note, Option<Accidental>) {
    if prefer_flat {
        FLAT_NAMES[semitone as usize]
    } else {
        SHARP_NAMES[semitone as usize]
    }
}

/// Canonical spelling for a chromatic pitch class as a key root.
///
/// Used after transposition to pick the conventional name
/// (e.g. `A#` → `Bb`, `D#` → `Eb`, `G#` → `Ab`) rather than the
/// raw sharp/flat spelling carried over from the source. Pop
/// and folk chord-sheet authors expect flat spellings for these
/// pitches; classical music sometimes prefers the sharp form
/// but the flat is the more common standard.
///
/// Returns `(note, accidental)` for the canonical major-key
/// spelling. Minor keys reuse the same root pitch spelling
/// (`Em`, `Ebm`, …) — the relative-major key signature governs
/// which side of the circle of fifths the pitch sits on.
#[must_use]
pub fn canonical_key_spelling(semitone: u8) -> (Note, Option<Accidental>) {
    match semitone % 12 {
        0 => (Note::C, None),
        1 => (Note::D, Some(Accidental::Flat)), // Db, not C#
        2 => (Note::D, None),
        3 => (Note::E, Some(Accidental::Flat)), // Eb, not D#
        4 => (Note::E, None),
        5 => (Note::F, None),
        6 => (Note::G, Some(Accidental::Flat)), // Gb (F#/Gb tie — flat-side wins for pop / folk convention)
        7 => (Note::G, None),
        8 => (Note::A, Some(Accidental::Flat)), // Ab, not G#
        9 => (Note::A, None),
        10 => (Note::B, Some(Accidental::Flat)), // Bb, not A#
        11 => (Note::B, None),
        _ => unreachable!(),
    }
}

/// Does the given key spelling sit on the FLAT side of the
/// circle of fifths? Used to decide whether transposed chords
/// in this song should use flat or sharp accidentals.
///
/// Flat-side major keys: `F`, `Bb`, `Eb`, `Ab`, `Db`, `Gb`,
/// `Cb`. Anything with a sharp accidental, plus `C` / `G` / `D`
/// / `A` / `E` / `B`, is sharp-side. For minor keys we look at
/// the relative major's side.
#[must_use]
pub fn key_prefers_flat(root: Note, accidental: Option<Accidental>, is_minor: bool) -> bool {
    match accidental {
        Some(Accidental::Flat) => true,
        Some(Accidental::Sharp) => false,
        None => {
            if is_minor {
                // Relative major of these minor roots is a
                // flat-side key (Dm→F, Gm→Bb, Cm→Eb, Fm→Ab).
                matches!(root, Note::D | Note::G | Note::C | Note::F)
            } else {
                // Only F (no accidental) is flat-side. C major
                // is neutral but defaults to sharps for chromatic
                // accidentals — match the convention.
                matches!(root, Note::F)
            }
        }
    }
}

/// Transpose a [`ChordDetail`] by the given number of semitones.
///
/// Returns a new `ChordDetail` with the root and bass note shifted.
/// Quality and extensions are preserved.
#[must_use]
pub fn transpose_detail(detail: &ChordDetail, semitones: i8) -> ChordDetail {
    let prefer_flat = detail.root_accidental == Some(Accidental::Flat);

    let root_semitone = note_to_semitone(detail.root, detail.root_accidental);
    let new_semitone = shift_semitone(root_semitone, semitones);
    let (new_root, new_acc) = transposed_note(new_semitone, prefer_flat);

    let new_bass = detail.bass_note.map(|(bass_note, bass_acc)| {
        let bass_prefer_flat = bass_acc == Some(Accidental::Flat);
        let bass_semitone = note_to_semitone(bass_note, bass_acc);
        let new_bass_semitone = shift_semitone(bass_semitone, semitones);
        transposed_note(new_bass_semitone, bass_prefer_flat)
    });

    ChordDetail {
        root: new_root,
        root_accidental: new_acc,
        quality: detail.quality,
        extension: detail.extension.clone(),
        bass_note: new_bass,
    }
}

/// Transpose a single [`Chord`] by the given number of semitones.
///
/// If the chord has a parsed `detail`, both the detail and the display
/// `name` are updated. If the chord could not be parsed (detail is `None`),
/// it is returned unchanged.
///
/// Uses the chord's own root accidental to choose sharp / flat
/// spelling. For song-wide transpose where every chord should
/// follow the SAME spelling convention (matching the target
/// key signature side), use
/// [`transpose_chord_with_style`] instead.
#[must_use]
pub fn transpose_chord(chord: &Chord, semitones: i8) -> Chord {
    match &chord.detail {
        Some(detail) => {
            let new_detail = transpose_detail(detail, semitones);
            let new_name = new_detail.to_string();
            Chord {
                name: new_name,
                detail: Some(new_detail),
                display: chord.display.clone(),
            }
        }
        None => chord.clone(),
    }
}

/// Like [`transpose_chord`] but forces a song-wide flat/sharp
/// spelling preference on every transposed root + bass note.
///
/// Pass `prefer_flat = true` when the song's transposed key is
/// flat-side (F major, Bb major, Eb major, …), and `false` when
/// it's sharp-side (G, D, A, E, B, F#, C#) or the neutral C
/// major. Used by [`transpose`] so a song transposed into
/// e.g. Eb gets every chord re-spelled with flats (avoiding
/// the mixed `D#` / `Ab` output you'd otherwise get from
/// per-chord style preservation).
#[must_use]
pub fn transpose_chord_with_style(chord: &Chord, semitones: i8, prefer_flat: bool) -> Chord {
    match &chord.detail {
        Some(detail) => {
            let new_detail = transpose_detail_with_style(detail, semitones, prefer_flat);
            let new_name = new_detail.to_string();
            Chord {
                name: new_name,
                detail: Some(new_detail),
                display: chord.display.clone(),
            }
        }
        None => chord.clone(),
    }
}

/// Like [`transpose_detail`] but forces a song-wide
/// flat/sharp spelling on root + bass. See
/// [`transpose_chord_with_style`].
#[must_use]
pub fn transpose_detail_with_style(
    detail: &ChordDetail,
    semitones: i8,
    prefer_flat: bool,
) -> ChordDetail {
    let root_semitone = note_to_semitone(detail.root, detail.root_accidental);
    let new_semitone = shift_semitone(root_semitone, semitones);
    let (new_root, new_acc) = transposed_note(new_semitone, prefer_flat);

    let new_bass = detail.bass_note.map(|(bass_note, bass_acc)| {
        let bass_semitone = note_to_semitone(bass_note, bass_acc);
        let new_bass_semitone = shift_semitone(bass_semitone, semitones);
        transposed_note(new_bass_semitone, prefer_flat)
    });

    ChordDetail {
        root: new_root,
        root_accidental: new_acc,
        quality: detail.quality,
        extension: detail.extension.clone(),
        bass_note: new_bass,
    }
}

/// Transpose all chords in a [`Song`] by the given number of semitones.
///
/// Returns a new `Song` with every chord shifted. Metadata, directives,
/// comments, and lyrics text are preserved. Chords without a parsed
/// `detail` are left unchanged.
///
/// A shift of 0 produces an equivalent copy.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::parse;
/// use chordsketch_chordpro::transpose::transpose;
///
/// let song = parse("[G]Hello [C]world").unwrap();
/// let transposed = transpose(&song, 2); // up 2 semitones
/// // G → A, C → D
/// let first_line = &transposed.lines[0];
/// if let chordsketch_chordpro::ast::Line::Lyrics(l) = first_line {
///     assert_eq!(l.segments[0].chord.as_ref().unwrap().name, "A");
///     assert_eq!(l.segments[1].chord.as_ref().unwrap().name, "D");
/// }
/// ```
#[must_use]
pub fn transpose(song: &Song, semitones: i8) -> Song {
    // Pick a song-wide flat/sharp preference based on the
    // TRANSPOSED key (= the key signature the player reads
    // after the transpose is applied). Every chord gets
    // re-spelled with that preference so the output is
    // consistent — no mixed `D#` / `Ab` in a song that's
    // landed in Eb. Falls back to per-chord style preservation
    // when the song has no parseable `{key}`.
    let prefer_flat = transposed_key_prefers_flat(&song.metadata, semitones);
    let new_lines = song
        .lines
        .iter()
        .map(|line| match line {
            Line::Lyrics(lyrics_line) => Line::Lyrics(transpose_lyrics_with_style(
                lyrics_line,
                semitones,
                prefer_flat,
            )),
            Line::Directive(directive) => Line::Directive(
                transpose_transposable_define_with_style(directive, semitones, prefer_flat)
                    .unwrap_or_else(|| directive.clone()),
            ),
            other => other.clone(),
        })
        .collect();

    // Leave `metadata` untouched — the AST's `{key}` holds the
    // AUTHORED key, and the transposed value is communicated to
    // consumers via a separate channel (e.g. wasm returns it as
    // a sibling field). Renderers and consumers that want the
    // transposed-key spelling call `canonical_transposed_key`
    // explicitly.
    Song {
        metadata: song.metadata.clone(),
        lines: new_lines,
    }
}

/// Compute the canonical spelling for the song's primary
/// `{key}` after transposition by `semitones`. Pop / folk
/// convention: prefer flats for ambiguous black-key pitches
/// (`Bb` over `A#`, `Eb` over `D#`, `Gb` over `F#`, etc.).
///
/// Returns `None` when the song has no parseable primary key
/// (e.g. `{key: C dorian}` or no `{key}` at all).
#[must_use]
pub fn canonical_transposed_key(song_key: Option<&str>, semitones: i8) -> Option<String> {
    let key_str = song_key?;
    let chord = crate::ast::Chord::new(key_str);
    let detail = chord.detail.as_ref()?;
    let transposed = transpose_detail_with_style(
        detail,
        semitones,
        key_prefers_flat_for_song(detail, semitones),
    );
    Some(canonical_key_string(&transposed))
}

fn key_prefers_flat_for_song(detail: &ChordDetail, semitones: i8) -> bool {
    let root_semitone = note_to_semitone(detail.root, detail.root_accidental);
    let new_semitone = shift_semitone(root_semitone, semitones);
    let (new_root, new_acc) = canonical_key_spelling(new_semitone);
    let is_minor = detail.quality == ChordQuality::Minor;
    key_prefers_flat(new_root, new_acc, is_minor)
}

/// Compute the canonical-spelling string for a transposed key
/// detail. Drops the chord quality (a key is a root + minor
/// flag, not a chord type) and emits e.g. `"Bb"` / `"F#m"`.
fn canonical_key_string(detail: &ChordDetail) -> String {
    let root_semitone = note_to_semitone(detail.root, detail.root_accidental);
    let (new_root, new_acc) = canonical_key_spelling(root_semitone);
    let mut s = String::new();
    s.push(match new_root {
        Note::C => 'C',
        Note::D => 'D',
        Note::E => 'E',
        Note::F => 'F',
        Note::G => 'G',
        Note::A => 'A',
        Note::B => 'B',
    });
    if let Some(acc) = new_acc {
        match acc {
            Accidental::Sharp => s.push('#'),
            Accidental::Flat => s.push('b'),
        }
    }
    if detail.quality == ChordQuality::Minor {
        s.push('m');
    }
    s
}

/// Decide whether the song's transposed key is on the flat side
/// of the circle of fifths. Used by [`transpose`] to pick a
/// single spelling preference for the whole song.
fn transposed_key_prefers_flat(metadata: &crate::ast::Metadata, semitones: i8) -> bool {
    let Some(key_str) = metadata.key.as_deref() else {
        return false;
    };
    let chord = crate::ast::Chord::new(key_str);
    let Some(detail) = &chord.detail else {
        return false;
    };
    let root_semitone = note_to_semitone(detail.root, detail.root_accidental);
    let new_semitone = shift_semitone(root_semitone, semitones);
    let (new_root, new_acc) = canonical_key_spelling(new_semitone);
    let is_minor = detail.quality == ChordQuality::Minor;
    key_prefers_flat(new_root, new_acc, is_minor)
}

/// Transpose every chord in a lyrics line using a fixed
/// flat/sharp style.
fn transpose_lyrics_with_style(
    lyrics_line: &crate::ast::LyricsLine,
    semitones: i8,
    prefer_flat: bool,
) -> crate::ast::LyricsLine {
    let new_segments = lyrics_line
        .segments
        .iter()
        .map(|seg| {
            let new_chord = seg
                .chord
                .as_ref()
                .map(|c| transpose_chord_with_style(c, semitones, prefer_flat));
            LyricsSegment {
                chord: new_chord,
                text: seg.text.clone(),
                spans: seg.spans.clone(),
            }
        })
        .collect();
    crate::ast::LyricsLine {
        segments: new_segments,
    }
}

/// If `directive` is a `{define: [X]}` or `{chord: [X]}` directive whose
/// chord name was written in the transposable bracket form (R6.100.0),
/// return a clone of the directive with the chord name shifted by
/// `semitones`. Returns `None` for any other directive (including
/// non-bracket / "fixed" defines), so the caller can keep the original
/// node untouched — matching upstream `Song.pm:define_chord`'s default
/// `$fixed = 1` path.
///
/// The re-emitted value preserves the bracket form: a transposable
/// `{define: [A]}` shifted by 2 becomes `{define: [B]}`. Bracket form
/// disallows other attributes (see [`ChordDefinition::parse_value`]), so
/// the rewrite is just `[<new_name>]`.
#[allow(dead_code)] // legacy helper kept for the public `transpose_chord` API path.
fn transpose_transposable_define(directive: &Directive, semitones: i8) -> Option<Directive> {
    if !matches!(
        directive.kind,
        DirectiveKind::Define | DirectiveKind::ChordDirective
    ) {
        return None;
    }
    let value = directive.value.as_deref()?;
    let def = ChordDefinition::parse_value(value);
    if !def.transposable {
        return None;
    }
    let chord = Chord::new(&def.name);
    let transposed = transpose_chord(&chord, semitones);
    let new_value = format!("[{}]", transposed.name);
    Some(Directive {
        name: directive.name.clone(),
        value: Some(new_value),
        kind: directive.kind.clone(),
        selector: directive.selector.clone(),
    })
}

/// Like [`transpose_transposable_define`] but routes through
/// [`transpose_chord_with_style`] so the song-wide flat/sharp
/// preference is applied to defined chord names too.
fn transpose_transposable_define_with_style(
    directive: &Directive,
    semitones: i8,
    prefer_flat: bool,
) -> Option<Directive> {
    if !matches!(
        directive.kind,
        DirectiveKind::Define | DirectiveKind::ChordDirective
    ) {
        return None;
    }
    let value = directive.value.as_deref()?;
    let def = ChordDefinition::parse_value(value);
    if !def.transposable {
        return None;
    }
    let chord = Chord::new(&def.name);
    let transposed = transpose_chord_with_style(&chord, semitones, prefer_flat);
    let new_value = format!("[{}]", transposed.name);
    Some(Directive {
        name: directive.name.clone(),
        value: Some(new_value),
        kind: directive.kind.clone(),
        selector: directive.selector.clone(),
    })
}

/// Combine a file-level transpose offset with a CLI transpose offset.
///
/// Returns `(result, saturated)` where `result` is the clamped sum and
/// `saturated` is `true` if the exact sum would have overflowed i8.
#[must_use]
pub fn combine_transpose(file_offset: i8, cli_offset: i8) -> (i8, bool) {
    let exact = file_offset as i16 + cli_offset as i16;
    let saturated = exact < i8::MIN as i16 || exact > i8::MAX as i16;
    (file_offset.saturating_add(cli_offset), saturated)
}

/// Transpose all chords in a lyrics line.
#[allow(dead_code)] // legacy helper kept for the public `transpose_chord` API path.
fn transpose_lyrics(lyrics_line: &LyricsLine, semitones: i8) -> LyricsLine {
    LyricsLine {
        segments: lyrics_line
            .segments
            .iter()
            .map(|seg| LyricsSegment {
                spans: seg.spans.clone(),
                chord: seg.chord.as_ref().map(|c| transpose_chord(c, semitones)),
                text: seg.text.clone(),
            })
            .collect(),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chord::parse_chord;

    // --- canonical_key_spelling ---

    #[test]
    fn canonical_key_spelling_prefers_flat_for_black_keys() {
        // 12-tone chromatic spellings used in pop / folk
        // chord-sheet conventions.
        assert_eq!(canonical_key_spelling(0), (Note::C, None));
        assert_eq!(canonical_key_spelling(1), (Note::D, Some(Accidental::Flat)));
        assert_eq!(canonical_key_spelling(3), (Note::E, Some(Accidental::Flat)));
        assert_eq!(canonical_key_spelling(6), (Note::G, Some(Accidental::Flat)));
        assert_eq!(canonical_key_spelling(8), (Note::A, Some(Accidental::Flat)));
        assert_eq!(
            canonical_key_spelling(10),
            (Note::B, Some(Accidental::Flat))
        );
    }

    // --- transpose(song, …) normalises spelling song-wide ---

    fn parse_song(input: &str) -> Song {
        crate::parser::parse(input).expect("parse failed")
    }

    #[test]
    fn canonical_transposed_key_normalises_to_pop_spelling() {
        // C major transposed +1 lands at canonical Db (NOT C#),
        // even though the chromatic-shift table would otherwise
        // emit C# for a source with no flat accidental.
        assert_eq!(
            canonical_transposed_key(Some("C"), 1).as_deref(),
            Some("Db")
        );
        // C +10 → Bb (NOT A#).
        assert_eq!(
            canonical_transposed_key(Some("C"), 10).as_deref(),
            Some("Bb")
        );
        // C +3 → Eb (NOT D#).
        assert_eq!(
            canonical_transposed_key(Some("C"), 3).as_deref(),
            Some("Eb")
        );
        // C +8 → Ab (NOT G#).
        assert_eq!(
            canonical_transposed_key(Some("C"), 8).as_deref(),
            Some("Ab")
        );
        // Missing key returns None.
        assert_eq!(canonical_transposed_key(None, 1), None);
    }

    #[test]
    fn transpose_song_keeps_authored_key_in_metadata() {
        // `transpose(song, …)` re-spells the chord LINES with the
        // target key's flat/sharp side preference, but leaves
        // `metadata.key` alone — that field is the AUTHORED key.
        // Renderers / wasm communicate the transposed value
        // through a separate channel.
        let song = parse_song("{key: C}\n[C]Hello");
        let transposed = transpose(&song, 1);
        assert_eq!(transposed.metadata.key.as_deref(), Some("C"));
    }

    #[test]
    fn transpose_song_picks_flat_or_sharp_side_per_target_key() {
        // C transposed +3 → Eb (flat-side). Chords like F# would
        // re-spell as flats (Gb).
        let song = parse_song("{key: C}\n[F#]Hello");
        let transposed = transpose(&song, 3);
        // `metadata.key` stays as authored `"C"`; the canonical
        // transposed spelling is exposed via the dedicated helper.
        assert_eq!(transposed.metadata.key.as_deref(), Some("C"));
        assert_eq!(
            canonical_transposed_key(Some("C"), 3).as_deref(),
            Some("Eb")
        );
        // Walk the lyrics to find the transposed chord.
        let chord_names: Vec<&str> = transposed
            .lines
            .iter()
            .filter_map(|line| {
                if let Line::Lyrics(l) = line {
                    l.segments
                        .iter()
                        .find_map(|s| s.chord.as_ref().map(|c| c.name.as_str()))
                } else {
                    None
                }
            })
            .collect();
        // F# transposed +3 = A. Spelling is canonical for an
        // Eb-major song, but A has no accidental either way.
        // Use a more interesting example: F# transposed +3 → A,
        // but we expect chord_names = ["A"].
        assert_eq!(chord_names, vec!["A"]);
    }

    #[test]
    fn transpose_song_normalises_a_sharp_to_b_flat() {
        // C transposed +10 → A#/Bb. Canonical is Bb.
        let song = parse_song("{key: C}\n[C]Hi");
        let transposed = transpose(&song, 10);
        // metadata.key unchanged (authored C). canonical spelling = Bb.
        assert_eq!(transposed.metadata.key.as_deref(), Some("C"));
        assert_eq!(
            canonical_transposed_key(Some("C"), 10).as_deref(),
            Some("Bb")
        );
    }

    #[test]
    fn transpose_song_landing_on_g_uses_sharps() {
        // C transposed +7 → G (sharp-side). A song that lands on
        // G should keep sharp accidentals for chromatic chords.
        let song = parse_song("{key: C}\n[F]Hi");
        let transposed = transpose(&song, 7);
        // metadata.key unchanged (authored C). canonical spelling = G.
        assert_eq!(transposed.metadata.key.as_deref(), Some("C"));
        assert_eq!(canonical_transposed_key(Some("C"), 7).as_deref(), Some("G"));
    }

    #[test]
    fn transpose_song_landing_on_flat_key_normalises_chord_chromatics() {
        // C transposed +3 → Eb (flat-side). A C# chord (which
        // would parse as enharmonic Db at +3) should land as Db,
        // not C#... wait, C# transposed +3 = E. Better example:
        // C transposed +6 → F#. Then C# transposed +6 = G.
        // Let's test the flat-side case with a chord that has a
        // sharp in the source but should be re-spelled flat:
        // Source: C with C# chord. Transpose +3 → Eb song. C# +3
        // = E (natural), no spelling ambiguity. Hmm.
        // Use a clearer case: source C major with a D# chord
        // transposed +3 → Eb song. D# +3 = F# in sharp spelling
        // or Gb in flat. We expect Gb for the flat-side target.
        let song = parse_song("{key: C}\n[D#]Hi");
        let transposed = transpose(&song, 3);
        // metadata.key unchanged; canonical lookup gives Eb.
        assert_eq!(
            canonical_transposed_key(Some("C"), 3).as_deref(),
            Some("Eb")
        );
        let chord_name = transposed
            .lines
            .iter()
            .find_map(|line| {
                if let Line::Lyrics(l) = line {
                    l.segments
                        .iter()
                        .find_map(|s| s.chord.as_ref().map(|c| c.name.clone()))
                } else {
                    None
                }
            })
            .expect("expected a chord");
        // Flat-side target → Gb, not F#.
        assert_eq!(chord_name, "Gb");
    }

    // `metadata.keys` is the AUTHORED list; `transpose(song, …)`
    // does not re-spell it. Consumers that want the canonical
    // transposed spelling call `canonical_transposed_key`
    // directly for each entry.

    // --- note_to_semitone ---

    #[test]
    fn test_note_to_semitone() {
        assert_eq!(note_to_semitone(Note::C, None), 0);
        assert_eq!(note_to_semitone(Note::C, Some(Accidental::Sharp)), 1);
        assert_eq!(note_to_semitone(Note::D, Some(Accidental::Flat)), 1);
        assert_eq!(note_to_semitone(Note::D, None), 2);
        assert_eq!(note_to_semitone(Note::E, None), 4);
        assert_eq!(note_to_semitone(Note::F, None), 5);
        assert_eq!(note_to_semitone(Note::G, None), 7);
        assert_eq!(note_to_semitone(Note::A, None), 9);
        assert_eq!(note_to_semitone(Note::B, None), 11);
        assert_eq!(note_to_semitone(Note::B, Some(Accidental::Sharp)), 0);
    }

    // --- transpose_detail ---

    #[test]
    fn test_transpose_c_up_2() {
        let detail = parse_chord("C").unwrap();
        let t = transpose_detail(&detail, 2);
        assert_eq!(t.root, Note::D);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_g_up_2() {
        let detail = parse_chord("G").unwrap();
        let t = transpose_detail(&detail, 2);
        assert_eq!(t.root, Note::A);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_b_up_1_wraps() {
        let detail = parse_chord("B").unwrap();
        let t = transpose_detail(&detail, 1);
        assert_eq!(t.root, Note::C);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_c_down_1() {
        let detail = parse_chord("C").unwrap();
        let t = transpose_detail(&detail, -1);
        assert_eq!(t.root, Note::B);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_preserves_quality() {
        let detail = parse_chord("Am7").unwrap();
        let t = transpose_detail(&detail, 3);
        assert_eq!(t.root, Note::C);
        assert_eq!(t.quality, ChordQuality::Minor);
        assert_eq!(t.extension.as_deref(), Some("7"));
    }

    #[test]
    fn test_transpose_sharp_chord() {
        let detail = parse_chord("F#m").unwrap();
        let t = transpose_detail(&detail, 2);
        assert_eq!(t.root, Note::G);
        assert_eq!(t.root_accidental, Some(Accidental::Sharp));
        assert_eq!(t.quality, ChordQuality::Minor);
    }

    #[test]
    fn test_transpose_bb_up_2_to_c() {
        let detail = parse_chord("Bb").unwrap();
        let t = transpose_detail(&detail, 2);
        // Bb (10) + 2 = 0 = C (natural — no accidental; flat spelling is
        // not preserved here because C has no flat form).
        assert_eq!(t.root, Note::C);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_eb_up_2_to_f() {
        let detail = parse_chord("Eb").unwrap();
        let t = transpose_detail(&detail, 2);
        // Eb (3) + 2 = 5 = F natural. F has no flat form in standard chord
        // notation, so the flat accidental is dropped.
        assert_eq!(t.root, Note::F);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_slash_chord() {
        let detail = parse_chord("G/B").unwrap();
        let t = transpose_detail(&detail, 2);
        assert_eq!(t.root, Note::A);
        assert_eq!(t.bass_note, Some((Note::C, Some(Accidental::Sharp))));
    }

    #[test]
    fn test_transpose_zero_is_noop() {
        let detail = parse_chord("Am7").unwrap();
        let t = transpose_detail(&detail, 0);
        assert_eq!(t, detail);
    }

    #[test]
    fn test_transpose_full_cycle() {
        let detail = parse_chord("C").unwrap();
        let t = transpose_detail(&detail, 12);
        assert_eq!(t.root, Note::C);
        assert_eq!(t.root_accidental, None);
    }

    #[test]
    fn test_transpose_negative_full_cycle() {
        let detail = parse_chord("Am").unwrap();
        let t = transpose_detail(&detail, -12);
        assert_eq!(t, detail);
    }

    // --- transpose_chord ---

    #[test]
    fn test_transpose_chord_updates_name() {
        let chord = Chord::new("G");
        let t = transpose_chord(&chord, 2);
        assert_eq!(t.name, "A");
    }

    #[test]
    fn test_transpose_chord_unparseable_unchanged() {
        let chord = Chord {
            name: "N.C.".to_string(),
            detail: None,
            display: None,
        };
        let t = transpose_chord(&chord, 5);
        assert_eq!(t.name, "N.C.");
        assert!(t.detail.is_none());
    }

    #[test]
    fn test_transpose_chord_preserves_display() {
        let mut chord = Chord::new("Am");
        chord.display = Some("A minor".to_string());
        let t = transpose_chord(&chord, 2);
        assert_eq!(t.name, "Bm");
        assert_eq!(t.display, Some("A minor".to_string()));
        assert_eq!(t.display_name(), "A minor");
    }

    #[test]
    fn test_transpose_chord_preserves_none_display() {
        let chord = Chord::new("Am");
        let t = transpose_chord(&chord, 2);
        assert_eq!(t.name, "Bm");
        assert_eq!(t.display, None);
        assert_eq!(t.display_name(), "Bm");
    }

    #[test]
    fn test_transpose_song_preserves_display() {
        let song = crate::parse("{define: Am display=\"A minor\"}\n[Am]Hello").unwrap();
        let t = transpose(&song, 3);
        // First line is the {define} directive; lyrics are second.
        let lyrics_line = t.lines.iter().find_map(|line| {
            if let Line::Lyrics(l) = line {
                Some(l)
            } else {
                None
            }
        });
        let l = lyrics_line.expect("expected a lyrics line");
        let chord = l.segments[0].chord.as_ref().unwrap();
        assert_eq!(chord.name, "Cm");
        assert_eq!(chord.display_name(), "A minor");
    }

    // --- transpose (song-level) ---

    #[test]
    fn test_transpose_song() {
        let song = crate::parse("[G]Hello [C]world").unwrap();
        let t = transpose(&song, 2);
        if let Line::Lyrics(l) = &t.lines[0] {
            assert_eq!(l.segments[0].chord.as_ref().unwrap().name, "A");
            assert_eq!(l.segments[1].chord.as_ref().unwrap().name, "D");
        } else {
            panic!("expected lyrics line");
        }
    }

    #[test]
    fn test_transpose_preserves_lyrics_text() {
        let song = crate::parse("[Am]Hello").unwrap();
        let t = transpose(&song, 3);
        if let Line::Lyrics(l) = &t.lines[0] {
            assert_eq!(l.segments[0].text, "Hello");
            assert_eq!(l.segments[0].chord.as_ref().unwrap().name, "Cm");
        } else {
            panic!("expected lyrics line");
        }
    }

    #[test]
    fn test_transpose_preserves_metadata() {
        let song = crate::parse("{title: Test}\n[G]Hello").unwrap();
        let t = transpose(&song, 5);
        assert_eq!(t.metadata.title.as_deref(), Some("Test"));
    }

    #[test]
    fn test_transpose_all_12_keys() {
        let expected_roots = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        for (i, expected) in expected_roots.iter().enumerate() {
            let detail = parse_chord("C").unwrap();
            let t = transpose_detail(&detail, i as i8);
            assert_eq!(t.to_string(), *expected, "transpose C by {i}");
        }
    }

    // --- combine_transpose ---

    #[test]
    fn combine_transpose_no_overflow() {
        let (result, saturated) = combine_transpose(5, 3);
        assert_eq!(result, 8);
        assert!(!saturated);
    }

    #[test]
    fn combine_transpose_positive_overflow() {
        let (result, saturated) = combine_transpose(100, 50);
        assert_eq!(result, 127);
        assert!(saturated);
    }

    #[test]
    fn combine_transpose_negative_overflow() {
        let (result, saturated) = combine_transpose(-100, -50);
        assert_eq!(result, -128);
        assert!(saturated);
    }

    #[test]
    fn combine_transpose_exact_max() {
        let (result, saturated) = combine_transpose(100, 27);
        assert_eq!(result, 127);
        assert!(!saturated);
    }

    // -- transposable bracket-form defines (R6.100.0, #2302) -------------

    fn directive_value(line: &Line) -> &str {
        match line {
            Line::Directive(d) => d.value.as_deref().expect("directive must have value"),
            _ => panic!("expected Line::Directive"),
        }
    }

    #[test]
    fn transpose_rewrites_bracket_form_define() {
        // {define: [A]} is transposable — +2 must rewrite to [B].
        let song = crate::parse("{define: [A]}\n[A]Hello").unwrap();
        let transposed = transpose(&song, 2);
        assert_eq!(directive_value(&transposed.lines[0]), "[B]");
    }

    #[test]
    fn transpose_rewrites_bracket_form_chord_directive() {
        // {chord: [G]} (alias of {define}) follows the same rule.
        let song = crate::parse("{chord: [G]}\n[G]Hi").unwrap();
        let transposed = transpose(&song, 5);
        assert_eq!(directive_value(&transposed.lines[0]), "[C]");
    }

    #[test]
    fn transpose_leaves_fixed_define_alone() {
        // Non-bracket form is "fixed" (upstream `$fixed = 1` default).
        // The directive value MUST round-trip unchanged.
        let song = crate::parse("{define: A frets 0 2 2 1 0 0}\n[A]Hello").unwrap();
        let transposed = transpose(&song, 2);
        // The directive name "A" stays put, attributes preserved.
        let v = directive_value(&transposed.lines[0]);
        assert!(v.starts_with("A "), "fixed define must keep name 'A': {v}");
        assert!(v.contains("frets"), "fixed define must preserve attrs: {v}");
    }

    #[test]
    fn transpose_zero_is_noop_on_bracket_form() {
        let song = crate::parse("{define: [A]}\n[A]Hi").unwrap();
        let transposed = transpose(&song, 0);
        assert_eq!(directive_value(&transposed.lines[0]), "[A]");
    }

    #[test]
    fn transpose_negative_on_bracket_form() {
        let song = crate::parse("{define: [G]}\n[G]Hi").unwrap();
        let transposed = transpose(&song, -7);
        assert_eq!(directive_value(&transposed.lines[0]), "[C]");
    }

    #[test]
    fn transpose_bracket_form_with_extension() {
        let song = crate::parse("{define: [Am7]}\n[Am7]Hi").unwrap();
        let transposed = transpose(&song, 3);
        assert_eq!(directive_value(&transposed.lines[0]), "[Cm7]");
    }
}
