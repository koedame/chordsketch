//! Notation block kinds recognised by the text and PDF renderers.
//!
//! ChordPro documents can embed four kinds of external notation via
//! `{start_of_<tag>} … {end_of_<tag>}` pairs: ABC, Lilypond, MusicXML,
//! and SVG. The HTML renderer invokes external tools (`abc2svg`,
//! `lilypond`, `musescore`) to convert them into embedded SVG; the
//! text and PDF renderers cannot do the same cheaply and instead emit
//! a structured warning + placeholder while skipping the block body.
//!
//! This module is the single source of truth for the four variants
//! and their string representations. Both non-HTML renderers import
//! [`NotationKind`] from here so adding a fifth notation kind is a
//! one-line change — new variant, new entry in each helper's match.
//!
//! The HTML renderer does not depend on this module because it
//! handles every notation kind via bespoke rendering paths in its
//! own source (see `crates/render-html/src/lib.rs`).

use crate::ast::DirectiveKind;

/// Notation kinds the text and PDF renderers skip rather than render.
///
/// See `.claude/rules/renderer-parity.md` for the parity contract:
/// every renderer must handle every directive, but handling can be
/// "skip with warning" when full rendering requires infrastructure a
/// renderer does not have.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotationKind {
    /// `{start_of_abc} … {end_of_abc}` — ABC notation.
    Abc,
    /// `{start_of_ly} … {end_of_ly}` — Lilypond notation.
    Lilypond,
    /// `{start_of_musicxml} … {end_of_musicxml}` — MusicXML notation.
    MusicXml,
    /// `{start_of_svg} … {end_of_svg}` — inline SVG.
    Svg,
}

impl NotationKind {
    /// Human-readable display name for user-facing output (section
    /// label, placeholder text, warning message).
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Abc => "ABC",
            Self::Lilypond => "Lilypond",
            Self::MusicXml => "MusicXML",
            Self::Svg => "SVG",
        }
    }

    /// ChordPro directive token for this notation kind (e.g. `"abc"`
    /// for `{start_of_abc}` / `{end_of_abc}`). Used when building
    /// warning messages that embed the tag so users can search the
    /// spec for the exact directive name they hit.
    #[must_use]
    pub fn tag(self) -> &'static str {
        match self {
            Self::Abc => "abc",
            Self::Lilypond => "ly",
            Self::MusicXml => "musicxml",
            Self::Svg => "svg",
        }
    }

    /// Returns the [`NotationKind`] corresponding to the supplied
    /// `StartOf…` directive, or [`None`] for any other directive.
    #[must_use]
    pub fn from_start_directive(kind: &DirectiveKind) -> Option<Self> {
        match kind {
            DirectiveKind::StartOfAbc => Some(Self::Abc),
            DirectiveKind::StartOfLy => Some(Self::Lilypond),
            DirectiveKind::StartOfMusicxml => Some(Self::MusicXml),
            DirectiveKind::StartOfSvg => Some(Self::Svg),
            _ => None,
        }
    }

    /// Returns `true` when `kind` is the matching `EndOf…` directive
    /// for this notation. Used by the renderer's skip-until-end
    /// window to know when to exit.
    #[must_use]
    pub fn is_end_directive(self, kind: &DirectiveKind) -> bool {
        matches!(
            (self, kind),
            (Self::Abc, DirectiveKind::EndOfAbc)
                | (Self::Lilypond, DirectiveKind::EndOfLy)
                | (Self::MusicXml, DirectiveKind::EndOfMusicxml)
                | (Self::Svg, DirectiveKind::EndOfSvg),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_the_display_name() {
        assert_eq!(NotationKind::Abc.label(), "ABC");
        assert_eq!(NotationKind::Lilypond.label(), "Lilypond");
        assert_eq!(NotationKind::MusicXml.label(), "MusicXML");
        assert_eq!(NotationKind::Svg.label(), "SVG");
    }

    #[test]
    fn tag_is_the_directive_token() {
        assert_eq!(NotationKind::Abc.tag(), "abc");
        assert_eq!(NotationKind::Lilypond.tag(), "ly");
        assert_eq!(NotationKind::MusicXml.tag(), "musicxml");
        assert_eq!(NotationKind::Svg.tag(), "svg");
    }

    #[test]
    fn from_start_directive_matches_every_variant() {
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::StartOfAbc),
            Some(NotationKind::Abc)
        );
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::StartOfLy),
            Some(NotationKind::Lilypond)
        );
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::StartOfMusicxml),
            Some(NotationKind::MusicXml)
        );
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::StartOfSvg),
            Some(NotationKind::Svg)
        );
    }

    #[test]
    fn from_start_directive_ignores_unrelated_directives() {
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::StartOfChorus),
            None
        );
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::StartOfTextblock),
            None,
            "StartOfTextblock is NOT a notation block — the text and PDF \
             renderers render its body as plain text",
        );
        // The `EndOf…` variants also do not match.
        assert_eq!(
            NotationKind::from_start_directive(&DirectiveKind::EndOfAbc),
            None
        );
    }

    #[test]
    fn is_end_directive_matches_only_the_paired_end() {
        assert!(NotationKind::Abc.is_end_directive(&DirectiveKind::EndOfAbc));
        assert!(NotationKind::Lilypond.is_end_directive(&DirectiveKind::EndOfLy));
        assert!(NotationKind::MusicXml.is_end_directive(&DirectiveKind::EndOfMusicxml));
        assert!(NotationKind::Svg.is_end_directive(&DirectiveKind::EndOfSvg));
    }

    #[test]
    fn is_end_directive_rejects_mismatched_pairs() {
        // EndOfLy does NOT close an ABC skip window, and so on.
        assert!(!NotationKind::Abc.is_end_directive(&DirectiveKind::EndOfLy));
        assert!(!NotationKind::Lilypond.is_end_directive(&DirectiveKind::EndOfAbc));
        assert!(!NotationKind::MusicXml.is_end_directive(&DirectiveKind::EndOfSvg));
        assert!(!NotationKind::Svg.is_end_directive(&DirectiveKind::EndOfMusicxml));
        // And unrelated directives never close the window.
        assert!(!NotationKind::Abc.is_end_directive(&DirectiveKind::EndOfChorus));
    }
}
