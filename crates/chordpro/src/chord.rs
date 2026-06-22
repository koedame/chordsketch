//! Chord notation parser for structured chord analysis.
//!
//! This module parses chord strings like `"Am"`, `"C#m7"`, `"G/B"`, and
//! `"Dsus4"` into structured components: root note, accidental, quality,
//! extensions, and bass note.
//!
//! Parsing is best-effort: if a chord string cannot be parsed structurally,
//! [`parse_chord`] returns `None` and callers should fall back to storing
//! the raw string only.

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

/// A musical note name (A through G).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Note {
    /// The note C.
    C,
    /// The note D.
    D,
    /// The note E.
    E,
    /// The note F.
    F,
    /// The note G.
    G,
    /// The note A.
    A,
    /// The note B.
    B,
}

impl Note {
    /// Parses a single character into a `Note`, if valid.
    pub(crate) fn from_char(c: char) -> Option<Self> {
        match c {
            'C' => Some(Self::C),
            'D' => Some(Self::D),
            'E' => Some(Self::E),
            'F' => Some(Self::F),
            'G' => Some(Self::G),
            'A' => Some(Self::A),
            'B' => Some(Self::B),
            _ => None,
        }
    }
}

impl core::fmt::Display for Note {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            Self::C => "C",
            Self::D => "D",
            Self::E => "E",
            Self::F => "F",
            Self::G => "G",
            Self::A => "A",
            Self::B => "B",
        };
        f.write_str(s)
    }
}

// ---------------------------------------------------------------------------
// Accidental
// ---------------------------------------------------------------------------

/// A sharp or flat modifier on a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Accidental {
    /// Sharp (`#`).
    Sharp,
    /// Flat (`b`).
    Flat,
}

impl core::fmt::Display for Accidental {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Sharp => f.write_str("#"),
            Self::Flat => f.write_str("b"),
        }
    }
}

// ---------------------------------------------------------------------------
// ChordQuality
// ---------------------------------------------------------------------------

/// The quality (type) of a chord.
///
/// This enum captures the most common chord qualities found in popular music
/// notation. Extended or unusual qualities are handled via the `extension`
/// field on [`ChordDetail`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChordQuality {
    /// Major chord (default when no quality marker is present).
    Major,
    /// Minor chord (`m` or `min`).
    Minor,
    /// Diminished chord (`dim` or `°`).
    Diminished,
    /// Augmented chord (`aug` or `+`).
    Augmented,
}

impl core::fmt::Display for ChordQuality {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Major => Ok(()),
            Self::Minor => f.write_str("m"),
            Self::Diminished => f.write_str("dim"),
            Self::Augmented => f.write_str("aug"),
        }
    }
}

// ---------------------------------------------------------------------------
// ChordDetail
// ---------------------------------------------------------------------------

/// Structured representation of a parsed chord.
///
/// This contains the individual components extracted from a chord string.
/// Not all chords can be parsed into this structure; for unparseable chords
/// the AST [`Chord`](crate::ast::Chord) falls back to storing only the raw
/// string.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord::{ChordDetail, Note, Accidental, ChordQuality, parse_chord};
///
/// let detail = parse_chord("C#m7").unwrap();
/// assert_eq!(detail.root, Note::C);
/// assert_eq!(detail.root_accidental, Some(Accidental::Sharp));
/// assert_eq!(detail.quality, ChordQuality::Minor);
/// assert_eq!(detail.extension.as_deref(), Some("7"));
/// assert!(detail.bass_note.is_none());
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChordDetail {
    /// The root note of the chord (e.g., C, D, E).
    pub root: Note,
    /// An optional sharp or flat on the root note.
    pub root_accidental: Option<Accidental>,
    /// The chord quality (major, minor, diminished, augmented).
    pub quality: ChordQuality,
    /// Optional extension string (e.g., `"7"`, `"maj7"`, `"9"`, `"sus4"`,
    /// `"add9"`, `"7sus4"`).
    ///
    /// Extensions are stored as-is from the source rather than being parsed
    /// into a sub-structure, since the variety of extensions in real-world
    /// chord charts is vast.
    pub extension: Option<String>,
    /// The bass note for slash chords (e.g., `B` in `G/B`).
    pub bass_note: Option<(Note, Option<Accidental>)>,
}

