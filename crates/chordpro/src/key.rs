//! Strict parser for the ChordPro `{key}` directive value.
//!
//! Unlike [`crate::chord::parse_chord`] — which is deliberately permissive
//! and dumps any trailing text into a chord's `extension` field — this module
//! defines the *single, strict* notion of what a well-formed key is. Every
//! subsystem that interprets a key (transpose re-spelling, the key-signature
//! glyph, the scale / tonic-triad audition audio, and the displayed key text)
//! routes through [`parse_key`] so the four subsystems can never disagree on a
//! key's major / minor / modal classification.
//!
//! See [ADR-0034](../../../docs/adr/0034-lenient-key-input-canonical-render.md)
//! (which supersedes ADR-0033's strict-input clause) for the
//! lenient-input / canonical-render decision this module enforces.
//!
//! # Grammar
//!
//! Input is **lenient** — the editor accepts the common human key spellings —
//! but [`Key`]'s [`Display`](core::fmt::Display) is the single **canonical**
//! form every render surface shows. A valid `{key}` value is one of:
//!
//! - **Tonal key**: a root note `A`–`G`, an optional accidental (`#` / `b`),
//!   an optional quality qualifier, and an optional `/bass` note. The qualifier
//!   tolerates a single internal space; the spelled-out words are matched
//!   case-insensitively, but the single-letter marker is case-sensitive (the
//!   lead-sheet convention `Cm` = minor, `CM` = major): minor ← `m` / `-` /
//!   `mi` / `min` / `minor`; major ← *(empty)* / `M` / `maj` / `major`.
//!   Examples: `C`, `Gm`, `G minor`, `Gminor`, `G min`, `G major`
//!   (→ `G major`), `CM` (→ `C major`), `Cmin` (→ `C minor`), `G/B`.
//! - **Modal key**: a root + optional accidental + one of the seven
//!   church-mode names (`ionian`, `dorian`, `phrygian`, `lydian`,
//!   `mixolydian`, `aeolian`, `locrian`), case-insensitive. Examples:
//!   `C dorian`, `F# mixolydian`.
//!
//! Canonical [`Display`](core::fmt::Display): the quality is **spelled out** —
//! minor → `G minor`, major → `G major`, modal → `G dorian` — with the
//! slash-bass preserved (`G major/B`, `A minor/C`).
//!
//! A chord extension on a key (`G7`, `Gm7`, `Cmaj7`, `Gsus4`) is **not** a key
//! — a key is a tonal centre, not a chord — and yields `None`, as does a value
//! with no note-letter root. Callers render those verbatim.

use crate::chord::{Accidental, ChordDetail, ChordQuality, Note};

/// One of the seven Western church modes, recognised as a `{key}` modal
/// qualifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChurchMode {
    /// Ionian (major).
    Ionian,
    /// Dorian.
    Dorian,
    /// Phrygian.
    Phrygian,
    /// Lydian.
    Lydian,
    /// Mixolydian.
    Mixolydian,
    /// Aeolian (natural minor).
    Aeolian,
    /// Locrian.
    Locrian,
}

impl ChurchMode {
    /// Parse a (already lowercased) mode word.
    fn from_lowercase(s: &str) -> Option<Self> {
        match s {
            "ionian" => Some(Self::Ionian),
            "dorian" => Some(Self::Dorian),
            "phrygian" => Some(Self::Phrygian),
            "lydian" => Some(Self::Lydian),
            "mixolydian" => Some(Self::Mixolydian),
            "aeolian" => Some(Self::Aeolian),
            "locrian" => Some(Self::Locrian),
            _ => None,
        }
    }

    /// The canonical lowercase spelling of the mode.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ionian => "ionian",
            Self::Dorian => "dorian",
            Self::Phrygian => "phrygian",
            Self::Lydian => "lydian",
            Self::Mixolydian => "mixolydian",
            Self::Aeolian => "aeolian",
            Self::Locrian => "locrian",
        }
    }

    /// Whether the mode's tonic triad is minor (has a minor third).
    ///
    /// Dorian, Phrygian, Aeolian, and Locrian build a minor third over the
    /// tonic; Ionian, Lydian, and Mixolydian build a major third. This drives
    /// the scale / tonic-triad audition for a modal key — auditioning a modal
    /// key plays its parent major or minor colour rather than nothing.
    #[must_use]
    pub fn is_minor_third(self) -> bool {
        matches!(
            self,
            Self::Dorian | Self::Phrygian | Self::Aeolian | Self::Locrian
        )
    }
}

