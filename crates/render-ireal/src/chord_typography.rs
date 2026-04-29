//! Chord-name typography splitter.
//!
//! Decomposes a [`Chord`] into a sequence of [`TypographySpan`]s
//! the SVG renderer emits as `<tspan>` elements with mixed font
//! sizes and baseline shifts. Implements the iReal Pro convention:
//! root letter at base size, quality / extensions raised as
//! superscript at a smaller size, slash + bass back at base size on
//! the original baseline.
//!
//! # Why split here, not in the AST
//!
//! `chordsketch_ireal::Chord` stores `(root, quality, bass)`
//! structurally — no string parsing is needed for the named
//! [`ChordQuality`] variants. For
//! [`ChordQuality::Custom`] the string is already
//! post-root-token-only (see the AST's `Custom` doc), so the entire
//! `Custom` payload is treated as one superscript block. A real
//! per-token split (separating "9" from "♭13" inside `7♭9♯11`)
//! belongs in the URL parser (#2054) which owns the parsing
//! discipline; the typography layer consumes whatever the AST
//! produces.

use chordsketch_ireal::{Chord, ChordQuality, ChordRoot};

use crate::note_glyph_or_fallback;

/// Role of a typography span. The renderer maps each role to a
/// font size and baseline shift; see
/// [`crate::CHORD_FONT_SIZE_BASE`] /
/// [`crate::CHORD_FONT_SIZE_SUPERSCRIPT`] for the constants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanKind {
    /// Root letter + accidental, base size, on the cell's chord
    /// baseline.
    Root,
    /// Quality / extension(s), smaller size, raised baseline.
    Extension,
    /// Forward slash separating bass from the chord; base size, on
    /// the original baseline.
    Slash,
    /// Bass note + accidental after a slash; base size, on the
    /// original baseline.
    Bass,
}

/// One run of glyphs sharing a font size and baseline shift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypographySpan {
    /// Display string for this span. The accidental glyph is
    /// `\u{266D}` (♭) / `\u{266F}` (♯) — XML reserved characters
    /// inside a `Custom` quality are handled at the SVG embedding
    /// boundary, not here.
    pub text: String,
    /// Role this span plays in the chord-name layout.
    pub kind: SpanKind,
}

/// Typography decomposition of a chord, ready for SVG emission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChordTypography {
    /// Spans in left-to-right order. Always starts with one
    /// [`SpanKind::Root`]; followed optionally by one
    /// [`SpanKind::Extension`]; followed optionally by one
    /// [`SpanKind::Slash`] + one [`SpanKind::Bass`] (the slash
    /// without a bass is unrepresentable).
    pub spans: Vec<TypographySpan>,
}

/// Decomposes `chord` into typography spans suitable for SVG
/// `<tspan>` emission.
///
/// The returned [`ChordTypography`] is the layer the renderer uses
/// to lay out a chord; downstream consumers (the future PNG
/// rasteriser #2064 and the PDF rasteriser #2063) can also inspect
/// the spans to compute alternative layouts without re-rendering
/// the SVG.
#[must_use]
pub fn chord_to_typography(chord: &Chord) -> ChordTypography {
    let mut spans = Vec::with_capacity(4);
    spans.push(TypographySpan {
        text: format_root(chord.root),
        kind: SpanKind::Root,
    });
    let ext = quality_extension(&chord.quality);
    if !ext.is_empty() {
        spans.push(TypographySpan {
            text: ext,
            kind: SpanKind::Extension,
        });
    }
    if let Some(bass) = chord.bass {
        spans.push(TypographySpan {
            text: "/".to_string(),
            kind: SpanKind::Slash,
        });
        spans.push(TypographySpan {
            text: format_root(bass),
            kind: SpanKind::Bass,
        });
    }
    ChordTypography { spans }
}

fn format_root(root: ChordRoot) -> String {
    let mut out = String::with_capacity(2);
    out.push(note_glyph_or_fallback(root.note));
    out.push_str(match root.accidental {
        chordsketch_ireal::Accidental::Natural => "",
        chordsketch_ireal::Accidental::Flat => "\u{266D}",
        chordsketch_ireal::Accidental::Sharp => "\u{266F}",
    });
    out
}

