//! Font / size / colour formatting directives (`{textfont}`, `{chordsize}`, …)
//! as every renderer reads them.
//!
//! The HTML and PDF renderers keep their own per-element style state, but
//! both need the same two answers: which element and property a directive
//! sets ([`style_target`]), and what a size value means once it is bounded
//! to a sane range ([`parse_font_size`]).

use crate::ast::DirectiveKind;

/// Minimum font size (in points) accepted from user directives.
pub const MIN_FONT_SIZE: f32 = 0.5;
/// Maximum font size (in points) accepted from user directives.
pub const MAX_FONT_SIZE: f32 = 200.0;

/// The element a formatting directive styles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StyleElement {
    /// Lyrics text (`{textfont}` …).
    Text,
    /// Chord names (`{chordfont}` …).
    Chord,
    /// Tab sections (`{tabfont}` …).
    Tab,
    /// Titles (`{titlefont}` …).
    Title,
    /// Chorus sections (`{chorusfont}` …).
    Chorus,
    /// Section labels (`{labelfont}` …).
    Label,
    /// Grid sections (`{gridfont}` …).
    Grid,
}

/// The property of a [`StyleElement`] a formatting directive sets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StyleProperty {
    /// Font family.
    Font,
    /// Font size.
    Size,
    /// Colour.
    Colour,
}

/// The element and property a font / size / colour directive sets, or `None`
/// for every other directive.
///
/// Header, footer and table-of-contents formatting directives are page-level
/// and have no element in the song body, so they return `None` too.
#[must_use]
pub fn style_target(kind: &DirectiveKind) -> Option<(StyleElement, StyleProperty)> {
    use StyleElement::{Chord, Chorus, Grid, Label, Tab, Text, Title};
    use StyleProperty::{Colour, Font, Size};
    Some(match kind {
        DirectiveKind::TextFont => (Text, Font),
        DirectiveKind::TextSize => (Text, Size),
        DirectiveKind::TextColour => (Text, Colour),
        DirectiveKind::ChordFont => (Chord, Font),
        DirectiveKind::ChordSize => (Chord, Size),
        DirectiveKind::ChordColour => (Chord, Colour),
        DirectiveKind::TabFont => (Tab, Font),
        DirectiveKind::TabSize => (Tab, Size),
        DirectiveKind::TabColour => (Tab, Colour),
        DirectiveKind::TitleFont => (Title, Font),
        DirectiveKind::TitleSize => (Title, Size),
        DirectiveKind::TitleColour => (Title, Colour),
        DirectiveKind::ChorusFont => (Chorus, Font),
        DirectiveKind::ChorusSize => (Chorus, Size),
        DirectiveKind::ChorusColour => (Chorus, Colour),
        DirectiveKind::LabelFont => (Label, Font),
        DirectiveKind::LabelSize => (Label, Size),
        DirectiveKind::LabelColour => (Label, Colour),
        DirectiveKind::GridFont => (Grid, Font),
        DirectiveKind::GridSize => (Grid, Size),
        DirectiveKind::GridColour => (Grid, Colour),
        _ => return None,
    })
}

/// Parse a size directive value and bound it to
/// `[MIN_FONT_SIZE, MAX_FONT_SIZE]`, so an extreme value cannot produce
/// degenerate CSS or page layout. Returns `None` when the value is missing or
/// not a number (`NaN` parses as a float but is not a size, so it is `None`
/// too).
#[must_use]
pub fn parse_font_size(value: Option<&str>) -> Option<f32> {
    value
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|s| !s.is_nan())
        .map(|s| s.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_target_maps_every_body_font_size_colour_directive_to_its_element() {
        let cases = [
            ("text", StyleElement::Text),
            ("chord", StyleElement::Chord),
            ("tab", StyleElement::Tab),
            ("title", StyleElement::Title),
            ("chorus", StyleElement::Chorus),
            ("label", StyleElement::Label),
            ("grid", StyleElement::Grid),
        ];
        for (prefix, element) in cases {
            for (suffix, property) in [
                ("font", StyleProperty::Font),
                ("size", StyleProperty::Size),
                ("colour", StyleProperty::Colour),
            ] {
                let kind = DirectiveKind::from_name(&format!("{prefix}{suffix}"));
                assert_eq!(
                    style_target(&kind),
                    Some((element, property)),
                    "{prefix}{suffix}"
                );
            }
        }
    }

    #[test]
    fn style_target_is_none_for_page_level_and_unrelated_directives() {
        for name in ["headerfont", "footersize", "tocfont", "title", "comment"] {
            let kind = DirectiveKind::from_name(name);
            assert_eq!(style_target(&kind), None, "{name}");
        }
    }

    #[test]
    fn parse_font_size_clamps_to_the_accepted_range() {
        assert_eq!(parse_font_size(Some("12")), Some(12.0));
        assert_eq!(parse_font_size(Some("12.5")), Some(12.5));
        assert_eq!(parse_font_size(Some("99999")), Some(MAX_FONT_SIZE));
        assert_eq!(parse_font_size(Some("-4")), Some(MIN_FONT_SIZE));
        assert_eq!(parse_font_size(Some("0")), Some(MIN_FONT_SIZE));
        assert_eq!(parse_font_size(Some("inf")), Some(MAX_FONT_SIZE));
        assert_eq!(parse_font_size(Some("-inf")), Some(MIN_FONT_SIZE));
    }

    #[test]
    fn parse_font_size_is_none_when_the_value_is_missing_or_not_a_number() {
        assert_eq!(parse_font_size(None), None);
        assert_eq!(parse_font_size(Some("big")), None);
        assert_eq!(parse_font_size(Some("")), None);
        assert_eq!(
            parse_font_size(Some(" 12")),
            None,
            "whitespace is not trimmed"
        );
        assert_eq!(parse_font_size(Some("NaN")), None);
        assert_eq!(parse_font_size(Some("nan")), None);
    }
}
