//! XML/HTML character escaping utilities.
//!
//! Provides a single shared escape function used by both the SVG chord diagram
//! generator in `chordsketch-chordpro` and the HTML renderer.

/// Escapes the five XML reserved characters and strips the C0 control
/// characters that are not legal in XML 1.0 documents.
///
/// XML 1.0 §2.2 forbids `U+0000..=U+0008`, `U+000B`, `U+000C`, and
/// `U+000E..=U+001F`; only `U+0009` (tab), `U+000A` (LF), and `U+000D`
/// (CR) are permitted from the C0 range. Without stripping, an adversarial
/// AST string containing `\0` produces syntactically invalid SVG (chord
/// diagrams) and HTML output that downstream consumers reject or behave
/// undefined on.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::escape::escape_xml;
///
/// assert_eq!(escape_xml("A&B"), "A&amp;B");
/// assert_eq!(escape_xml("it's"), "it&apos;s");
/// ```
#[must_use]
pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML-illegal C0 controls (everything below U+0020 except
            // tab / newline / carriage return) are stripped entirely so
            // SVG chord diagrams and HTML output remain well-formed even
            // when the AST carries adversarial or malformed input.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_ampersand() {
        assert_eq!(escape_xml("A&B"), "A&amp;B");
    }

    #[test]
    fn escapes_angle_brackets() {
        assert_eq!(escape_xml("A<B>C"), "A&lt;B&gt;C");
    }

    #[test]
    fn escapes_double_quote() {
        assert_eq!(escape_xml(r#"say "hi""#), "say &quot;hi&quot;");
    }

    #[test]
    fn escapes_single_quote() {
        assert_eq!(escape_xml("it's"), "it&apos;s");
    }

    #[test]
    fn no_escaping_needed() {
        assert_eq!(escape_xml("Am7"), "Am7");
    }

    #[test]
    fn empty_string() {
        assert_eq!(escape_xml(""), "");
    }

    #[test]
    fn all_special_chars() {
        assert_eq!(escape_xml("&<>\"'"), "&amp;&lt;&gt;&quot;&apos;");
    }

    #[test]
    fn strips_xml_illegal_c0_controls() {
        // NUL, BEL, vertical tab, form feed, ESC are all illegal in XML 1.0
        // (§2.2) and must be removed so SVG/HTML output stays well-formed.
        let input = "a\u{0000}b\u{0007}c\u{000B}d\u{000C}e\u{001B}f";
        assert_eq!(escape_xml(input), "abcdef");
    }

    #[test]
    fn preserves_xml_legal_whitespace() {
        // Tab (U+0009), LF (U+000A), and CR (U+000D) are the three C0 codes
        // XML 1.0 §2.2 allows; they must NOT be stripped.
        assert_eq!(escape_xml("a\tb\nc\rd"), "a\tb\nc\rd");
    }
}
