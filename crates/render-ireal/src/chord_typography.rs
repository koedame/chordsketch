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
///
/// Engraved-chart layout (`design-system/ui_kits/web/editor-irealb.html`)
/// renders the root letter at full size on the chord baseline, with
/// the accidental ABOVE-baseline (superscript) at a slightly
/// smaller size and the quality BELOW-baseline (subscript) at the
/// same smaller size. The four span kinds map to those four
/// metric positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanKind {
    /// Root letter only (no accidental), base size, on the chord
    /// baseline. The accidental — when present — is split out into
    /// its own [`SpanKind::Accidental`] span so the renderer can
    /// raise it at superscript size without affecting the root.
    Root,
    /// Sharp / flat that follows a root or bass letter. Smaller
    /// font + raised baseline.
    Accidental,
    /// Quality / extension(s), smaller size, slight subscript.
    Extension,
    /// Forward slash separating bass from the chord; base size, on
    /// the original baseline.
    Slash,
    /// Bass note (without accidental) after a slash; base size, on
    /// the original baseline.
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
    let mut spans = Vec::with_capacity(5);
    push_letter_with_accidental(&mut spans, chord.root, SpanKind::Root);
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
        push_letter_with_accidental(&mut spans, bass, SpanKind::Bass);
    }
    ChordTypography { spans }
}

/// Push the letter portion of a root / bass and (optionally) the
/// accidental as a separate raised-baseline span. Splitting the
/// accidental out lets the SVG renderer style it as a superscript
/// glyph the way `editor-irealb.html` does, instead of treating
/// the whole "F\u{266F}" string as one root span.
fn push_letter_with_accidental(
    spans: &mut Vec<TypographySpan>,
    root: ChordRoot,
    letter_kind: SpanKind,
) {
    let mut letter = String::with_capacity(1);
    letter.push(note_glyph_or_fallback(root.note));
    spans.push(TypographySpan {
        text: letter,
        kind: letter_kind,
    });
    let acc = match root.accidental {
        chordsketch_ireal::Accidental::Natural => "",
        chordsketch_ireal::Accidental::Flat => "\u{266D}",
        chordsketch_ireal::Accidental::Sharp => "\u{266F}",
    };
    if !acc.is_empty() {
        spans.push(TypographySpan {
            text: acc.to_string(),
            kind: SpanKind::Accidental,
        });
    }
}

fn quality_extension(q: &ChordQuality) -> String {
    // Glyphs follow `design-system/ui_kits/web/editor-irealb.html`
    // §"Chord typography" — Greek / Latin Unicode stand-ins (Δ, ø,
    // −, °, +) so the whole quality reads from the same regular
    // text font as the digits.
    match q {
        ChordQuality::Major => String::new(),
        // U+2212 MINUS SIGN — visually heavier than ASCII '-' and
        // matches the iReal Pro printed convention.
        ChordQuality::Minor => "\u{2212}".to_string(),
        ChordQuality::Diminished => "\u{00B0}".to_string(), // °
        ChordQuality::Augmented => "+".to_string(),
        ChordQuality::Major7 => "\u{0394}7".to_string(), // Δ7
        ChordQuality::Minor7 => "\u{2212}7".to_string(), // −7
        ChordQuality::Dominant7 => "7".to_string(),
        // U+00F8 LATIN SMALL LETTER O WITH STROKE — used in
        // half-diminished chord symbols. Followed by `7` as in
        // editor-irealb.html (`ø7`), not the older `m7♭5`.
        ChordQuality::HalfDiminished => "\u{00F8}7".to_string(), // ø7
        ChordQuality::Diminished7 => "\u{00B0}7".to_string(),    // °7
        ChordQuality::Suspended2 => "sus2".to_string(),
        ChordQuality::Suspended4 => "sus4".to_string(),
        // iReal Pro stores tension qualities (`9b7`, `^9`, `h7`,
        // `7b9#5`, …) in `Custom` because the structured enum
        // can't model arbitrary tensions. The URL uses ASCII
        // shorthand for the music symbols; this layer translates
        // them to the typeset glyphs the chart should render.
        // Without this step, a chord like `B♭^9` shows as the
        // literal `B♭^9` instead of `B♭Δ9`.
        ChordQuality::Custom(s) => translate_url_shorthand(s),
    }
}