impl core::fmt::Display for ChordDetail {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.root)?;
        if let Some(ref acc) = self.root_accidental {
            write!(f, "{acc}")?;
        }
        write!(f, "{}", self.quality)?;
        if let Some(ref ext) = self.extension {
            f.write_str(ext)?;
        }
        if let Some((ref bass, ref bass_acc)) = self.bass_note {
            write!(f, "/{bass}")?;
            if let Some(acc) = bass_acc {
                write!(f, "{acc}")?;
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Canonical name (R6.100.0 keys.force-common / keys.flats)
// ---------------------------------------------------------------------------

/// 12-tone tables for re-spelling a root semitone, indexed `0..=11`.
///
/// `SHARP_NAMES_TABLE[s]` and `FLAT_NAMES_TABLE[s]` give the conventional
/// sharp / flat enharmonic spellings, respectively.
const SHARP_NAMES_TABLE: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const FLAT_NAMES_TABLE: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
];

/// Convert a root note + accidental into a chromatic semitone index
/// (`0` = C, `11` = B). Used by [`canonicalize_detail`] and mirrored by
/// `transpose::note_to_semitone` (kept private to its module to avoid a
/// cross-module type-coupling commitment).
fn root_semitone(note: Note, accidental: Option<Accidental>) -> u8 {
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

/// Re-spell a parsed [`ChordDetail`] per upstream ChordPro's
/// `keys.force-common` / `keys.flats` rule (R6.100.0). When
/// `force_common` is `false` this is byte-equal to `format!("{detail}")`
/// — the source spelling is preserved.
///
/// Reference: `lib/ChordPro/Chords/Parser.pm` `is_key_toosharp` /
/// `keyname` in upstream R6.100.0.
///
/// **Toosharp set** (always re-spelled to flats under `force_common`):
/// `C#`, `D#`, `G#`, `A#` → `Db`, `Eb`, `Ab`, `Bb`.
///
/// **F#/Gb special case** (controlled by `flats`):
/// - `flats=false` → `F#` (sharp; chordsketch and upstream default)
/// - `flats=true`  → `Gb` (flat)
///
/// **Minor adjustment**: upstream subtracts 3 semitones from the root
/// before consulting the toosharp table when the chord quality is minor
/// (`Parser.pm:863, 883`). This crate follows the upstream rule
/// literally — see the in-source comment on the `match` below.
///
/// Bass notes in slash chords are emitted using the source spelling;
/// upstream's `keyname()` only applies to the chord's primary key, not
/// the bass.
#[must_use]
pub fn canonicalize_detail(detail: &ChordDetail, force_common: bool, flats: bool) -> String {
    if !force_common {
        return format!("{detail}");
    }

    let root_semi = root_semitone(detail.root, detail.root_accidental);
    let key_semi = if detail.quality == ChordQuality::Minor {
        // Upstream `Parser.pm:is_key_toosharp` subtracts 3 from the root
        // ordinal for minor chords before consulting the table. This is
        // mirrored here verbatim — the test corpus in `t/176_transpose.t`
        // pins major-key behaviour explicitly; minor cases follow the same
        // arithmetic.
        (root_semi + 12 - 3) % 12
    } else {
        root_semi
    };

    let toosharp = matches!(key_semi, 1 | 3 | 8 | 10) || (key_semi == 6 && flats);
    let root_name = if toosharp {
        FLAT_NAMES_TABLE[root_semi as usize]
    } else {
        SHARP_NAMES_TABLE[root_semi as usize]
    };

    let mut out = String::with_capacity(detail.extension.as_deref().unwrap_or("").len() + 8);
    out.push_str(root_name);
    use core::fmt::Write as _;
    let _ = write!(&mut out, "{}", detail.quality);
    if let Some(ext) = detail.extension.as_deref() {
        out.push_str(ext);
    }
    if let Some((bass, bass_acc)) = detail.bass_note {
        out.push('/');
        let _ = write!(&mut out, "{bass}");
        if let Some(acc) = bass_acc {
            let _ = write!(&mut out, "{acc}");
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Constituent pitches (MIDI note numbers)
// ---------------------------------------------------------------------------

/// MIDI note number the block voicing places the chord root on (C3).
///
/// Chord tones are stacked above this root; a slash bass is dropped one
/// octave below it. Choosing C3 keeps the common pop/folk vocabulary in
/// a comfortable mid-register for a simple oscillator synth: the lowest
/// tone produced is the slash bass at `36..=47` (C2..B2) and the highest
/// extension (a 13th, +21 semitones, on a root of B3 = 59) reaches 80
/// (G#5), well within the MIDI range.
const VOICING_ROOT_MIDI: u8 = 48;

/// Computes the constituent pitches of a chord as MIDI note numbers.
///
/// Returns `None` when `chord_name` is not parseable as a chord (the same
/// inputs [`parse_chord`] rejects). Otherwise returns the chord's block
/// voicing — root, third, fifth, plus any extension / altered / added
/// tones implied by the chord quality and extension — as ascending,
/// de-duplicated MIDI note numbers. Slash chords prepend the bass note one
/// octave below the root.
///
/// This is the musical-theory source of truth shared by every consumer
/// that needs to *sound* a chord (the wasm / napi / ffi bindings drive the
/// React chord-audio surface from it). It is deliberately independent of
/// the fretted / keyboard voicing database in
/// [`voicings`](crate::voicings): those map a chord to one *instrument's*
/// fingering, whereas this maps a chord to its abstract constituent
/// pitches, so it covers every parseable chord rather than only the
/// shapes the diagram tables enumerate.
///
/// The register is fixed (root at C3); callers that want a different
/// octave transpose the returned notes themselves.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_pitches;
///
/// // C major triad: C3, E3, G3.
/// assert_eq!(chord_pitches("C"), Some(vec![48, 52, 55]));
/// // A minor triad: A3, C4, E4.
/// assert_eq!(chord_pitches("Am"), Some(vec![57, 60, 64]));
/// // Slash chord drops the bass an octave below the root.
/// assert_eq!(chord_pitches("C/G"), Some(vec![43, 48, 52, 55]));
/// // Unparseable input yields None.
/// assert_eq!(chord_pitches("xyz"), None);
/// ```
#[must_use]
pub fn chord_pitches(chord_name: &str) -> Option<Vec<u8>> {
    let detail = parse_chord(chord_name)?;
    let root_pc = root_semitone(detail.root, detail.root_accidental);
    let root_midi = VOICING_ROOT_MIDI + root_pc; // 48..=59

    let mut pitches: Vec<u8> =
        chord_intervals(detail.quality, detail.extension.as_deref().unwrap_or(""))
            .all
            .into_iter()
            .map(|iv| root_midi + iv.semitone)
            .collect();

    if let Some((bass, bass_acc)) = detail.bass_note {
        let bass_pc = root_semitone(bass, bass_acc);
        // One octave below the root's base octave, so the bass is always
        // the lowest sounding note (root_midi is at least 48; the bass is
        // at most 47).
        let bass_midi = (VOICING_ROOT_MIDI - 12) + bass_pc; // 36..=47
        pitches.push(bass_midi);
    }

    pitches.sort_unstable();
    pitches.dedup();
    Some(pitches)
}

// ---------------------------------------------------------------------------
// Key audition (scale + tonic triad)
// ---------------------------------------------------------------------------

/// Ascending semitone offsets, from the tonic, of the eight movable-do
/// scale degrees of a **major** key — do, re, mi, fa, sol, la, ti, do
/// (the seven degrees plus the octave).
const MAJOR_SCALE_SEMITONES: [u8; 8] = [0, 2, 4, 5, 7, 9, 11, 12];

/// Ascending semitone offsets, from the tonic, of the eight movable-do
/// scale degrees of a **natural-minor** key — do, re, me, fa, sol, le,
/// te, do.
const MINOR_SCALE_SEMITONES: [u8; 8] = [0, 2, 3, 5, 7, 8, 10, 12];

/// Parses a ChordPro `{key}` value into its tonic pitch class
/// (`0` = C … `11` = B) and whether the key's tonic triad is minor.
///
/// The value is parsed with the **strict** [`crate::key::parse_key`], the
/// single source of truth for what a well-formed key is — so the scale /
/// tonic-triad audition agrees with the displayed key, the key-signature
/// glyph, and the transpose re-spelling rather than diverging the way the
/// permissive [`parse_chord`] used to (e.g. `{key: G minor}` parsed as a
/// G *major* chord with a junk extension, so a "minor" key auditioned a
/// major scale). A minor key — or a minor-third church mode (dorian /
/// phrygian / aeolian / locrian) — selects the natural-minor scale and a
/// minor tonic triad; major keys and major-third modes select the major
/// scale and triad.
///
/// Returns `None` when `key` is not a well-formed key.
fn parse_key_tonic(key: &str) -> Option<(u8, bool)> {
    let parsed = crate::key::parse_key(key)?;
    let root_pc = root_semitone(parsed.root, parsed.accidental);
    Some((root_pc, parsed.is_minor()))
}

/// Computes the ascending one-octave scale of a musical key as MIDI note
/// numbers, for auditioning the key by ear — the movable-do "do re mi fa
/// sol la ti do".
///
/// `key` is a ChordPro `{key}` value (`"C"`, `"Am"`, `"Bb"`, `"F#m"`, …).
/// Major keys yield the major scale; minor keys — and the minor-third
/// church modes — yield the natural-minor scale (see `parse_key_tonic`).
/// The eight returned notes are the seven scale degrees plus the octave,
/// with the tonic placed at the same C3-based register [`chord_pitches`]
/// uses so a scale and a chord auditioned together share one register.
///
/// This is the musical-theory source of truth for the key-audition
/// surface (the wasm / napi / ffi bindings drive the React key-audio
/// control from it); the *sequencing* of the audition — play the scale,
/// then strum the triad — is a presentation concern owned by the
/// consumer, not encoded here.
///
/// Returns `None` when `key` is not a well-formed key (see
/// [`crate::key::parse_key`]).
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::key_scale_pitches;
///
/// // C major: C3 D3 E3 F3 G3 A3 B3 C4.
/// assert_eq!(key_scale_pitches("C"), Some(vec![48, 50, 52, 53, 55, 57, 59, 60]));
/// // A minor: A3 B3 C4 D4 E4 F4 G4 A4 (natural minor).
/// assert_eq!(key_scale_pitches("Am"), Some(vec![57, 59, 60, 62, 64, 65, 67, 69]));
/// // Unparseable input yields None.
/// assert_eq!(key_scale_pitches("xyz"), None);
/// ```
#[must_use]
pub fn key_scale_pitches(key: &str) -> Option<Vec<u8>> {
    let (root_pc, is_minor) = parse_key_tonic(key)?;
    let root_midi = VOICING_ROOT_MIDI + root_pc; // 48..=59
    let steps = if is_minor {
        MINOR_SCALE_SEMITONES
    } else {
        MAJOR_SCALE_SEMITONES
    };
    // root_midi <= 59 and the largest step is 12, so the octave note is at
    // most 71 — comfortably inside the u8 / MIDI range.
    Some(steps.iter().map(|s| root_midi + s).collect())
}

/// Computes the tonic triad of a musical key as MIDI note numbers — the
/// "do mi sol" block chord strummed after the scale in a key audition.
///
/// Major keys yield a major triad (root, major third, perfect fifth);
/// minor keys yield a minor triad (root, minor third, perfect fifth). The
/// root sits at the same C3-based register as [`key_scale_pitches`] and
/// [`chord_pitches`], so for a bare major / minor key this is identical to
/// `chord_pitches(key)`. The *key's* tonic chord is always a triad, and the
/// strict key grammar (see [`crate::key::parse_key`]) does not admit chord
/// extensions on a key in the first place — `{key: Cmaj7}` is rejected, not
/// reduced.
///
/// Returns `None` when `key` is not a well-formed key.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::key_tonic_triad;
///
/// // C major triad: C3 E3 G3.
/// assert_eq!(key_tonic_triad("C"), Some(vec![48, 52, 55]));
/// // A minor triad: A3 C4 E4.
/// assert_eq!(key_tonic_triad("Am"), Some(vec![57, 60, 64]));
/// // Unparseable input yields None.
/// assert_eq!(key_tonic_triad("xyz"), None);
/// ```
#[must_use]
pub fn key_tonic_triad(key: &str) -> Option<Vec<u8>> {
    let (root_pc, is_minor) = parse_key_tonic(key)?;
    let root_midi = VOICING_ROOT_MIDI + root_pc; // 48..=59
    let third = if is_minor { 3 } else { 4 };
    Some(vec![root_midi, root_midi + third, root_midi + 7])
}

/// A chord tone tagged with its diatonic scale degree and its semitone
/// offset above the root.
///
/// The `degree` fixes the staff LETTER the tone is conventionally spelled
/// on — independent of any accidental — while `semitone` fixes its pitch
/// class. Both are needed to spell a tone correctly for staff notation
/// (e.g. a diminished seventh is degree 7 at 9 semitones, which spells as a
/// double-flat seventh `B𝄫` over a C root, not as a major sixth `A`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScaleTone {
    /// Diatonic degree above the root: 1 = root, 3 = third (or the 2/4 of a
    /// `sus`), 5 = fifth, 6 = sixth, 7 = seventh, 9/11/13 = the compound
    /// tensions. Determines the note letter `(root_letter + (degree - 1))`.
    degree: u8,
    /// Semitones above the root (root `0` included).
    semitone: u8,
}

/// Convenience constructor for a [`ScaleTone`].
const fn tone(degree: u8, semitone: u8) -> ScaleTone {
    ScaleTone { degree, semitone }
}

/// The constituent intervals of a chord, split into the full tone set and
/// the subset that defines the chord's identity.
struct ChordIntervals {
    /// Every tone the chord nominally contains (root included) — the full
    /// stack a piano voicing would play.
    all: Vec<ScaleTone>,
    /// The subset of `all` that a reduced fretboard voicing MUST sound for
    /// the result to be unambiguously this chord: root, third (or `sus`
    /// replacement), the seventh (when present), the single highest named
    /// tension, and any altered / characteristic fifth. The perfect fifth and
    /// the inner (implied) tensions are droppable, mirroring how guitarists
    /// reduce extended chords to fit six strings.
    essential: Vec<ScaleTone>,
}

/// Maps a chord quality + extension string to the semitone intervals (from
/// the root) of its constituent tones, including the root itself (`0`), plus
/// the essential subset a reduced voicing must keep.
///
/// The extension grammar is the lenient one [`parse_quality_and_extension`]
/// produces (e.g. `"7"`, `"maj7"`, `"Maj7"`, `"sus4"`, `"add9"`, `"7sus4"`,
/// `"7b5"`, `"7b9"`, `"7#11"`, `"9"`, `"13"`). Altered tensions (`b9` / `#9`
/// / `#11` / `b13`) and the `alt` dominant produce the altered interval, not
/// the natural one. Unrecognised extensions fall back to the bare triad
/// rather than guessing — a documented, audible-but-safe degradation, not a
/// silent wrong chord.
fn chord_intervals(quality: ChordQuality, ext: &str) -> ChordIntervals {
    // Triad: (third, fifth) intervals above the root.
    let (mut third, mut fifth): (u8, u8) = match quality {
        ChordQuality::Major => (4, 7),
        ChordQuality::Minor => (3, 7),
        ChordQuality::Diminished => (3, 6),
        ChordQuality::Augmented => (4, 8),
    };

    // Power chord ("C5"): root + fifth, no third. Both tones are essential.
    if ext == "5" {
        return ChordIntervals {
            all: vec![tone(1, 0), tone(5, fifth)],
            essential: vec![tone(1, 0), tone(5, fifth)],
        };
    }

    // `sus` replaces the third with a 2nd or 4th. The replacement keeps its
    // own diatonic degree (2 or 4) so it spells on the correct staff letter.
    let mut third_degree = 3u8;
    if ext.contains("sus2") {
        third = 2;
        third_degree = 2;
    } else if ext.contains("sus4") || ext == "sus" {
        third = 5;
        third_degree = 4;
    }

    // Altered fifth. `b5` / `#5` are explicit; the `alt` dominant raises the
    // fifth as part of its altered colour. A diminished / augmented triad's
    // fifth is characteristic even without an explicit alteration token.
    let mut fifth_essential = matches!(quality, ChordQuality::Diminished | ChordQuality::Augmented);
    if ext.contains("b5") {
        fifth = 6;
        fifth_essential = true;
    } else if ext.contains("#5") {
        fifth = 8;
        fifth_essential = true;
    } else if ext.contains("alt") {
        // The `alt` dominant raises the fifth as part of its altered colour,
        // but — unlike an explicit `#5` — the raised fifth is droppable, so it
        // stays out of the essential set (which must fit a 4-string ukulele).
        fifth = 8;
    }

    let mut all_extras: Vec<ScaleTone> = Vec::new();
    let mut ess_extras: Vec<ScaleTone> = Vec::new();

    if let Some(rest) = ext.strip_prefix("add") {
        // Add-tone chord (e.g. "add9"): triad plus the added degree, no
        // seventh. The added tone is the chord's identity, so it is essential.
        if let Some(semi) = degree_to_semitone(rest) {
            // `degree_to_semitone` matches only the bare degree tokens
            // "2"/"4"/"6"/"9"/"11"/"13", so `rest` is exactly that degree.
            let degree: u8 = rest
                .parse()
                .expect("degree_to_semitone only matches numeric degree tokens");
            all_extras.push(tone(degree, semi));
            ess_extras.push(tone(degree, semi));
        }
    } else {
        let has_six = ext.contains('6');
        let has13 = ext.contains("13");
        let has11 = ext.contains("11");
        let has9 = ext.contains('9');
        // A 9th / 11th / 13th implies a seventh — EXCEPT in a "6/9" chord
        // (written `69`), where the 6 marks an added-tone chord carrying the
        // 6th and 9th but no seventh.
        let has_seventh = ext.contains('7') || ((has9 || has11 || has13) && !has_six);
        // An explicit `7` in the token marks an "add the named alteration"
        // chord (`7b9`, `7#11`, `7b13`): only the spelled tension is present,
        // with no implied lower tensions. A headline tension number with no
        // explicit `7` (`9`, `11`, `13`, `maj13`, `m11`, …) is a full stack
        // that implies the tensions below it.
        let stacked = !ext.contains('7');
        // "maj7" / "Maj7" / "maj9" / "maj13" (or the "M7" / "Δ" shorthands)
        // call for a major seventh; bare "maj" does not.
        let major_seventh = has_seventh
            && (ext.contains("maj")
                || ext.contains("Maj")
                || ext.contains("M7")
                || ext.contains('Δ'));
        // A diminished chord that carries a seventh is fully diminished (bb7).
        let dim_seventh = quality == ChordQuality::Diminished && has_seventh;

        if has_seventh {
            // Seventh quality: diminished bb7 (9), major 7th (11), or the
            // dominant / minor 7th (10).
            let seventh = if dim_seventh {
                9
            } else if major_seventh {
                11
            } else {
                10
            };
            all_extras.push(tone(7, seventh));
            ess_extras.push(tone(7, seventh));

            // Ninth: flat / sharp / natural. `alt` implies a sharp ninth.
            let ninth = if ext.contains("b9") {
                Some(13u8)
            } else if ext.contains("#9") || ext.contains("alt") {
                Some(15u8)
            } else if has9 || (stacked && (has11 || has13)) {
                // Explicit 9, or the natural 9 implied below a full 11 / 13.
                Some(14u8)
            } else {
                None
            };
            // Eleventh: sharp / natural.
            let eleventh = if ext.contains("#11") {
                Some(18u8)
            } else if has11 || (stacked && has13) {
                // Explicit 11, or the natural 11 implied below a full 13.
                Some(17u8)
            } else {
                None
            };
            // Thirteenth: flat / natural.
            let thirteenth = if ext.contains("b13") {
                Some(20u8)
            } else if has13 {
                Some(21u8)
            } else {
                None
            };

            if let Some(n) = ninth {
                all_extras.push(tone(9, n));
            }
            if let Some(e) = eleventh {
                all_extras.push(tone(11, e));
            }
            if let Some(t) = thirteenth {
                all_extras.push(tone(13, t));
            }

            // The single highest named tension is the chord's headline colour
            // and must survive a reduced voicing; the tensions below it are
            // droppable.
            if let Some(t) = thirteenth {
                ess_extras.push(tone(13, t));
            } else if let Some(e) = eleventh {
                ess_extras.push(tone(11, e));
            } else if let Some(n) = ninth {
                ess_extras.push(tone(9, n));
            }
        } else if has9 {
            // Reachable only for a "6/9" chord (the `has_six` guard above
            // suppresses the implied seventh): add the 9th alongside the 6th.
            all_extras.push(tone(9, 14));
            ess_extras.push(tone(9, 14));
        }

        // A sixth (e.g. "C6", "Am6", "C69") adds the major sixth, which is the
        // chord's defining colour.
        if has_six {
            all_extras.push(tone(6, 9));
            ess_extras.push(tone(6, 9));
        }
    }

    let mut all = vec![tone(1, 0), tone(third_degree, third), tone(5, fifth)];
    all.extend_from_slice(&all_extras);

    let mut essential = vec![tone(1, 0), tone(third_degree, third)];
    if fifth_essential {
        essential.push(tone(5, fifth));
    }
    essential.extend_from_slice(&ess_extras);

    ChordIntervals { all, essential }
}

/// The pitch-class content of a chord, used to synthesise fretboard and
/// keyboard voicings for chords with no curated entry in the built-in
/// database. Pitch classes are `0..=11` (`0` = C), independent of octave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChordTones {
    /// Pitch class of the chord root.
    pub root_pc: u8,
    /// Pitch class of the bass note — the slash bass for a slash chord, the
    /// root otherwise.
    pub bass_pc: u8,
    /// Every pitch class the chord nominally contains (root, third, fifth,
    /// seventh, tensions, and the bass), sorted and de-duplicated.
    pub pitch_classes: Vec<u8>,
    /// The pitch classes a voicing MUST sound to be unambiguously this chord
    /// (root, third / `sus`, seventh, the headline tension, any altered
    /// fifth, and the bass), sorted and de-duplicated. Always a subset of
    /// [`pitch_classes`](Self::pitch_classes).
    pub essential: Vec<u8>,
}

/// Computes the [`ChordTones`] of a chord name, or `None` when the name is not
/// a parseable chord.
///
/// This is the pitch-class companion to [`chord_pitches`]: where that function
/// returns absolute MIDI notes for audio, this returns octave-independent
/// pitch classes plus the essential subset, which the voicing synthesiser in
/// [`crate::voicings`] searches the fretboard against.
///
/// ```
/// use chordsketch_chordpro::chord::chord_tones;
///
/// let t = chord_tones("Cmaj7").unwrap();
/// assert_eq!(t.root_pc, 0);
/// assert_eq!(t.pitch_classes, vec![0, 4, 7, 11]);
/// // The fifth (7) is droppable; root, third, and the major seventh are not.
/// assert_eq!(t.essential, vec![0, 4, 11]);
///
/// assert!(chord_tones("not-a-chord").is_none());
/// ```
#[must_use]
pub fn chord_tones(chord_name: &str) -> Option<ChordTones> {
    let detail = parse_chord(chord_name)?;
    let root_pc = root_semitone(detail.root, detail.root_accidental);
    let intervals = chord_intervals(detail.quality, detail.extension.as_deref().unwrap_or(""));

    let bass_pc = match detail.bass_note {
        Some((bass, bass_acc)) => root_semitone(bass, bass_acc),
        None => root_pc,
    };

    let to_pcs = |ivs: &[ScaleTone]| {
        let mut v: Vec<u8> = ivs.iter().map(|t| (root_pc + t.semitone) % 12).collect();
        // A slash bass that is not already a chord tone still has to be voiced
        // and is part of the chord's identity.
        v.push(bass_pc);
        v.sort_unstable();
        v.dedup();
        v
    };

    Some(ChordTones {
        root_pc,
        bass_pc,
        pitch_classes: to_pcs(&intervals.all),
        essential: to_pcs(&intervals.essential),
    })
}

// ---------------------------------------------------------------------------
// Staff notation placement
// ---------------------------------------------------------------------------

/// MIDI note number the staff layout places the chord root on (C4, middle C).
///
/// Unlike [`chord_pitches`] — which fixes the root at C3 for a comfortable
/// synth register — staff display centres the root around middle C so a
/// typical chord's tones sit on or near the treble staff (bottom line E4,
/// top line F5) with few ledger lines.
const STAFF_ROOT_MIDI: i32 = 60;

/// The seven natural-note pitch classes, indexed by diatonic letter
/// (`0` = C, `1` = D, … `6` = B).
const LETTER_PITCH_CLASSES: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];

/// The seven note letters, indexed as in [`LETTER_PITCH_CLASSES`].
const LETTER_NAMES: [char; 7] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/// Diatonic letter index of a [`Note`] (`C` = 0, `D` = 1, … `B` = 6).
const fn letter_index(note: Note) -> i32 {
    match note {
        Note::C => 0,
        Note::D => 1,
        Note::E => 2,
        Note::F => 3,
        Note::G => 4,
        Note::A => 5,
        Note::B => 6,
    }
}

/// A chord tone placed for staff notation: its diatonic spelling (note
/// letter + accidental) and octave, ready for a renderer to position on a
/// five-line staff.
///
/// The tone is spelled from the chord's own structure — its diatonic degree
/// fixes the letter — so each note lands on the staff line/space a musician
/// expects (e.g. `Ebm7` → E♭ G♭ B♭ D♭, not the enharmonic D♯ F♯ A♯ C♯).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaffNote {
    /// The note letter the tone is spelled on, `'A'..='G'`.
    pub letter: char,
    /// The accidental applied to `letter`, as a signed semitone offset:
    /// `-2` double-flat, `-1` flat, `0` natural, `1` sharp, `2` double-sharp.
    pub accidental: i8,
    /// Scientific-pitch-notation octave (middle C = C4, so `octave == 4`).
    pub octave: i8,
    /// Absolute MIDI note number, consistent with `letter` + `accidental` +
    /// `octave`. Lets a consumer cross-check the spelling or drive audio.
    pub midi: u8,
}

/// Picks the octave (in diatonic letter-step terms) for a letter so its
/// natural pitch sits as close as possible to `target_midi`. Rounding to the
/// nearest octave keeps the resulting accidental small (≈ -2..=2) and places
/// enharmonic spellings such as `Cb` / `B#` in the correct register.
fn root_octave_for(letter_idx: i32, target_midi: i32) -> i32 {
    let natural_pc = LETTER_PITCH_CLASSES[letter_idx as usize];
    // natural_midi = (octave + 1) * 12 + natural_pc; solve for octave and
    // round so the chosen octave minimises |target_midi - natural_midi|.
    let raw = f64::from(target_midi - natural_pc) / 12.0 - 1.0;
    raw.round() as i32
}

/// Places a diatonic staff step (`letter_index + 7 * octave`) at the exact
/// pitch `target_midi`, deriving the accidental as the signed difference
/// between the target and the letter's natural pitch at that octave. The
/// returned [`StaffNote`]'s `midi` therefore always equals `target_midi`.
fn place_step(step: i32, target_midi: i32) -> StaffNote {
    let letter_idx = step.rem_euclid(7) as usize;
    let octave = step.div_euclid(7);
    let natural_midi = (octave + 1) * 12 + LETTER_PITCH_CLASSES[letter_idx];
    StaffNote {
        letter: LETTER_NAMES[letter_idx],
        accidental: (target_midi - natural_midi) as i8,
        octave: octave as i8,
        // The chord-tone range is provably 47..=92 (slash bass at C2 through a
        // 13th over a B root), well inside the MIDI byte; clamp defensively so
        // a future interval change can never wrap the cast.
        midi: target_midi.clamp(0, 127) as u8,
    }
}

/// Diatonic staff placement of a chord's constituent tones, spelled from the
/// chord's own structure so each tone lands on its conventional staff
/// line/space.
///
/// Returns the tones ascending by pitch (a slash bass, dropped an octave
/// below the root, sorts first). Returns `None` when `chord_name` is not a
/// parseable chord — the same inputs [`parse_chord`] rejects.
///
/// This is the spelling companion to [`chord_pitches`] (MIDI for audio) and
/// [`chord_tones`] (octave-independent pitch classes for voicing synthesis):
/// where those discard letter spelling, this keeps it, which is exactly what
/// a staff renderer needs to choose the right line for each note. The root is
/// centred at middle C (see `STAFF_ROOT_MIDI`).
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_staff_notes;
///
/// let notes = chord_staff_notes("Cmaj9").unwrap();
/// let spelled: Vec<(char, i8)> = notes.iter().map(|n| (n.letter, n.accidental)).collect();
/// // C E G B D — all naturals, each on its own staff letter.
/// assert_eq!(spelled, vec![('C', 0), ('E', 0), ('G', 0), ('B', 0), ('D', 0)]);
///
/// // Flat-side chords spell with flats, not the enharmonic sharps.
/// let ebm7 = chord_staff_notes("Ebm7").unwrap();
/// let letters: Vec<char> = ebm7.iter().map(|n| n.letter).collect();
/// assert_eq!(letters, vec!['E', 'G', 'B', 'D']);
/// assert!(ebm7.iter().all(|n| n.accidental == -1));
///
/// assert!(chord_staff_notes("not-a-chord").is_none());
/// ```
#[must_use]
pub fn chord_staff_notes(chord_name: &str) -> Option<Vec<StaffNote>> {
    let detail = parse_chord(chord_name)?;
    let root_pc = i32::from(root_semitone(detail.root, detail.root_accidental));
    let root_letter = letter_index(detail.root);
    let root_midi = STAFF_ROOT_MIDI + root_pc;

    // Diatonic position of the root, counted in letter-steps. Choosing the
    // octave by `root_octave_for` keeps the root's accidental small and pins
    // its MIDI to `root_midi` regardless of how the root is spelled.
    let root_step = root_letter + 7 * root_octave_for(root_letter, root_midi);

    let intervals = chord_intervals(detail.quality, detail.extension.as_deref().unwrap_or(""));

    let mut notes: Vec<StaffNote> = intervals
        .all
        .iter()
        .map(|t| {
            // Stack each tone its diatonic degree above the root letter and
            // place it at the exact pitch `root_midi + semitone`.
            let step = root_step + i32::from(t.degree - 1);
            place_step(step, root_midi + i32::from(t.semitone))
        })
        .collect();

    // A slash bass that is not already a chord tone is part of the chord's
    // identity; drop it an octave below the root so it is the lowest note,
    // matching `chord_pitches`.
    if let Some((bass, bass_acc)) = detail.bass_note {
        let bass_pc = i32::from(root_semitone(bass, bass_acc));
        let bass_letter = letter_index(bass);
        let bass_midi = (STAFF_ROOT_MIDI - 12) + bass_pc;
        let bass_step = bass_letter + 7 * root_octave_for(bass_letter, bass_midi);
        notes.push(place_step(bass_step, bass_midi));
    }

    notes.sort_by_key(|n| (n.midi, n.letter, n.accidental));
    notes.dedup();
    Some(notes)
}

/// Maps an extension degree token (the tail of an `add` chord, e.g. `"9"`)
/// to its semitone interval above the root. Returns `None` for tokens that
/// are not recognised added degrees.
fn degree_to_semitone(degree: &str) -> Option<u8> {
    match degree {
        "2" => Some(2),
        "4" => Some(5),
        "6" => Some(9),
        "9" => Some(14),
        "11" => Some(17),
        "13" => Some(21),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// Parses a chord string into a [`ChordDetail`].
///
/// Returns `None` if the string cannot be recognized as a valid chord
/// notation. This function is intentionally lenient: it extracts as much
/// structure as it can, and stores remaining text as the extension.
///
/// # Supported formats
///
/// - Basic chords: `C`, `Am`, `G`
/// - Accidentals: `C#`, `Db`, `F#m`
/// - Extended chords: `Cmaj7`, `Am7`, `G9`, `Dsus4`, `Cadd9`
/// - Slash chords: `G/B`, `C/E`, `Am7/G`
/// - Diminished/augmented: `Bdim`, `Cdim7`, `Faug`, `C+`
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord::{parse_chord, Note, ChordQuality};
///
/// let detail = parse_chord("Am").unwrap();
/// assert_eq!(detail.root, Note::A);
/// assert_eq!(detail.quality, ChordQuality::Minor);
///
/// // Unparseable strings return None
/// assert!(parse_chord("").is_none());
/// assert!(parse_chord("xyz").is_none());
/// ```
#[must_use]
pub fn parse_chord(input: &str) -> Option<ChordDetail> {
    let mut chars = input.chars().peekable();

    // --- Root note ---
    let root = Note::from_char(*chars.peek()?)?;
    chars.next();

    // --- Root accidental ---
    let root_accidental = match chars.peek() {
        Some('#') => {
            chars.next();
            Some(Accidental::Sharp)
        }
        Some('b') => {
            // Distinguish 'b' as flat from 'b' starting a quality/extension.
            // 'b' is flat only when it is NOT the start of a recognized
            // quality or extension token that begins with 'b'. In practice,
            // after a root note, 'b' is always flat because quality markers
            // don't start with 'b' (minor = 'm', dim = 'd', aug = 'a').
            // However, the note 'B' followed by 'b' (like in "Bb") is flat.
            chars.next();
            Some(Accidental::Flat)
        }
        _ => None,
    };

    // Collect the remaining characters (before any slash for bass note).
    let rest: String = chars.collect();

    // --- Split off bass note (slash chord) ---
    let (quality_ext_str, bass_str) = if let Some(slash_pos) = rest.find('/') {
        let (before, after) = rest.split_at(slash_pos);
        // `after` starts with '/', skip it.
        (before, Some(&after[1..]))
    } else {
        (rest.as_str(), None)
    };

    // --- Parse bass note ---
    let bass_note = if let Some(bass) = bass_str {
        parse_note_with_accidental(bass)
    } else {
        None
    };

    // If a bass string was given but couldn't be parsed, the chord is invalid.
    if bass_str.is_some() && bass_note.is_none() {
        // Could be something like "G/unknown" — treat as unparseable.
        // Exception: empty bass string (trailing slash) is also invalid.
        return None;
    }

    // --- Parse quality and extension from the remaining string ---
    let (quality, extension) = parse_quality_and_extension(quality_ext_str);

    Some(ChordDetail {
        root,
        root_accidental,
        quality,
        extension,
        bass_note,
    })
}

/// Parses a note letter optionally followed by `#` or `b`, rejecting any
/// trailing characters. Shared with the strict key parser
/// ([`crate::key::parse_key`]) so bass-note parsing has one implementation.
pub(crate) fn parse_note_with_accidental(s: &str) -> Option<(Note, Option<Accidental>)> {
    let mut chars = s.chars();
    let note = Note::from_char(chars.next()?)?;
    let accidental = match chars.next() {
        Some('#') => Some(Accidental::Sharp),
        Some('b') => Some(Accidental::Flat),
        Some(_) => return None, // unexpected character after note
        None => None,
    };
    // There should be nothing left after note + optional accidental.
    if chars.next().is_some() {
        return None;
    }
    Some((note, accidental))
}

/// Parses the quality and extension from the portion of a chord string after
/// the root note and accidental, but before any slash.
///
/// Returns `(quality, extension)`.
fn parse_quality_and_extension(s: &str) -> (ChordQuality, Option<String>) {
    if s.is_empty() {
        return (ChordQuality::Major, None);
    }

    // Try to match quality prefixes in order of specificity (longest first).
    // Note: we must be careful with "m" — it can be the start of "maj" or "min"
    // which have different meanings.

    // Diminished
    if let Some(rest) = s.strip_prefix("dim") {
        let ext = non_empty_string(rest);
        return (ChordQuality::Diminished, ext);
    }

    // Augmented (word form)
    if let Some(rest) = s.strip_prefix("aug") {
        let ext = non_empty_string(rest);
        return (ChordQuality::Augmented, ext);
    }

    // Augmented (symbol form: "+")
    if let Some(rest) = s.strip_prefix('+') {
        let ext = non_empty_string(rest);
        return (ChordQuality::Augmented, ext);
    }

    // "min" — minor (before "m" to avoid premature match)
    if let Some(rest) = s.strip_prefix("min") {
        let ext = non_empty_string(rest);
        return (ChordQuality::Minor, ext);
    }

    // "maj" — major with an extension (e.g., "maj7")
    if let Some(rest) = s.strip_prefix("maj") {
        // "maj" by itself or "maj7", "maj9", etc.
        let ext = if rest.is_empty() {
            Some("maj".to_string())
        } else {
            Some(format!("maj{rest}"))
        };
        return (ChordQuality::Major, ext);
    }

    // "m" — minor (must come after "maj" and "min" checks)
    if let Some(rest) = s.strip_prefix('m') {
        // Make sure 'm' is not followed by something that indicates it's not
        // a minor marker. For chord notation, 'm' is always minor.
        let ext = non_empty_string(rest);
        return (ChordQuality::Minor, ext);
    }

    // "sus" — treated as major with sus extension
    if s.starts_with("sus") {
        return (ChordQuality::Major, Some(s.to_string()));
    }

    // "add" — treated as major with add extension
    if s.starts_with("add") {
        return (ChordQuality::Major, Some(s.to_string()));
    }

    // Numeric extension on a major chord (e.g., "7", "9", "11", "13", "6")
    if s.starts_with(|c: char| c.is_ascii_digit()) {
        return (ChordQuality::Major, Some(s.to_string()));
    }

    // "°" — diminished symbol
    if let Some(rest) = s.strip_prefix('°') {
        let ext = non_empty_string(rest);
        return (ChordQuality::Diminished, ext);
    }

    // If nothing matched, store the entire remaining string as extension
    // on a major chord. This handles unusual notations gracefully.
    (ChordQuality::Major, Some(s.to_string()))
}

/// Returns `Some(s.to_string())` if `s` is non-empty, otherwise `None`.
fn non_empty_string(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Helper --------------------------------------------------------------

    /// Shorthand: parse and unwrap.
    fn pd(input: &str) -> ChordDetail {
        parse_chord(input).unwrap_or_else(|| panic!("expected Some for chord '{input}'"))
    }

    // -- Staff notation placement -------------------------------------------

    /// `(letter, accidental, octave)` triples for the spelled chord tones.
    fn staff_spelling(chord: &str) -> Vec<(char, i8, i8)> {
        chord_staff_notes(chord)
            .unwrap_or_else(|| panic!("expected Some for chord '{chord}'"))
            .into_iter()
            .map(|n| (n.letter, n.accidental, n.octave))
            .collect()
    }

    #[test]
    fn staff_notes_reject_unparseable() {
        assert!(chord_staff_notes("not-a-chord").is_none());
        assert!(chord_staff_notes("").is_none());
    }

    #[test]
    fn staff_notes_major_triad_all_naturals() {
        // C major: C E G, each on its own staff letter, no accidentals, root
        // at middle C (C4).
        assert_eq!(
            staff_spelling("C"),
            vec![('C', 0, 4), ('E', 0, 4), ('G', 0, 4)]
        );
    }

    #[test]
    fn staff_notes_extended_chord_keeps_diatonic_letters() {
        // Cmaj9 stacks C E G B D — five distinct staff letters, the 9th an
        // octave up on D5.
        assert_eq!(
            staff_spelling("Cmaj9"),
            vec![
                ('C', 0, 4),
                ('E', 0, 4),
                ('G', 0, 4),
                ('B', 0, 4),
                ('D', 0, 5),
            ]
        );
    }

    #[test]
    fn staff_notes_flat_chord_spells_with_flats() {
        // Ebm7 must spell E♭ G♭ B♭ D♭, NOT the enharmonic D♯ F♯ A♯ C♯ — the
        // letters land on E/G/B/D staff lines with flats.
        assert_eq!(
            staff_spelling("Ebm7"),
            vec![('E', -1, 4), ('G', -1, 4), ('B', -1, 4), ('D', -1, 5),]
        );
    }

    #[test]
    fn staff_notes_diminished_seventh_double_flat() {
        // Cdim7 = C E♭ G♭ B𝄫: the diminished seventh spells as a double-flat
        // seventh (degree 7), not as the enharmonic natural sixth (A).
        assert_eq!(
            staff_spelling("Cdim7"),
            vec![('C', 0, 4), ('E', -1, 4), ('G', -1, 4), ('B', -2, 4),]
        );
    }

    #[test]
    fn staff_notes_sus_chords_use_second_and_fourth_letters() {
        // Csus2 → C D G (2nd on the D letter); Csus4 → C F G (4th on F).
        assert_eq!(
            staff_spelling("Csus2"),
            vec![('C', 0, 4), ('D', 0, 4), ('G', 0, 4)]
        );
        assert_eq!(
            staff_spelling("Csus4"),
            vec![('C', 0, 4), ('F', 0, 4), ('G', 0, 4)]
        );
    }

    #[test]
    fn staff_notes_slash_bass_sorts_below_root() {
        // C/G drops the bass G an octave below the root so it is the lowest
        // note (G3), then C E G of the triad above.
        let notes = chord_staff_notes("C/G").unwrap();
        assert_eq!(notes.first().map(|n| (n.letter, n.octave)), Some(('G', 3)));
        // Ascending by MIDI.
        assert!(notes.windows(2).all(|w| w[0].midi <= w[1].midi));
        assert_eq!(notes.first().unwrap().midi, 55); // G3
    }

    #[test]
    fn staff_notes_midi_matches_spelling() {
        // The reported MIDI must equal the pitch implied by letter + accidental
        // + octave for every tone, across a spread of chord types.
        for chord in ["C", "Am7", "F#7b9", "Bbmaj13", "G/B", "Cdim7", "Dsus4"] {
            for n in chord_staff_notes(chord).unwrap() {
                let natural_pc =
                    LETTER_PITCH_CLASSES[LETTER_NAMES.iter().position(|&c| c == n.letter).unwrap()];
                let expected =
                    (i32::from(n.octave) + 1) * 12 + natural_pc + i32::from(n.accidental);
                assert_eq!(
                    i32::from(n.midi),
                    expected,
                    "midi/spelling mismatch for {chord}: {n:?}"
                );
            }
        }
    }

    #[test]
    fn staff_notes_enharmonic_roots_land_in_register() {
        // B# spells on the B letter (sharp) and Cb on the C letter (flat),
        // each still pitched near middle C rather than an octave off.
        let bsharp = chord_staff_notes("B#").unwrap();
        assert_eq!(bsharp[0].letter, 'B');
        assert_eq!(bsharp[0].accidental, 1);
        assert_eq!(bsharp[0].midi, 60); // B#3 == C4 pitch

        let cflat = chord_staff_notes("Cb").unwrap();
        assert_eq!(cflat[0].letter, 'C');
        assert_eq!(cflat[0].accidental, -1);
        assert_eq!(cflat[0].midi, 71); // Cb5 == B4 pitch
    }

    #[test]
    fn staff_notes_cover_every_root_and_quality() {
        // Smoke: every root × a spread of qualities yields a non-empty, in-range
        // placement with small accidentals — no panic, no wild spelling.
        for root in ["C", "D", "E", "F", "G", "A", "B", "Bb", "F#", "C#", "Ab"] {
            for suffix in [
                "", "m", "7", "maj7", "m7b5", "dim7", "aug", "sus4", "13", "6",
            ] {
                let chord = format!("{root}{suffix}");
                let notes = chord_staff_notes(&chord)
                    .unwrap_or_else(|| panic!("expected Some for {chord}"));
                assert!(!notes.is_empty(), "no notes for {chord}");
                for n in notes {
                    assert!(
                        (-2..=2).contains(&n.accidental),
                        "wild accidental for {chord}: {n:?}"
                    );
                    assert!(
                        (36..=96).contains(&n.midi),
                        "out-of-register {chord}: {n:?}"
                    );
                }
            }
        }
    }

    // -- Basic major chords --------------------------------------------------

    #[test]
    fn basic_major_chords() {
        for (input, expected_root) in [
            ("C", Note::C),
            ("D", Note::D),
            ("E", Note::E),
            ("F", Note::F),
            ("G", Note::G),
            ("A", Note::A),
            ("B", Note::B),
        ] {
            let detail = pd(input);
            assert_eq!(detail.root, expected_root, "root for '{input}'");
            assert_eq!(detail.root_accidental, None, "accidental for '{input}'");
            assert_eq!(detail.quality, ChordQuality::Major, "quality for '{input}'");
            assert_eq!(detail.extension, None, "extension for '{input}'");
            assert_eq!(detail.bass_note, None, "bass for '{input}'");
        }
    }

    // -- Minor chords --------------------------------------------------------

    #[test]
    fn minor_chords() {
        let detail = pd("Am");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.extension, None);

        let detail = pd("Em");
        assert_eq!(detail.root, Note::E);
        assert_eq!(detail.quality, ChordQuality::Minor);

        let detail = pd("Dm");
        assert_eq!(detail.root, Note::D);
        assert_eq!(detail.quality, ChordQuality::Minor);
    }

    #[test]
    fn minor_with_min_suffix() {
        let detail = pd("Amin");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.extension, None);
    }

    // -- Accidentals ---------------------------------------------------------

    #[test]
    fn sharp_major() {
        let detail = pd("C#");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.root_accidental, Some(Accidental::Sharp));
        assert_eq!(detail.quality, ChordQuality::Major);
    }

    #[test]
    fn flat_major() {
        let detail = pd("Db");
        assert_eq!(detail.root, Note::D);
        assert_eq!(detail.root_accidental, Some(Accidental::Flat));
        assert_eq!(detail.quality, ChordQuality::Major);
    }

    #[test]
    fn sharp_minor() {
        let detail = pd("F#m");
        assert_eq!(detail.root, Note::F);
        assert_eq!(detail.root_accidental, Some(Accidental::Sharp));
        assert_eq!(detail.quality, ChordQuality::Minor);
    }

    #[test]
    fn flat_minor() {
        let detail = pd("Bbm");
        assert_eq!(detail.root, Note::B);
        assert_eq!(detail.root_accidental, Some(Accidental::Flat));
        assert_eq!(detail.quality, ChordQuality::Minor);
    }

    #[test]
    fn bb_flat() {
        let detail = pd("Bb");
        assert_eq!(detail.root, Note::B);
        assert_eq!(detail.root_accidental, Some(Accidental::Flat));
        assert_eq!(detail.quality, ChordQuality::Major);
    }

    // -- Extended chords -----------------------------------------------------

    #[test]
    fn major_seventh() {
        let detail = pd("Cmaj7");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("maj7"));
    }

    #[test]
    fn minor_seventh() {
        let detail = pd("Am7");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.extension.as_deref(), Some("7"));
    }

    #[test]
    fn dominant_seventh() {
        let detail = pd("G7");
        assert_eq!(detail.root, Note::G);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("7"));
    }

    #[test]
    fn ninth_chord() {
        let detail = pd("G9");
        assert_eq!(detail.root, Note::G);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("9"));
    }

    #[test]
    fn sus4() {
        let detail = pd("Dsus4");
        assert_eq!(detail.root, Note::D);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("sus4"));
    }

    #[test]
    fn sus2() {
        let detail = pd("Asus2");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("sus2"));
    }

    #[test]
    fn add9() {
        let detail = pd("Cadd9");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("add9"));
    }

    #[test]
    fn minor_major_seventh() {
        // Cm followed by "maj7" — the 'm' is consumed as minor, then "aj7"
        // becomes the extension. This is a known limitation.
        // Actually let's check what happens:
        let detail = pd("Cmmaj7");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Minor);
        // After stripping 'm', rest is "maj7"
        assert_eq!(detail.extension.as_deref(), Some("maj7"));
    }

    #[test]
    fn seventh_sus4() {
        let detail = pd("G7sus4");
        assert_eq!(detail.root, Note::G);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("7sus4"));
    }

    #[test]
    fn sixth_chord() {
        let detail = pd("C6");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("6"));
    }

    #[test]
    fn minor_sixth() {
        let detail = pd("Am6");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.extension.as_deref(), Some("6"));
    }

    #[test]
    fn eleventh_chord() {
        let detail = pd("G11");
        assert_eq!(detail.root, Note::G);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("11"));
    }

    #[test]
    fn thirteenth_chord() {
        let detail = pd("C13");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("13"));
    }

    // -- Diminished and augmented --------------------------------------------

    #[test]
    fn diminished() {
        let detail = pd("Bdim");
        assert_eq!(detail.root, Note::B);
        assert_eq!(detail.quality, ChordQuality::Diminished);
        assert_eq!(detail.extension, None);
    }

    #[test]
    fn diminished_seventh() {
        let detail = pd("Cdim7");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Diminished);
        assert_eq!(detail.extension.as_deref(), Some("7"));
    }

    #[test]
    fn diminished_symbol() {
        let detail = pd("B°");
        assert_eq!(detail.root, Note::B);
        assert_eq!(detail.quality, ChordQuality::Diminished);
        assert_eq!(detail.extension, None);
    }

    #[test]
    fn augmented() {
        let detail = pd("Faug");
        assert_eq!(detail.root, Note::F);
        assert_eq!(detail.quality, ChordQuality::Augmented);
        assert_eq!(detail.extension, None);
    }

    #[test]
    fn augmented_plus_symbol() {
        let detail = pd("C+");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Augmented);
        assert_eq!(detail.extension, None);
    }

    #[test]
    fn augmented_seventh() {
        let detail = pd("Caug7");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Augmented);
        assert_eq!(detail.extension.as_deref(), Some("7"));
    }

    // -- Slash chords --------------------------------------------------------

    #[test]
    fn slash_chord_simple() {
        let detail = pd("G/B");
        assert_eq!(detail.root, Note::G);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.bass_note, Some((Note::B, None)));
    }

    #[test]
    fn slash_chord_minor() {
        let detail = pd("Am/E");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.bass_note, Some((Note::E, None)));
    }

    #[test]
    fn slash_chord_with_accidental_bass() {
        let detail = pd("C/Bb");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.bass_note, Some((Note::B, Some(Accidental::Flat))));
    }

    #[test]
    fn slash_chord_with_sharp_bass() {
        let detail = pd("Am/G#");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.bass_note, Some((Note::G, Some(Accidental::Sharp))));
    }

    #[test]
    fn slash_chord_extended() {
        let detail = pd("Am7/G");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.extension.as_deref(), Some("7"));
        assert_eq!(detail.bass_note, Some((Note::G, None)));
    }

    #[test]
    fn slash_chord_sharp_root() {
        let detail = pd("F#m/E");
        assert_eq!(detail.root, Note::F);
        assert_eq!(detail.root_accidental, Some(Accidental::Sharp));
        assert_eq!(detail.quality, ChordQuality::Minor);
        assert_eq!(detail.bass_note, Some((Note::E, None)));
    }

    // -- Invalid / unparseable -----------------------------------------------

    #[test]
    fn empty_string() {
        assert!(parse_chord("").is_none());
    }

    #[test]
    fn lowercase_root() {
        // Chord roots must be uppercase.
        assert!(parse_chord("am").is_none());
    }

    #[test]
    fn non_note_root() {
        assert!(parse_chord("Hm").is_none());
        assert!(parse_chord("X").is_none());
    }

    #[test]
    fn numeric_only() {
        assert!(parse_chord("7").is_none());
    }

    #[test]
    fn slash_with_invalid_bass() {
        assert!(parse_chord("G/X").is_none());
        assert!(parse_chord("G/").is_none());
    }

    #[test]
    fn slash_bass_too_long() {
        // Bass should be just a note + optional accidental.
        assert!(parse_chord("G/Bm").is_none());
    }

    #[test]
    fn multi_slash_is_invalid() {
        // Multiple slashes: split on first slash so bass becomes "D/E",
        // which is not a valid note+accidental. The chord is unparseable.
        assert!(parse_chord("C/D/E").is_none());
    }

    // -- Display (round-trip) ------------------------------------------------

    #[test]
    fn display_basic_major() {
        assert_eq!(pd("C").to_string(), "C");
    }

    #[test]
    fn display_minor() {
        assert_eq!(pd("Am").to_string(), "Am");
    }

    #[test]
    fn display_sharp_minor_seventh() {
        assert_eq!(pd("C#m7").to_string(), "C#m7");
    }

    #[test]
    fn display_slash_chord() {
        assert_eq!(pd("G/B").to_string(), "G/B");
    }

    #[test]
    fn display_flat_chord() {
        assert_eq!(pd("Bb").to_string(), "Bb");
    }

    #[test]
    fn display_diminished() {
        assert_eq!(pd("Bdim").to_string(), "Bdim");
    }

    #[test]
    fn display_augmented() {
        assert_eq!(pd("Faug").to_string(), "Faug");
    }

    #[test]
    fn display_sus4() {
        assert_eq!(pd("Dsus4").to_string(), "Dsus4");
    }

    #[test]
    fn display_slash_with_accidental() {
        assert_eq!(pd("C/Bb").to_string(), "C/Bb");
    }

    #[test]
    fn display_complex_chord() {
        assert_eq!(pd("F#m7/E").to_string(), "F#m7/E");
    }

    // -- Edge cases ----------------------------------------------------------

    #[test]
    fn maj_alone() {
        // "Cmaj" — major quality with "maj" as extension
        let detail = pd("Cmaj");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("maj"));
    }

    #[test]
    fn maj9() {
        let detail = pd("Cmaj9");
        assert_eq!(detail.root, Note::C);
        assert_eq!(detail.quality, ChordQuality::Major);
        assert_eq!(detail.extension.as_deref(), Some("maj9"));
    }

    #[test]
    fn sharp_augmented() {
        let detail = pd("G#+");
        assert_eq!(detail.root, Note::G);
        assert_eq!(detail.root_accidental, Some(Accidental::Sharp));
        assert_eq!(detail.quality, ChordQuality::Augmented);
    }

    #[test]
    fn flat_diminished() {
        let detail = pd("Ebdim");
        assert_eq!(detail.root, Note::E);
        assert_eq!(detail.root_accidental, Some(Accidental::Flat));
        assert_eq!(detail.quality, ChordQuality::Diminished);
    }

    #[test]
    fn minor_add9() {
        let detail = pd("Amadd9");
        assert_eq!(detail.root, Note::A);
        assert_eq!(detail.quality, ChordQuality::Minor);
        // After stripping 'm', rest is "add9"
        assert_eq!(detail.extension.as_deref(), Some("add9"));
    }

    #[test]
    fn empty_bass_string_is_invalid() {
        // A trailing slash with no bass note should be rejected.
        assert!(parse_chord("G/").is_none());
    }

    // -- canonicalize_detail (R6.100.0 keys.force-common, #2300) ---------

    fn canon(input: &str, force_common: bool, flats: bool) -> String {
        let detail = parse_chord(input).expect("input must parse");
        canonicalize_detail(&detail, force_common, flats)
    }

    #[test]
    fn force_common_off_preserves_input_spelling() {
        // When force-common is disabled, output is byte-equal to
        // `format!("{detail}")` — the source spelling round-trips.
        assert_eq!(canon("A#", false, false), "A#");
        assert_eq!(canon("Bb", false, false), "Bb");
        assert_eq!(canon("F#m7", false, false), "F#m7");
    }

    #[test]
    fn force_common_rewrites_toosharp_majors() {
        // The "toosharp" set per upstream is_key_toosharp at
        // `lib/ChordPro/Chords/Parser.pm:879` in R6.100.0:
        // {C# (1), D# (3), G# (8), A# (10)}. These render as flats under
        // default keys.force-common = true.
        assert_eq!(canon("C#", true, false), "Db");
        assert_eq!(canon("D#", true, false), "Eb");
        assert_eq!(canon("G#", true, false), "Ab");
        assert_eq!(canon("A#", true, false), "Bb");
    }

    #[test]
    fn force_common_preserves_normal_majors() {
        // Roots NOT in the toosharp set keep their natural / sharp
        // spelling: C, D, E, F, G, A, B all render unchanged.
        for root in ["C", "D", "E", "F", "G", "A", "B"] {
            assert_eq!(canon(root, true, false), root, "{root}");
        }
    }

    #[test]
    fn f_sharp_default_stays_sharp() {
        // F# (key_semi 6) is the ambiguous case. Default keys.flats=false
        // leaves it as F#. The enharmonic input Gb normalizes to the same
        // sharp spelling, so the function is idempotent in both directions.
        assert_eq!(canon("F#", true, false), "F#");
        assert_eq!(canon("Gb", true, false), "F#");
    }

    #[test]
    fn f_sharp_under_flats_becomes_gb() {
        // keys.flats=true flips the F#/Gb special-case to flat.
        assert_eq!(canon("F#", true, true), "Gb");
        assert_eq!(canon("Gb", true, true), "Gb");
    }

    #[test]
    fn force_common_preserves_extensions() {
        // Major-quality toosharp roots keep their extensions intact when
        // the root is re-spelled.
        assert_eq!(canon("A#7", true, false), "Bb7");
        assert_eq!(canon("D#maj7", true, false), "Ebmaj7");
        assert_eq!(canon("G#sus4", true, false), "Absus4");
        assert_eq!(canon("C#9", true, false), "Db9");
    }

    #[test]
    fn force_common_preserves_bass_slash_chord() {
        // Upstream's `keyname()` only normalises the chord's primary
        // root; the bass spelling is left as-written (Parser.pm only
        // reaches into nf_canon / ns_canon for the root). chordsketch
        // mirrors this: the bass note in `G/B` round-trips, and a
        // toosharp root pairs with a verbatim bass.
        assert_eq!(canon("G/B", true, false), "G/B");
        assert_eq!(canon("A#/E", true, false), "Bb/E");
    }

    #[test]
    fn force_common_minor_shift_matches_upstream() {
        // Upstream Parser.pm:863, 883 subtract 3 from the root ordinal
        // for minor chords before consulting the toosharp / flat tables.
        // The shift produces some surprising re-spellings; pin the upstream
        // results literally so any divergence shows up immediately.

        // F#m: root_ord 6, minor-shift → 3 (D# ord), 3 ∈ {1, 3, 8, 10}
        //      → toosharp → flat → Gbm.
        assert_eq!(canon("F#m", true, false), "Gbm");

        // A#m: root_ord 10, minor-shift → 7 (G ord), 7 ∉ {1, 3, 8, 10}
        //      → NOT toosharp → sharp name preserved → A#m. Note that the
        //      *major* A# DOES re-spell to Bb (different test above).
        assert_eq!(canon("A#m", true, false), "A#m");

        // C#m: root_ord 1, minor-shift → 10 (A# ord), 10 ∈ {1, 3, 8, 10}
        //      → toosharp → flat → Dbm. (Upstream applies the rewrite via
        //      the post-shift ordinal even for minors.)
        assert_eq!(canon("C#m", true, false), "Dbm");

        // Em (a non-toosharp major-side root) is untouched whether or not
        // the minor-shift is applied; pin it so a future regression in the
        // arithmetic surfaces here.
        assert_eq!(canon("Em", true, false), "Em");
    }

    // -- chord_pitches (#2650) -----------------------------------------------

    #[test]
    fn pitches_major_triad() {
        // C major: C3, E3, G3.
        assert_eq!(chord_pitches("C"), Some(vec![48, 52, 55]));
        // G major rooted at G3 (pc 7 → 55): G3, B3, D4.
        assert_eq!(chord_pitches("G"), Some(vec![55, 59, 62]));
    }

    #[test]
    fn pitches_minor_triad() {
        // A minor: A3, C4, E4.
        assert_eq!(chord_pitches("Am"), Some(vec![57, 60, 64]));
        // E minor: E3, G3, B3.
        assert_eq!(chord_pitches("Em"), Some(vec![52, 55, 59]));
    }

    #[test]
    fn pitches_diminished_and_augmented() {
        // B diminished: B3, D4, F4 — root pc 11 → 59.
        assert_eq!(chord_pitches("Bdim"), Some(vec![59, 62, 65]));
        // C augmented: C3, E3, G#3.
        assert_eq!(chord_pitches("Caug"), Some(vec![48, 52, 56]));
        assert_eq!(chord_pitches("C+"), Some(vec![48, 52, 56]));
    }

    #[test]
    fn pitches_dominant_and_minor_seventh() {
        // G7: G3, B3, D4, F4.
        assert_eq!(chord_pitches("G7"), Some(vec![55, 59, 62, 65]));
        // Am7: A3, C4, E4, G4.
        assert_eq!(chord_pitches("Am7"), Some(vec![57, 60, 64, 67]));
    }

    #[test]
    fn pitches_major_seventh_distinct_from_dominant() {
        // Cmaj7 has a major seventh (B3 = 59), not the dominant Bb3 (58).
        assert_eq!(chord_pitches("Cmaj7"), Some(vec![48, 52, 55, 59]));
        // Bare "Cmaj" is just the major triad — no seventh added.
        assert_eq!(chord_pitches("Cmaj"), Some(vec![48, 52, 55]));
        // Minor-major seventh ("Cmmaj7"): minor triad + major seventh.
        assert_eq!(chord_pitches("Cmmaj7"), Some(vec![48, 51, 55, 59]));
    }

    #[test]
    fn pitches_diminished_seventh() {
        // Cdim7 is fully diminished: C3, Eb3, Gb3, Bbb3 (= A3, 57).
        assert_eq!(chord_pitches("Cdim7"), Some(vec![48, 51, 54, 57]));
    }

    #[test]
    fn pitches_half_diminished_via_m7b5() {
        // Cm7b5: minor third, flat fifth, minor seventh.
        assert_eq!(chord_pitches("Cm7b5"), Some(vec![48, 51, 54, 58]));
    }

    #[test]
    fn pitches_sus_replaces_third() {
        // Csus4: root, perfect fourth, fifth (no third).
        assert_eq!(chord_pitches("Csus4"), Some(vec![48, 53, 55]));
        // Csus2: root, major second, fifth.
        assert_eq!(chord_pitches("Csus2"), Some(vec![48, 50, 55]));
        // C7sus4: sus4 triad plus a dominant seventh.
        assert_eq!(chord_pitches("C7sus4"), Some(vec![48, 53, 55, 58]));
    }

    #[test]
    fn pitches_add_tone_has_no_seventh() {
        // Cadd9 is the triad plus a 9th (D4 = 62), with NO seventh.
        assert_eq!(chord_pitches("Cadd9"), Some(vec![48, 52, 55, 62]));
    }

    #[test]
    fn pitches_sixth_adds_major_sixth_not_seventh() {
        // C6: triad plus the major sixth (A3 = 57).
        assert_eq!(chord_pitches("C6"), Some(vec![48, 52, 55, 57]));
        // Am6: minor triad plus the major sixth (F#4 = 66).
        assert_eq!(chord_pitches("Am6"), Some(vec![57, 60, 64, 66]));
    }

    #[test]
    fn pitches_ninth_chord_includes_seventh_and_ninth() {
        // G9: dominant seventh plus the ninth.
        assert_eq!(chord_pitches("G9"), Some(vec![55, 59, 62, 65, 69]));
    }

    #[test]
    fn pitches_power_chord_omits_third() {
        // C5: root and fifth only.
        assert_eq!(chord_pitches("C5"), Some(vec![48, 55]));
    }

    #[test]
    fn pitches_extended_dominant_stacks_lower_tones() {
        // G11 / C13 stack the 9th and 11th below the named degree.
        // G11: G3 B3 D4 F4 A4 C5.
        assert_eq!(chord_pitches("G11"), Some(vec![55, 59, 62, 65, 69, 72]));
        // C13: C3 E3 G3 Bb3 D4 F4 A4.
        assert_eq!(chord_pitches("C13"), Some(vec![48, 52, 55, 58, 62, 65, 69]));
    }

    #[test]
    fn pitches_major_extended_match_dominant_stacking() {
        // Regression guard: maj9 / maj11 / maj13 must stack the same lower
        // extension tones the dominant equivalents do (only the seventh
        // differs: major 7th = 11 semitones, not the dominant's 10).
        // Cmaj9: C3 E3 G3 B3 D4.
        assert_eq!(chord_pitches("Cmaj9"), Some(vec![48, 52, 55, 59, 62]));
        // Cmaj11: adds the 11th (F4) AND the 9th (D4) below it.
        assert_eq!(chord_pitches("Cmaj11"), Some(vec![48, 52, 55, 59, 62, 65]));
        // Cmaj13: adds the 13th (A4), 11th (F4), and 9th (D4).
        assert_eq!(
            chord_pitches("Cmaj13"),
            Some(vec![48, 52, 55, 59, 62, 65, 69])
        );
    }

    #[test]
    fn pitches_six_nine_chord_has_no_seventh() {
        // C69 (6/9): root, third, fifth, major sixth, ninth — and NO seventh.
        // C3 E3 G3 A3 D4.
        assert_eq!(chord_pitches("C69"), Some(vec![48, 52, 55, 57, 62]));
        // Minor 6/9 keeps the minor third.
        assert_eq!(chord_pitches("Cm69"), Some(vec![48, 51, 55, 57, 62]));
    }

    #[test]
    fn pitches_altered_fifth() {
        // C7#5: augmented dominant seventh — raised fifth (G#3) + b7 (Bb3).
        assert_eq!(chord_pitches("C7#5"), Some(vec![48, 52, 56, 58]));
    }

    #[test]
    fn pitches_bare_sus_is_sus4() {
        // "Csus" with no number defaults to a suspended fourth.
        assert_eq!(chord_pitches("Csus"), Some(vec![48, 53, 55]));
    }

    #[test]
    fn pitches_add_degrees() {
        // The full degree → semitone map exercised through add chords.
        assert_eq!(chord_pitches("Cadd2"), Some(vec![48, 50, 52, 55])); // +2
        assert_eq!(chord_pitches("Cadd4"), Some(vec![48, 52, 53, 55])); // +5
        assert_eq!(chord_pitches("Cadd6"), Some(vec![48, 52, 55, 57])); // +9
        assert_eq!(chord_pitches("Cadd11"), Some(vec![48, 52, 55, 65])); // +17
        assert_eq!(chord_pitches("Cadd13"), Some(vec![48, 52, 55, 69])); // +21
        // An unrecognised added degree contributes no extra tone (the
        // documented bare-triad fallback), leaving the plain triad.
        assert_eq!(chord_pitches("Caddx"), Some(vec![48, 52, 55]));
    }

    #[test]
    fn pitches_slash_bass_is_lowest_note() {
        // C/G: triad with the bass G dropped an octave below the root.
        assert_eq!(chord_pitches("C/G"), Some(vec![43, 48, 52, 55]));
        // Am7/G: the bass is below all chord tones and de-duplication keeps
        // the (distinct) low G even though the chord has its own G4.
        assert_eq!(chord_pitches("Am7/G"), Some(vec![43, 57, 60, 64, 67]));
    }

    #[test]
    fn pitches_accidental_roots() {
        // Bb major: Bb3 (pc 10 → 58), D4, F4.
        assert_eq!(chord_pitches("Bb"), Some(vec![58, 62, 65]));
        // F#m: F#3 (pc 6 → 54), A3, C#4.
        assert_eq!(chord_pitches("F#m"), Some(vec![54, 57, 61]));
    }

    #[test]
    fn pitches_unparseable_returns_none() {
        assert_eq!(chord_pitches(""), None);
        assert_eq!(chord_pitches("xyz"), None);
        assert_eq!(chord_pitches("H"), None);
        assert_eq!(chord_pitches("G/"), None);
    }

    #[test]
    fn pitches_are_sorted_and_deduplicated() {
        for name in ["C", "Am7", "Cmaj7", "G9", "C/G", "Cdim7", "F#m", "Bb13"] {
            let pitches = chord_pitches(name).unwrap();
            let mut sorted = pitches.clone();
            sorted.sort_unstable();
            assert_eq!(pitches, sorted, "{name} pitches must be ascending");
            let mut deduped = sorted.clone();
            deduped.dedup();
            assert_eq!(pitches, deduped, "{name} pitches must be unique");
            assert!(!pitches.is_empty(), "{name} must yield at least one pitch");
            assert!(
                pitches.iter().all(|&p| p < 128),
                "{name} pitches must be valid MIDI notes"
            );
        }
    }

    // -- key audition (scale + tonic triad) ----------------------------------

    #[test]
    fn key_scale_major_movable_do() {
        // C major: C3 D3 E3 F3 G3 A3 B3 C4 — the canonical "do re mi …".
        assert_eq!(
            key_scale_pitches("C"),
            Some(vec![48, 50, 52, 53, 55, 57, 59, 60])
        );
        // G major rooted at G3 (pc 7 → 55): the F is sharpened (F#4 = 66).
        assert_eq!(
            key_scale_pitches("G"),
            Some(vec![55, 57, 59, 60, 62, 64, 66, 67])
        );
    }

    #[test]
    fn key_scale_minor_natural() {
        // A minor: A3 B3 C4 D4 E4 F4 G4 A4 — natural minor, no raised 7th.
        assert_eq!(
            key_scale_pitches("Am"),
            Some(vec![57, 59, 60, 62, 64, 65, 67, 69])
        );
        // E minor rooted at E3 (pc 4 → 52).
        assert_eq!(
            key_scale_pitches("Em"),
            Some(vec![52, 54, 55, 57, 59, 60, 62, 64])
        );
    }

    #[test]
    fn key_scale_accidental_roots() {
        // Bb major rooted at Bb3 (pc 10 → 58).
        assert_eq!(
            key_scale_pitches("Bb"),
            Some(vec![58, 60, 62, 63, 65, 67, 69, 70])
        );
        // F#m rooted at F#3 (pc 6 → 54), natural-minor steps.
        assert_eq!(
            key_scale_pitches("F#m"),
            Some(vec![54, 56, 57, 59, 61, 62, 64, 66])
        );
    }

    #[test]
    fn key_scale_rejects_extension_keys() {
        // A key is a tonal centre, not a chord: the strict key grammar
        // (issue #2665) rejects an extension on a key outright rather than
        // reducing it to a triad, so there is no scale to audition.
        assert_eq!(key_scale_pitches("Cmaj7"), None);
        assert_eq!(key_scale_pitches("Am7"), None);
        // The bare tonal keys still sound.
        assert!(key_scale_pitches("C").is_some());
        assert!(key_scale_pitches("Am").is_some());
    }

    #[test]
    fn key_scale_sounds_minor_for_minor_third_modes() {
        // A modal key auditions its parent major/minor colour (issue #2665).
        assert_eq!(key_scale_pitches("C dorian"), key_scale_pitches("Cm"));
        assert_eq!(key_scale_pitches("C lydian"), key_scale_pitches("C"));
    }

    #[test]
    fn key_tonic_triad_major_and_minor() {
        // The tonic triad equals the bare-triad chord for a simple key.
        assert_eq!(key_tonic_triad("C"), Some(vec![48, 52, 55])); // C E G
        assert_eq!(key_tonic_triad("Am"), Some(vec![57, 60, 64])); // A C E
        assert_eq!(key_tonic_triad("Bb"), Some(vec![58, 62, 65])); // Bb D F
        assert_eq!(key_tonic_triad("F#m"), Some(vec![54, 57, 61])); // F# A C#
    }

    #[test]
    fn key_tonic_triad_rejects_extension_keys() {
        // The strict key grammar (issue #2665) does not admit chord extensions
        // on a key, so an extension spelling is rejected rather than reduced
        // to a triad.
        assert_eq!(key_tonic_triad("Cmaj7"), None);
        assert_eq!(key_tonic_triad("Am7"), None);
    }

    #[test]
    fn key_audition_unparseable_returns_none() {
        for bad in ["", "xyz", "H", "G/"] {
            assert_eq!(key_scale_pitches(bad), None, "{bad} scale must be None");
            assert_eq!(key_tonic_triad(bad), None, "{bad} triad must be None");
        }
    }

    #[test]
    fn key_scale_is_ascending_and_in_midi_range() {
        for name in ["C", "G", "Am", "Em", "Bb", "F#m", "C#m", "Db"] {
            let scale = key_scale_pitches(name).unwrap();
            assert_eq!(scale.len(), 8, "{name} scale must have eight degrees");
            assert!(
                scale.windows(2).all(|w| w[0] < w[1]),
                "{name} scale must be strictly ascending"
            );
            assert!(
                scale.iter().all(|&p| p < 128),
                "{name} scale must be valid MIDI notes"
            );
            // The tonic and the octave bracket exactly twelve semitones.
            assert_eq!(scale[7] - scale[0], 12, "{name} must span one octave");
        }
    }
}
