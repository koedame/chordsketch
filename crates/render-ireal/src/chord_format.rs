//! Chord-name display formatting.
//!
//! Renders an AST `Chord` as a flat single-line string suitable for
//! inline placement inside a bar cell. This is the "simple flat
//! layout" called out in the AC for #2060; full superscript
//! typography (raised extensions, alteration brackets) lands in
//! #2057 and replaces this formatter at the call site.

use chordsketch_ireal::{Accidental, Chord, ChordQuality, ChordRoot};

/// Returns the display string for the given chord.
///
/// Format: `<root><accidental><quality>[/<bass>]`. Examples:
/// `C`, `Cm7`, `B♭7`, `F♯m7♭5`, `C/G`. The quality string for
/// [`ChordQuality::Custom`] is used verbatim.
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
    // The deserializer enforces `A..=G`, but downstream consumers can
    // construct an AST with arbitrary `note` chars via direct field
    // assignment. Fall back to `?` (matching the renderer's
    // `format_key` fallback) so bogus input surfaces visibly rather
    // than producing nonsense.
    let glyph = if matches!(root.note, 'A'..='G') {
        root.note
    } else {
        '?'
    };
    out.push(glyph);
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
#[must_use]
pub(crate) fn format_bar_chord_line(chords: &[chordsketch_ireal::BarChord]) -> String {
    let mut out = String::new();
    for (i, bc) in chords.iter().enumerate() {
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