/// Translate iReal Pro's URL-stored quality shorthand into the
/// typeset glyphs the engraved chart expects.
///
/// | URL shorthand | Glyph                       |
/// |---------------|-----------------------------|
/// | `^`           | `Δ` (U+0394, major-7 marker) |
/// | `h`           | `ø` (U+00F8, half-diminished)|
/// | `o`           | `°` (U+00B0, diminished)     |
/// | `-`           | `−` (U+2212, minor)          |
/// | `b`           | `♭` (U+266D, flat)           |
/// | `#`           | `♯` (U+266F, sharp)          |
///
/// Digits (`7`, `9`, `13`, `11`, `5`, …) and `+` / `sus` pass
/// through unchanged.
///
/// When the translated quality contains two or more alteration
/// runs (e.g. `♭9♯5` after translating `b9#5`), the result is
/// split into two lines joined by `|` — the iReal Pro engraved
/// convention is to stack the second alteration vertically below
/// the first. The downstream renderer (`spansToHtml` in the
/// playground / `lib.rs::write_grid` in the SVG renderer) treats
/// `|` as a stacked-quality separator.
fn translate_url_shorthand(raw: &str) -> String {
    let translated: String = raw
        .chars()
        .map(|c| match c {
            '^' => '\u{0394}',
            'h' => '\u{00F8}',
            'o' => '\u{00B0}',
            '-' => '\u{2212}',
            'b' => '\u{266D}',
            '#' => '\u{266F}',
            other => other,
        })
        .collect();
    let parts = split_alterations(&translated);
    if parts.alterations.len() >= 2 {
        let mut first_line = parts.main;
        first_line.push_str(&parts.alterations[0]);
        let rest: String = parts.alterations[1..].concat();
        format!("{first_line}|{rest}")
    } else {
        translated
    }
}

struct ExtensionParts {
    main: String,
    alterations: Vec<String>,
}

/// Split a translated extension string into the leading "type"
/// part (e.g. `7`, `Δ7`, `ø7`, `13`) and trailing alteration runs
/// (each is a `♭` / `♯` followed by 1–2 digits, e.g. `♭9`, `♯5`).
fn split_alterations(s: &str) -> ExtensionParts {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if (c == '\u{266D}' || c == '\u{266F}')
            && i + 1 < chars.len()
            && chars[i + 1].is_ascii_digit()
        {
            break;
        }
        i += 1;
    }
    let main: String = chars[..i].iter().collect();
    let mut alterations = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c == '\u{266D}' || c == '\u{266F}' {
            let mut alt = String::with_capacity(3);
            alt.push(c);
            i += 1;
            while i < chars.len() && chars[i].is_ascii_digit() {
                alt.push(chars[i]);
                i += 1;
            }
            alterations.push(alt);
        } else {
            i += 1;
        }
    }
    ExtensionParts { main, alterations }
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
        assert_eq!(span_texts(&typo.spans), vec!["A", "\u{2212}7"]);
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
        // Engraved-chart layout splits the root letter and the
        // accidental into separate spans so the SVG renderer can
        // raise the accidental at superscript size.
        assert_eq!(typo.spans[0].kind, SpanKind::Root);
        assert_eq!(typo.spans[0].text, "B");
        assert_eq!(typo.spans[1].kind, SpanKind::Accidental);
        assert_eq!(typo.spans[1].text, "\u{266D}");
        assert_eq!(typo.spans[2].kind, SpanKind::Extension);
        assert_eq!(typo.spans[2].text, "7");
    }

    #[test]
    fn slash_chord_emits_root_extension_slash_bass() {
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major7,
            bass: Some(ChordRoot::natural('G')),
            alternate: None,
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
        assert_eq!(span_texts(&typo.spans), vec!["C", "\u{0394}7", "/", "G"]);
    }

    #[test]
    fn slash_chord_without_quality_skips_extension_span() {
        let chord = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major,
            bass: Some(ChordRoot::natural('E')),
            alternate: None,
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
            alternate: None,
        };
        let typo = chord_to_typography(&chord);
        assert_eq!(typo.spans.last().unwrap().kind, SpanKind::Bass);
        assert_eq!(typo.spans.last().unwrap().text, "?");
    }

    #[test]
    fn half_diminished_emits_compound_unicode_extension() {
        let chord = Chord::triad(ChordRoot::natural('F'), ChordQuality::HalfDiminished);
        let typo = chord_to_typography(&chord);
        assert_eq!(typo.spans[1].text, "\u{00F8}7");
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
        assert_eq!(typo.spans[0].kind, SpanKind::Root);
        assert_eq!(typo.spans[0].text, "F");
        assert_eq!(typo.spans[1].kind, SpanKind::Accidental);
        assert_eq!(typo.spans[1].text, "\u{266F}");
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
            (ChordQuality::Minor, "\u{2212}"),
            (ChordQuality::Diminished, "\u{00B0}"),
            (ChordQuality::Augmented, "+"),
            (ChordQuality::Major7, "\u{0394}7"),
            (ChordQuality::Minor7, "\u{2212}7"),
            (ChordQuality::Dominant7, "7"),
            (ChordQuality::HalfDiminished, "\u{00F8}7"),
            (ChordQuality::Diminished7, "\u{00B0}7"),
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
