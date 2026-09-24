//! Turns a Guitar Pro chord diagram into a ChordPro chord name.

use chordsketch_chordpro::ast::Chord;
use chordsketch_chordpro::chord::parse_chord;
use chordsketch_chordpro::transpose::transpose_chord_with_style;

use crate::gp5::structs::{ChordDiagram, ChordSpelling};

/// How a diagram's name was obtained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolved {
    /// The name stored in the diagram reads as a chord.
    Named(String),
    /// The stored name was empty or unreadable; the name was spelled from
    /// the diagram's root and chord type instead. Carries the stored name.
    Spelled { name: String, stored: String },
    /// Neither the stored name nor the spelling gives a chord.
    Unknown { stored: String },
}

/// Resolves a diagram to a chord name.
pub(crate) fn resolve(diagram: &ChordDiagram) -> Resolved {
    let stored = diagram.name.trim();
    if !stored.is_empty() && parse_chord(stored).is_some() {
        return Resolved::Named(stored.to_string());
    }
    match diagram.spelling.and_then(spell) {
        Some(name) => Resolved::Spelled {
            name,
            stored: stored.to_string(),
        },
        None => Resolved::Unknown {
            stored: stored.to_string(),
        },
    }
}

/// Moves a chord from capo-relative shape to sounding pitch.
///
/// Guitar Pro stores tablature and chord diagrams relative to the capo, so a
/// diagram named `Em` on a track with a capo on fret 2 is an `Em` shape that
/// sounds as `F#m`. ChordPro chords are written at sounding pitch, with
/// `{capo}` telling the reader which shapes to play, so the importer raises
/// every name by the capo.
pub(crate) fn to_sounding(name: &str, capo: i8, prefer_flat: bool) -> String {
    if capo == 0 {
        return name.to_string();
    }
    transpose_chord_with_style(&Chord::new(name), capo, prefer_flat).name
}

/// Spells a chord from a diagram's structured fields.
fn spell(spelling: ChordSpelling) -> Option<String> {
    let root = pitch_name(spelling.root, spelling.sharp)?;
    let suffix = match spelling.kind {
        0 => "",
        1 => "7",
        2 => "maj7",
        3 => "6",
        4 => "m",
        5 => "m7",
        6 => "mMaj7",
        7 => "m6",
        8 => "sus2",
        9 => "sus4",
        10 => "7sus2",
        11 => "7sus4",
        12 => "dim",
        13 => "aug",
        14 => "5",
        _ => return None,
    };
    let mut name = format!("{root}{suffix}");
    if spelling.bass != spelling.root
        && let Some(bass) = pitch_name(spelling.bass, spelling.sharp)
    {
        name.push('/');
        name.push_str(bass);
    }
    Some(name)
}

/// Names a pitch class (0 = C .. 11 = B) with sharps or flats.
fn pitch_name(pitch: i32, sharp: bool) -> Option<&'static str> {
    const SHARPS: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    const FLATS: [&str; 12] = [
        "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
    ];
    let index = usize::try_from(pitch).ok().filter(|&i| i < 12)?;
    Some(if sharp { SHARPS[index] } else { FLATS[index] })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagram(name: &str, spelling: Option<(bool, i32, u8, i32)>) -> ChordDiagram {
        ChordDiagram {
            name: name.to_string(),
            spelling: spelling.map(|(sharp, root, kind, bass)| ChordSpelling {
                sharp,
                root,
                kind,
                bass,
            }),
        }
    }

    #[test]
    fn when_the_stored_name_is_a_chord_it_is_used() {
        assert_eq!(
            resolve(&diagram(" Am7 ", Some((false, 0, 0, 0)))),
            Resolved::Named("Am7".to_string())
        );
    }

    #[test]
    fn when_the_stored_name_is_empty_the_chord_is_spelled_from_root_and_type() {
        assert_eq!(
            resolve(&diagram("", Some((false, 7, 2, 7)))),
            Resolved::Spelled {
                name: "Gmaj7".to_string(),
                stored: String::new()
            }
        );
    }

    #[test]
    fn when_the_bass_differs_from_the_root_the_spelling_is_a_slash_chord() {
        assert_eq!(
            resolve(&diagram("", Some((true, 9, 4, 7)))),
            Resolved::Spelled {
                name: "Am/G".to_string(),
                stored: String::new()
            }
        );
    }

    #[test]
    fn when_the_diagram_prefers_sharps_or_flats_the_root_follows() {
        assert_eq!(
            spell(ChordSpelling {
                sharp: true,
                root: 6,
                kind: 4,
                bass: 6
            })
            .as_deref(),
            Some("F#m")
        );
        assert_eq!(
            spell(ChordSpelling {
                sharp: false,
                root: 6,
                kind: 4,
                bass: 6
            })
            .as_deref(),
            Some("Gbm")
        );
    }

    #[test]
    fn when_nothing_reads_as_a_chord_the_diagram_is_unknown() {
        assert_eq!(
            resolve(&diagram("xyz", None)),
            Resolved::Unknown {
                stored: "xyz".to_string()
            }
        );
        // A root outside 0..=11 is Guitar Pro's "no root".
        assert_eq!(
            resolve(&diagram("", Some((false, 255, 0, 255)))),
            Resolved::Unknown {
                stored: String::new()
            }
        );
    }

    #[test]
    fn when_a_chord_type_is_spelled_the_chordpro_parser_reads_it_back() {
        for kind in 0..=14 {
            let name = spell(ChordSpelling {
                sharp: false,
                root: 2,
                kind,
                bass: 2,
            })
            .unwrap();
            assert!(
                parse_chord(&name).is_some(),
                "{name} (type {kind}) does not parse"
            );
        }
        assert_eq!(
            spell(ChordSpelling {
                sharp: false,
                root: 2,
                kind: 15,
                bass: 2
            }),
            None
        );
    }

    #[test]
    fn when_a_track_has_a_capo_the_shape_is_raised_to_sounding_pitch() {
        assert_eq!(to_sounding("Em", 2, false), "F#m");
        assert_eq!(to_sounding("C", 2, false), "D");
        assert_eq!(to_sounding("G/B", 3, true), "Bb/D");
        assert_eq!(to_sounding("Am7", 0, false), "Am7");
    }
}
