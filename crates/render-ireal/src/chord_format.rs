//! Chord-name display formatting.
//!
//! Renders an AST `Chord` as a flat single-line string suitable for
//! inline placement inside a bar cell. This is the "simple flat
//! layout" called out in the AC for #2060; full superscript
//! typography (raised extensions, alteration brackets) lands in
//! #2057 and replaces this formatter at the call site.

use chordsketch_ireal::{Accidental, Chord, ChordQuality, ChordRoot};

use crate::page::MAX_CHORDS_PER_BAR;

/// Returns the display string for the given chord.
///
/// Format: `<root><accidental><quality>[/<bass>]`. Examples:
/// `C`, `Cm7`, `B♭7`, `F♯m7♭5`, `C/G`. The quality string for
/// [`ChordQuality::Custom`] is included verbatim in the
/// formatter's output; the SVG renderer applies XML escaping at
/// the embedding site (`crate::svg::escape_xml`).
#[must_use]
pub(crate) fn format_chord(chord: &Chord) -> String {
    let mut out = String::new();
    write_root(&mut out, chord.root);
    out.push_str(quality_glyph(&chord.quality));
    if let Some(bass) = chord.bass {
        out.push('/');
        write_root(&mut out, bass);
    }
    out
}

fn write_root(out: &mut String, root: ChordRoot) {
    out.push(crate::note_glyph_or_fallback(root.note));
    out.push_str(match root.accidental {
        Accidental::Natural => "",
        Accidental::Flat => "\u{266D}",
        Accidental::Sharp => "\u{266F}",
    });
}

fn quality_glyph(q: &ChordQuality) -> &str {
    match q {
        ChordQuality::Major => "",
        ChordQuality::Minor => "m",
        ChordQuality::Diminished => "dim",
        ChordQuality::Augmented => "aug",
        ChordQuality::Major7 => "maj7",
        ChordQuality::Minor7 => "m7",
        ChordQuality::Dominant7 => "7",
        ChordQuality::HalfDiminished => "m7\u{266D}5",
        ChordQuality::Diminished7 => "dim7",
        ChordQuality::Suspended2 => "sus2",
        ChordQuality::Suspended4 => "sus4",
        ChordQuality::Custom(s) => s.as_str(),
    }
}