/// The tonal character of a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyMode {
    /// A major key (`C`, `Bb`, `F#`).
    Major,
    /// A minor key (`Cm`, written with `m` / `mi` / `min` / `-`).
    Minor,
    /// A modal key (`C dorian`).
    Mode(ChurchMode),
}

/// The canonical, **spelled-out** quality suffix for a tonal (non-modal) key:
/// `" minor"` for a minor key, `" major"` for a major key.
///
/// This is the single source of truth for the spelled-out canonical notation:
/// [`Key`]'s [`Display`](core::fmt::Display) and the transpose-path key-string
/// builders (`crate::transpose`) all route through it so the rendered key reads
/// `G major` / `A minor` identically at a zero transpose and after a transpose.
/// A modal key carries its mode word (`" dorian"`) instead and never passes
/// through here.
#[must_use]
pub fn quality_word(is_minor: bool) -> &'static str {
    if is_minor { " minor" } else { " major" }
}

/// A structurally-validated ChordPro `{key}` value.
///
/// Produced only by [`parse_key`]; an instance is a guarantee that the source
/// matched the [grammar](self#grammar).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    /// The tonic note letter.
    pub root: Note,
    /// The tonic's accidental, if any.
    pub accidental: Option<Accidental>,
    /// Major, minor, or modal.
    pub mode: KeyMode,
    /// An optional slash-bass note (tonal keys only).
    pub bass: Option<(Note, Option<Accidental>)>,
}

impl Key {
    /// Whether this key's tonic triad / scale is minor — `true` for an
    /// explicit minor key and for the minor-third church modes.
    #[must_use]
    pub fn is_minor(self) -> bool {
        match self.mode {
            KeyMode::Major => false,
            KeyMode::Minor => true,
            KeyMode::Mode(m) => m.is_minor_third(),
        }
    }

    /// Lower this validated key into a [`ChordDetail`] so the transpose /
    /// display machinery (which operates on `ChordDetail`) can drive directly
    /// off this parse rather than re-parsing the raw string with the permissive
    /// [`crate::chord::parse_chord`]. Keeping a single parse is the "single
    /// source of truth" this module exists for (ADR-0033 / ADR-0034): a minor
    /// key becomes [`ChordQuality::Minor`], a modal qualifier becomes the
    /// canonical `" <mode>"` extension text (preserved verbatim on transpose
    /// because it is not a transposable theory token), and the slash-bass
    /// carries through.
    #[must_use]
    pub fn to_chord_detail(self) -> ChordDetail {
        let (quality, extension) = match self.mode {
            KeyMode::Major => (ChordQuality::Major, None),
            KeyMode::Minor => (ChordQuality::Minor, None),
            KeyMode::Mode(m) => (ChordQuality::Major, Some(format!(" {}", m.as_str()))),
        };
        ChordDetail {
            root: self.root,
            root_accidental: self.accidental,
            quality,
            extension,
            bass_note: self.bass,
        }
    }
}

impl core::fmt::Display for Key {
    /// Emit the **canonical** spelling of the key: the quality is spelled out
    /// (`G major` / `A minor`) and the modal qualifier is a single space +
    /// lowercase mode word (`C dorian`). Every lenient input alias collapses to
    /// this one form.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.root)?;
        if let Some(acc) = self.accidental {
            write!(f, "{acc}")?;
        }
        match self.mode {
            KeyMode::Major => f.write_str(quality_word(false))?,
            KeyMode::Minor => f.write_str(quality_word(true))?,
            KeyMode::Mode(m) => write!(f, " {}", m.as_str())?,
        }
        if let Some((bass, bass_acc)) = self.bass {
            write!(f, "/{bass}")?;
            if let Some(acc) = bass_acc {
                write!(f, "{acc}")?;
            }
        }
        Ok(())
    }
}

/// Parse a note letter (`A`–`G`) plus an optional single accidental from the
/// front of `chars`, returning `None` if the first character is not a valid
/// note letter.
fn take_root(
    chars: &mut core::iter::Peekable<core::str::Chars<'_>>,
) -> Option<(Note, Option<Accidental>)> {
    let root = Note::from_char(*chars.peek()?)?;
    chars.next();
    let accidental = match chars.peek() {
        Some('#') => {
            chars.next();
            Some(Accidental::Sharp)
        }
        Some('b') => {
            chars.next();
            Some(Accidental::Flat)
        }
        _ => None,
    };
    Some((root, accidental))
}