fn quality_extension(q: &ChordQuality) -> String {
    match q {
        ChordQuality::Major => String::new(),
        ChordQuality::Minor => "m".to_string(),
        ChordQuality::Diminished => "dim".to_string(),
        ChordQuality::Augmented => "aug".to_string(),
        ChordQuality::Major7 => "maj7".to_string(),
        ChordQuality::Minor7 => "m7".to_string(),
        ChordQuality::Dominant7 => "7".to_string(),
        ChordQuality::HalfDiminished => "m7\u{266D}5".to_string(),
        ChordQuality::Diminished7 => "dim7".to_string(),
        ChordQuality::Suspended2 => "sus2".to_string(),
        ChordQuality::Suspended4 => "sus4".to_string(),
        ChordQuality::Custom(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{SpanKind, chord_to_typography};
    use chordsketch_ireal::{Accidental, Chord, ChordQuality, ChordRoot};

    fn span_kinds(spans: &[super::TypographySpan]) -> Vec<SpanKind> {
        spans.iter().map(|s| s.kind).collect()
    }

    fn span_texts(spans: &[super::TypographySpan]) -> Vec<&str> {
        spans.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn major_triad_has_only_a_root_span() {
        let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Major);
        let typo = chord_to_typography(&chord);
        assert_eq!(span_kinds(&typo.spans), vec![SpanKind::Root]);
        assert_eq!(span_texts(&typo.spans), vec!["C"]);
    }

    #[test]
    fn minor_seventh_splits_into_root_and_extension() {
        let chord = Chord::triad(ChordRoot::natural('A'), ChordQuality::Minor7);
        let typo = chord_to_typography(&chord);
        assert_eq!(
            span_kinds(&typo.spans),
            vec![SpanKind::Root, SpanKind::Extension]
        );
        assert_eq!(span_texts(&typo.spans), vec!["A", "m7"]);
    }

    #[test]
    fn flat_root_emits_unicode_flat_glyph_in_root_span() {
        let chord = Chord::triad(
            ChordRoot {
                note: 'B',
                accidental: Accidental::Flat,
            },
            ChordQuality::Dominant7,
        );
        let typo = chord_to_typography(&chord);
        assert_eq!(typo.spans[0].kind, SpanKind::Root);
        assert_eq!(typo.spans[0].text, "B\u{266D}");
        assert_eq!(typo.spans[1].kind, SpanKind::Extension);
        assert_eq!(typo.spans[1].text, "7");
    }

    #[test]
    fn slash_chord_emits_root_extension_slash_bass() {
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major7,
            bass: Some(ChordRoot::natural('G')),
        };
        let typo = chord_to_typography(&chord);
        assert_eq!(
            span_kinds(&typo.spans),
            vec![
                SpanKind::Root,
                SpanKind::Extension,
                SpanKind::Slash,
                SpanKind::Bass,
            ]
        );
        assert_eq!(span_texts(&typo.spans), vec!["C", "maj7", "/", "G"]);
    }

    #[test]
    fn slash_chord_without_quality_skips_extension_span() {
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major,
            bass: Some(ChordRoot::natural('E')),
        };
        let typo = chord_to_typography(&chord);
        assert_eq!(
            span_kinds(&typo.spans),
            vec![SpanKind::Root, SpanKind::Slash, SpanKind::Bass]
        );
        assert_eq!(span_texts(&typo.spans), vec!["C", "/", "E"]);
    }

    #[test]
    fn custom_quality_becomes_single_extension_span_verbatim() {
        let chord = Chord::triad(
            ChordRoot::natural('C'),
            ChordQuality::Custom("13\u{266F}11".into()),
        );
        let typo = chord_to_typography(&chord);
        assert_eq!(span_texts(&typo.spans), vec!["C", "13\u{266F}11"]);
        assert_eq!(typo.spans[1].kind, SpanKind::Extension);
    }

    #[test]
    fn out_of_range_root_uses_question_mark_fallback() {
        let chord = Chord::triad(
            ChordRoot {
                note: 'X',
                accidental: Accidental::Natural,
            },
            ChordQuality::Major,
        );
        let typo = chord_to_typography(&chord);
        assert_eq!(span_texts(&typo.spans), vec!["?"]);
    }

    #[test]
    fn out_of_range_bass_uses_question_mark_fallback() {
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major,
            bass: Some(ChordRoot {
                note: '<',
                accidental: Accidental::Natural,
            }),
        };
        let typo = chord_to_typography(&chord);
        assert_eq!(typo.spans.last().unwrap().kind, SpanKind::Bass);
        assert_eq!(typo.spans.last().unwrap().text, "?");
    }

    #[test]
    fn half_diminished_emits_compound_unicode_extension() {
        let chord = Chord::triad(ChordRoot::natural('F'), ChordQuality::HalfDiminished);
        let typo = chord_to_typography(&chord);
        assert_eq!(typo.spans[1].text, "m7\u{266D}5");
    }

    #[test]
    fn sharp_root_emits_unicode_sharp_glyph_in_root_span() {
        let chord = Chord::triad(
            ChordRoot {
                note: 'F',
                accidental: Accidental::Sharp,
            },
            ChordQuality::Major,
        );
        let typo = chord_to_typography(&chord);
        assert_eq!(typo.spans[0].text, "F\u{266F}");
    }

    #[test]
    fn each_quality_extension_glyph_round_trips() {
        // Exercises every named `ChordQuality` arm in
        // `quality_extension`. A new arm added without a paired
        // test here causes the glyph to silently render as
        // whatever the new arm produces — the assertions below
        // would either still pass (regression by replacement) or
        // need updating, both of which are visible in code review.
        let cases = [
            (ChordQuality::Major, ""),
            (ChordQuality::Minor, "m"),
            (ChordQuality::Diminished, "dim"),
            (ChordQuality::Augmented, "aug"),
            (ChordQuality::Major7, "maj7"),
            (ChordQuality::Minor7, "m7"),
            (ChordQuality::Dominant7, "7"),
            (ChordQuality::HalfDiminished, "m7\u{266D}5"),
            (ChordQuality::Diminished7, "dim7"),
            (ChordQuality::Suspended2, "sus2"),
            (ChordQuality::Suspended4, "sus4"),
        ];
        for (quality, expected) in cases {
            let chord = Chord::triad(ChordRoot::natural('C'), quality.clone());
            let typo = chord_to_typography(&chord);
            let actual = if expected.is_empty() {
                // Major triad collapses to a single root span.
                assert_eq!(typo.spans.len(), 1, "{quality:?}");
                ""
            } else {
                assert_eq!(typo.spans.len(), 2, "{quality:?}");
                typo.spans[1].text.as_str()
            };
            assert_eq!(actual, expected, "quality {quality:?}");
        }
    }
}