/// Joins multiple chords for placement inside a single bar cell with
/// a single ASCII space between each rendered chord. Used by the
/// flat-layout pass; the typography pass (#2057) replaces this with
/// beat-aware horizontal placement.
///
/// Truncates the chord list to [`MAX_CHORDS_PER_BAR`] before joining
/// so an adversarial AST cannot grow the rendered string without
/// bound. Surplus chords are silently dropped — the cap is far
/// above any practical iReal Pro chart layout, so a hit indicates
/// malformed input rather than legitimate notation.
#[must_use]
pub(crate) fn format_bar_chord_line(chords: &[chordsketch_ireal::BarChord]) -> String {
    let mut out = String::new();
    let limit = chords.len().min(MAX_CHORDS_PER_BAR);
    for (i, bc) in chords.iter().take(limit).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(&format_chord(&bc.chord));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{format_bar_chord_line, format_chord};
    use chordsketch_ireal::{Accidental, BarChord, BeatPosition, Chord, ChordQuality, ChordRoot};

    #[test]
    fn formats_major_triad() {
        let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Major);
        assert_eq!(format_chord(&chord), "C");
    }

    #[test]
    fn formats_minor_seventh() {
        let chord = Chord::triad(ChordRoot::natural('A'), ChordQuality::Minor7);
        assert_eq!(format_chord(&chord), "Am7");
    }

    #[test]
    fn formats_flat_root() {
        let chord = Chord::triad(
            ChordRoot {
                note: 'B',
                accidental: Accidental::Flat,
            },
            ChordQuality::Dominant7,
        );
        assert_eq!(format_chord(&chord), "B\u{266D}7");
    }

    #[test]
    fn formats_half_diminished_with_compound_glyph() {
        let chord = Chord::triad(ChordRoot::natural('F'), ChordQuality::HalfDiminished);
        assert_eq!(format_chord(&chord), "Fm7\u{266D}5");
    }

    #[test]
    fn formats_slash_chord() {
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major,
            bass: Some(ChordRoot::natural('G')),
        };
        assert_eq!(format_chord(&chord), "C/G");
    }

    #[test]
    fn formats_custom_quality_verbatim() {
        let chord = Chord::triad(
            ChordRoot::natural('C'),
            ChordQuality::Custom("13\u{266F}11".into()),
        );
        assert_eq!(format_chord(&chord), "C13\u{266F}11");
    }

    #[test]
    fn out_of_range_root_falls_back_to_question_mark() {
        // Direct field assignment can produce a non-A..=G note; the
        // renderer must emit a deterministic sentinel rather than
        // smuggling raw input into the SVG.
        let chord = Chord::triad(
            ChordRoot {
                note: 'X',
                accidental: Accidental::Natural,
            },
            ChordQuality::Major,
        );
        assert_eq!(format_chord(&chord), "?");
    }

    #[test]
    fn out_of_range_bass_falls_back_to_question_mark() {
        // The `?`-fallback for `note` must apply symmetrically to
        // the slash-chord bass; otherwise an attacker-supplied bass
        // could smuggle through the formatter even when the root
        // is sanitised.
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major,
            bass: Some(ChordRoot {
                note: '<',
                accidental: Accidental::Natural,
            }),
        };
        assert_eq!(format_chord(&chord), "C/?");
    }

    #[test]
    fn excess_chords_per_bar_are_truncated() {
        use crate::page::MAX_CHORDS_PER_BAR;
        // An adversarial AST with > MAX_CHORDS_PER_BAR chords
        // must produce a bounded string. We do not assert exact
        // output (the joined text grows with the cap) — only that
        // the formatter returns rather than allocating without
        // bound, and that the rendered length is consistent with
        // exactly `MAX_CHORDS_PER_BAR` chords.
        let bc = || BarChord {
            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
            position: BeatPosition::on_beat(1).unwrap(),
        };
        let chords = vec![bc(); MAX_CHORDS_PER_BAR + 100];
        let line = format_bar_chord_line(&chords);
        let expected = std::iter::repeat_n("C", MAX_CHORDS_PER_BAR)
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(line, expected);
    }

    // ---- quality_glyph coverage ----

    #[test]
    fn formats_minor_triad() {
        let chord = Chord::triad(ChordRoot::natural('A'), ChordQuality::Minor);
        assert_eq!(format_chord(&chord), "Am");
    }

    #[test]
    fn formats_diminished() {
        let chord = Chord::triad(ChordRoot::natural('B'), ChordQuality::Diminished);
        assert_eq!(format_chord(&chord), "Bdim");
    }

    #[test]
    fn formats_augmented() {
        let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Augmented);
        assert_eq!(format_chord(&chord), "Caug");
    }

    #[test]
    fn formats_major_seventh() {
        let chord = Chord::triad(ChordRoot::natural('D'), ChordQuality::Major7);
        assert_eq!(format_chord(&chord), "Dmaj7");
    }

    #[test]
    fn formats_diminished_seventh() {
        let chord = Chord::triad(ChordRoot::natural('G'), ChordQuality::Diminished7);
        assert_eq!(format_chord(&chord), "Gdim7");
    }

    #[test]
    fn formats_suspended_second() {
        let chord = Chord::triad(ChordRoot::natural('A'), ChordQuality::Suspended2);
        assert_eq!(format_chord(&chord), "Asus2");
    }

    #[test]
    fn formats_suspended_fourth() {
        let chord = Chord::triad(ChordRoot::natural('E'), ChordQuality::Suspended4);
        assert_eq!(format_chord(&chord), "Esus4");
    }

    // ---- write_root accidental coverage ----

    #[test]
    fn formats_sharp_root() {
        // Accidental::Sharp in write_root — the one untested arm
        // after formats_flat_root covers Accidental::Flat.
        let chord = Chord::triad(
            ChordRoot {
                note: 'F',
                accidental: Accidental::Sharp,
            },
            ChordQuality::Minor7,
        );
        assert_eq!(format_chord(&chord), "F\u{266F}m7");
    }

    #[test]
    fn empty_bar_chord_line_is_empty() {
        assert_eq!(format_bar_chord_line(&[]), "");
    }

    #[test]
    fn multi_chord_bar_joins_with_space() {
        let bc = |note, q| BarChord {
            chord: Chord::triad(ChordRoot::natural(note), q),
            position: BeatPosition::on_beat(1).unwrap(),
        };
        let line =
            format_bar_chord_line(&[bc('C', ChordQuality::Major), bc('A', ChordQuality::Minor7)]);
        assert_eq!(line, "C Am7");
    }
}
