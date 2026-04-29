//! Tiny SVG-text helpers.

/// Escapes the five XML reserved characters so the input is safe to
/// embed inside SVG text content or attribute values.
///
/// SVG 1.1 §3.4 ("Restricted characters") matches the XML 1.0
/// minimum: `&`, `<`, `>`, `"`, and `'` must be escaped. Any
/// non-reserved character (including unescaped Unicode such as the
/// `♭` flat sign emitted by [`crate`]'s key formatter) passes
/// through unchanged because the document is UTF-8.
#[must_use]
pub(crate) fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape_xml;

    #[test]
    fn passes_plain_text_through() {
        assert_eq!(escape_xml("Autumn Leaves"), "Autumn Leaves");
    }

    #[test]
    fn escapes_all_five_reserved_characters() {
        assert_eq!(
            escape_xml("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f"
        );
    }

    #[test]
    fn passes_unicode_through_unchanged() {
        // Flat / sharp signs come from the key formatter; they
        // must reach the SVG unescaped because they are not XML-
        // reserved and the doc is UTF-8.
        assert_eq!(escape_xml("E\u{266D} minor"), "E\u{266D} minor");
        assert_eq!(escape_xml("F\u{266F} major"), "F\u{266F} major");
    }
}
