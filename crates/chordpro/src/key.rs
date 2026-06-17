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
//! See [ADR-0033](../../../docs/adr/0033-canonical-key-directive-notation.md)
//! for the canonical-notation decision this module enforces.
//!
//! # Canonical grammar
//!
//! A valid `{key}` value is one of:
//!
//! - **Tonal key**: a root note `A`–`G`, an optional accidental (`#` / `b`),
//!   an optional minor marker, and an optional `/bass` note. The canonical
//!   minor marker is `m`; the ChordPro spec's aliases `mi`, `min`, and `-`
//!   are accepted and normalised to `m`. Examples: `C`, `Gm`, `F#m`, `Bb`,
//!   `Cmin` (→ `Cm`), `G/B`.
//! - **Modal key**: a root note + optional accidental, a single space, and
//!   one of the seven church-mode names (`ionian`, `dorian`, `phrygian`,
//!   `lydian`, `mixolydian`, `aeolian`, `locrian`), case-insensitive.
//!   Examples: `C dorian`, `F# mixolydian`.
//!
//! Everything else is **invalid** and yields `None`, including:
//! - spelled-out qualities (`Gminor`, `Gmajor`),
//! - a space before a non-mode word (`G m`, `G minor`, `G major`),
//! - chord extensions on a key (`G7`, `Cmaj7`) — a key is a tonal centre,
//!   not a chord.

use crate::chord::{Accidental, Note};

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

/// A structurally-validated ChordPro `{key}` value.
///
/// Produced only by [`parse_key`]; an instance is a guarantee that the source
/// matched the [canonical grammar](self#canonical-grammar).
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
}

impl core::fmt::Display for Key {
    /// Emit the **canonical** spelling of the key (minor aliases normalised to
    /// `m`, modal qualifier as a single space + lowercase mode word).
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.root)?;
        if let Some(acc) = self.accidental {
            write!(f, "{acc}")?;
        }
        match self.mode {
            KeyMode::Major => {}
            KeyMode::Minor => f.write_str("m")?,
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

/// Parse a complete bass token (`<note><accidental?>`), rejecting any trailing
/// characters.
fn parse_bass(s: &str) -> Option<(Note, Option<Accidental>)> {
    let mut chars = s.chars().peekable();
    let bass = take_root(&mut chars)?;
    if chars.next().is_some() {
        return None; // trailing garbage after the bass note
    }
    Some(bass)
}

/// Parse a ChordPro `{key}` directive value strictly.
///
/// Returns `Some(Key)` only for the [canonical grammar](self#canonical-grammar);
/// every malformed value (`G m`, `Gminor`, `G minor`, `G7`, …) returns `None`.
/// Surrounding whitespace is tolerated, but no internal whitespace is allowed
/// except the single space that introduces a modal qualifier.
#[must_use]
pub fn parse_key(value: &str) -> Option<Key> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Split off an optional slash-bass first so the qualifier scan never sees
    // the `/`. A key carries at most one slash.
    let (head, bass) = match trimmed.split_once('/') {
        Some((before, after)) => (before, Some(parse_bass(after.trim())?)),
        None => (trimmed, None),
    };

    let mut chars = head.chars().peekable();
    let (root, accidental) = take_root(&mut chars)?;
    let rest: String = chars.collect();

    // Modal key: a single space (the qualifier scan only reaches here when the
    // remainder begins with whitespace) followed by exactly one church-mode
    // word. A modal key cannot also carry a slash-bass.
    if rest.starts_with(char::is_whitespace) {
        if bass.is_some() {
            return None;
        }
        let mode_word = rest.trim();
        let mode = ChurchMode::from_lowercase(&mode_word.to_ascii_lowercase())?;
        return Some(Key {
            root,
            accidental,
            mode: KeyMode::Mode(mode),
            bass: None,
        });
    }

    // Tonal key: the remainder must be empty (major) or exactly one minor
    // marker. Anything else — spelled-out words, chord extensions — is invalid.
    let mode = match rest.as_str() {
        "" => KeyMode::Major,
        "m" | "mi" | "min" | "-" => KeyMode::Minor,
        _ => return None,
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
            assert_eq!(k(alias).to_string(), "Gm", "canonical of {alias}");
        }
    }

    #[test]
    fn the_four_user_forms_are_disambiguated() {
        // The canonical form.
        assert_eq!(k("Gm").mode, KeyMode::Minor);
        assert_eq!(k("Gm").to_string(), "Gm");
        // The three malformed forms are rejected outright.
        assert_eq!(parse_key("G m"), None);
        assert_eq!(parse_key("Gminor"), None);
        assert_eq!(parse_key("G minor"), None);
    }

    #[test]
    fn spelled_out_qualities_rejected() {
        assert_eq!(parse_key("Gmajor"), None);
        assert_eq!(parse_key("G major"), None);
        assert_eq!(parse_key("Cminor"), None);
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
    fn unknown_mode_word_rejected() {
        assert_eq!(parse_key("C blues"), None);
        assert_eq!(parse_key("G m"), None); // a space before "m" is not a mode
    }

    #[test]
    fn slash_bass_keys_parse() {
        let key = k("G/B");
        assert_eq!(key.mode, KeyMode::Major);
        assert_eq!(key.bass, Some((Note::B, None)));
        assert_eq!(key.to_string(), "G/B");

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
}