/// Parse a ChordPro `{key}` directive value leniently into its canonical
/// [`Key`] (see the [module docs](self#grammar)).
///
/// Accepts the common human key spellings (`Gm` / `G m` / `G minor` /
/// `Gminor` / `G min`, `G` / `G major`, `C dorian`, `G/B`) and normalises
/// them; a chord extension on a key (`G7`, `Gm7`) or a value with no
/// note-letter root returns `None` so the caller renders it verbatim.
#[must_use]
pub fn parse_key(value: &str) -> Option<Key> {
    // Normalise the spellings a displayed / authored key can legitimately use
    // before parsing, so every consumer of `parse_key` (validation, transpose,
    // the key-signature glyph) agrees: Unicode ♯ / ♭ fold to ASCII `#` / `b`
    // (the displayed key is typeset with the Unicode glyphs, and editors often
    // auto-format them), and NBSP / ideographic spaces fold to a plain space so
    // a modal qualifier still parses. This is the single place the folding
    // lives — the glyph sister-sites previously each carried their own copy.
    let normalised: String = value
        .chars()
        .map(|c| match c {
            '\u{266F}' => '#',
            '\u{266D}' => 'b',
            '\u{00A0}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect();
    let trimmed = normalised.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Split off an optional slash-bass first so the qualifier scan never sees
    // the `/`. A key carries at most one slash.
    let (head, bass) = match trimmed.split_once('/') {
        // The bass token reuses the chord parser's note+accidental scanner so
        // bass-note parsing has exactly one implementation (it rejects any
        // trailing characters, so `G/Bextra` is invalid).
        Some((before, after)) => (
            before,
            Some(crate::chord::parse_note_with_accidental(after.trim())?),
        ),
        None => (trimmed, None),
    };

    let mut chars = head.chars().peekable();
    let (root, accidental) = take_root(&mut chars)?;
    let rest: String = chars.collect();

    // Match the quality / mode qualifier leniently (ADR-0034): the editor is
    // permissive, so the common human spellings are all accepted and
    // normalised to one canonical structure. Trimming `rest` collapses the
    // space / no-space distinction (`Gm` / `G m` / `G minor` / `Gminor` all
    // reduce to the same token).
    //
    //   minor  ← m | - | (mi | min | minor, case-insensitive)
    //   major  ← <empty> | M | (maj | major, case-insensitive)
    //   modal  ← one of the seven church modes (case-insensitive)
    //
    // The spelled-out words and modes are matched case-insensitively, but the
    // SINGLE-letter marker is case-sensitive on purpose: by the lead-sheet
    // convention a lowercase `m` is minor and an uppercase `M` is major
    // (`Cm` = C minor, `CM` = C major). Lowercasing it unconditionally would
    // turn `{key: CM}` into C minor — the wrong quality. A chord extension on
    // a key (`G7`, `Gm7`, `Gsus4`) is NOT a key — those fall through to `None`
    // and the caller renders the value verbatim.
    let qualifier = rest.trim();
    let mode = match qualifier {
        "m" | "-" => KeyMode::Minor,
        "M" => KeyMode::Major,
        _ => match qualifier.to_ascii_lowercase().as_str() {
            "" | "maj" | "major" => KeyMode::Major,
            "mi" | "min" | "minor" => KeyMode::Minor,
            other => {
                let church = ChurchMode::from_lowercase(other)?;
                // A modal key cannot also carry a slash-bass.
                if bass.is_some() {
                    return None;
                }
                KeyMode::Mode(church)
            }
        },
    };

    Some(Key {
        root,
        accidental,
        mode,
        bass,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> Key {
        parse_key(s).unwrap_or_else(|| panic!("expected Some for key {s:?}"))
    }

    #[test]
    fn major_keys_parse() {
        assert_eq!(k("C").mode, KeyMode::Major);
        assert_eq!(k("F#").accidental, Some(Accidental::Sharp));
        assert_eq!(k("Bb").accidental, Some(Accidental::Flat));
        assert_eq!(k("Bb").root, Note::B);
    }

    #[test]
    fn canonical_minor_marker() {
        assert_eq!(k("Gm").mode, KeyMode::Minor);
        assert_eq!(k("F#m").mode, KeyMode::Minor);
    }

    #[test]
    fn minor_marker_aliases_accepted_and_canonicalised() {
        for alias in ["Gm", "Gmi", "Gmin", "G-"] {
            assert_eq!(k(alias).mode, KeyMode::Minor, "alias {alias}");
            assert_eq!(k(alias).to_string(), "G minor", "canonical of {alias}");
        }
    }

    #[test]
    fn the_four_user_forms_all_normalise_to_canonical_minor() {
        // ADR-0034 / ADR-0035: the editor is lenient, so all the spellings parse
        // as the SAME minor key and canonicalise to the spelled-out `G minor`
        // (the rendered form).
        for spelling in ["Gm", "G m", "Gminor", "G minor", "G min", "Gmi", "G-"] {
            assert_eq!(k(spelling).mode, KeyMode::Minor, "mode of {spelling}");
            assert_eq!(
                k(spelling).to_string(),
                "G minor",
                "canonical of {spelling}"
            );
        }
    }

    #[test]
    fn spelled_out_major_normalises() {
        for spelling in ["G", "Gmaj", "G maj", "G major", "Gmajor"] {
            assert_eq!(k(spelling).mode, KeyMode::Major, "mode of {spelling}");
            assert_eq!(
                k(spelling).to_string(),
                "G major",
                "canonical of {spelling}"
            );
        }
        assert_eq!(k("Cminor").to_string(), "C minor");
    }

    #[test]
    fn single_letter_quality_marker_is_case_sensitive() {
        // Lead-sheet convention: lowercase `m` = minor, uppercase `M` = major.
        assert_eq!(k("Cm").mode, KeyMode::Minor);
        assert_eq!(k("Cm").to_string(), "C minor");
        assert_eq!(k("CM").mode, KeyMode::Major); // NOT minor
        assert_eq!(k("CM").to_string(), "C major");
        assert_eq!(k("C M").mode, KeyMode::Major);
        assert_eq!(k("F#M").to_string(), "F# major");
        // The spelled-out words stay case-insensitive.
        assert_eq!(k("C MINOR").mode, KeyMode::Minor);
        assert_eq!(k("C Major").mode, KeyMode::Major);
        assert_eq!(k("CMIN").mode, KeyMode::Minor);
    }

    #[test]
    fn chord_extensions_on_keys_rejected() {
        assert_eq!(parse_key("G7"), None);
        assert_eq!(parse_key("Cmaj7"), None);
        assert_eq!(parse_key("Gsus4"), None);
        assert_eq!(parse_key("Am7"), None);
    }

    #[test]
    fn modal_keys_parse_all_seven_modes() {
        for (word, mode) in [
            ("ionian", ChurchMode::Ionian),
            ("dorian", ChurchMode::Dorian),
            ("phrygian", ChurchMode::Phrygian),
            ("lydian", ChurchMode::Lydian),
            ("mixolydian", ChurchMode::Mixolydian),
            ("aeolian", ChurchMode::Aeolian),
            ("locrian", ChurchMode::Locrian),
        ] {
            let key = k(&format!("C {word}"));
            assert_eq!(key.mode, KeyMode::Mode(mode), "mode {word}");
        }
    }

    #[test]
    fn modal_keys_are_case_insensitive_and_canonicalise() {
        assert_eq!(k("C Dorian").mode, KeyMode::Mode(ChurchMode::Dorian));
        assert_eq!(k("C Dorian").to_string(), "C dorian");
        assert_eq!(k("F# MIXOLYDIAN").to_string(), "F# mixolydian");
    }

    #[test]
    fn every_mode_canonicalises_to_its_name() {
        // Exercises `ChurchMode::as_str` (via Display) for all seven modes so
        // each arm is covered, and confirms the canonical round-trip.
        for word in [
            "ionian",
            "dorian",
            "phrygian",
            "lydian",
            "mixolydian",
            "aeolian",
            "locrian",
        ] {
            assert_eq!(k(&format!("C {word}")).to_string(), format!("C {word}"));
        }
    }

    #[test]
    fn unknown_qualifier_word_rejected() {
        // Not a quality marker and not a mode → not a key (rendered verbatim).
        assert_eq!(parse_key("C blues"), None);
        assert_eq!(parse_key("G augmented"), None);
        // `G m` IS a key now (lenient minor, ADR-0034) — guarded elsewhere.
        assert_eq!(k("G m").mode, KeyMode::Minor);
    }

    #[test]
    fn slash_bass_keys_parse() {
        let key = k("G/B");
        assert_eq!(key.mode, KeyMode::Major);
        assert_eq!(key.bass, Some((Note::B, None)));
        assert_eq!(key.to_string(), "G major/B");

        let minor = k("Am/C");
        assert_eq!(minor.mode, KeyMode::Minor);
        assert_eq!(minor.bass, Some((Note::C, None)));
    }

    #[test]
    fn modal_key_with_bass_rejected() {
        assert_eq!(parse_key("C dorian/E"), None);
    }

    #[test]
    fn malformed_bass_rejected() {
        assert_eq!(parse_key("G/"), None);
        assert_eq!(parse_key("G/H"), None);
        assert_eq!(parse_key("G/Bextra"), None);
    }

    #[test]
    fn empty_and_non_note_rejected() {
        assert_eq!(parse_key(""), None);
        assert_eq!(parse_key("   "), None);
        assert_eq!(parse_key("xyz"), None);
        assert_eq!(parse_key("Hm"), None);
    }

    #[test]
    fn is_minor_classification() {
        assert!(!k("C").is_minor());
        assert!(k("Am").is_minor());
        assert!(k("C dorian").is_minor()); // minor third
        assert!(k("C aeolian").is_minor());
        assert!(!k("C lydian").is_minor()); // major third
        assert!(!k("C mixolydian").is_minor());
    }

    #[test]
    fn surrounding_whitespace_tolerated() {
        assert_eq!(k("  Gm  ").mode, KeyMode::Minor);
        assert_eq!(k("  C dorian ").mode, KeyMode::Mode(ChurchMode::Dorian));
    }

    #[test]
    fn unicode_accidentals_normalised() {
        // The displayed key is typeset with Unicode ♯ / ♭; parse_key must fold
        // them to ASCII so validation / transpose agree with the glyph (#2665,
        // correctness review finding #2).
        assert_eq!(k("B\u{266D}").accidental, Some(Accidental::Flat));
        assert_eq!(k("F\u{266F}").accidental, Some(Accidental::Sharp));
        assert_eq!(k("C\u{266F}m").mode, KeyMode::Minor);
        assert_eq!(k("C\u{266F}m").accidental, Some(Accidental::Sharp));
        // Slash-bass and modal qualifier with Unicode forms.
        assert_eq!(
            k("G/B\u{266D}").bass,
            Some((Note::B, Some(Accidental::Flat)))
        );
        // NBSP between root and mode folds to a regular space.
        assert_eq!(k("C\u{00A0}dorian").mode, KeyMode::Mode(ChurchMode::Dorian));
    }

    #[test]
    fn to_chord_detail_lowers_every_mode_variant() {
        use crate::chord::ChordQuality;

        let major = k("C").to_chord_detail();
        assert_eq!(major.quality, ChordQuality::Major);
        assert_eq!(major.extension, None);

        let minor = k("Gm").to_chord_detail();
        assert_eq!(minor.quality, ChordQuality::Minor);
        assert_eq!(minor.extension, None);

        // A minor alias lowers to the same Minor quality (so transpose appends
        // `m`, not a junk extension — correctness review finding #1).
        for alias in ["Gmi", "Gmin", "G-"] {
            assert_eq!(k(alias).to_chord_detail().quality, ChordQuality::Minor);
            assert_eq!(k(alias).to_chord_detail().extension, None);
        }

        let modal = k("C dorian").to_chord_detail();
        assert_eq!(modal.quality, ChordQuality::Major);
        assert_eq!(modal.extension.as_deref(), Some(" dorian"));

        let slash = k("G/B").to_chord_detail();
        assert_eq!(slash.bass_note, Some((Note::B, None)));
    }

    #[test]
    fn display_round_trips_through_to_chord_detail_shape() {
        // The canonical Display covers the bass-accidental branch too.
        assert_eq!(k("F#m/C#").to_string(), "F# minor/C#");
        assert_eq!(k("Bb/Db").to_string(), "Bb major/Db");
    }
}
