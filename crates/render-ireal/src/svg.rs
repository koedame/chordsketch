//! Tiny SVG-text helpers.
//!
//! # Fix-propagation note
//!
//! `chordsketch-chordpro` carries a near-identical `escape_xml`
//! helper at `crates/chordpro/src/escape.rs`. The duplication is
//! intentional — the `[forbid(unsafe_code)] + zero-external-deps`
//! posture of both AST crates makes a shared crate tempting but
//! premature for a single helper. Per
//! `.claude/rules/fix-propagation.md`, any future hardening of
//! either copy (e.g. adding XML 1.1 control-char handling, or
//! switching to `Cow<'_, str>` to skip allocation on no-op input)
//! MUST be applied to both call sites in the same PR. If the
//! duplication grows to more than one helper, factor into a tiny
//! shared crate.

/// Escapes the five XML reserved characters and strips the C0
/// control characters that are not legal in XML 1.0 documents, so
/// the input is safe to embed inside SVG text content or attribute
/// values.
///
/// XML 1.0 §2.2 forbids `U+0000..=U+0008`, `U+000B`, `U+000C`,
/// and `U+000E..=U+001F`; only `U+0009` (tab), `U+000A` (LF), and
/// `U+000D` (CR) are permitted from the C0 range. SVG 1.1 §3.4
/// inherits the same restriction. Without stripping, an
/// adversarial AST string containing `\0` produces a syntactically
/// invalid SVG that downstream consumers (the future PDF
/// rasteriser #2063, the PNG rasteriser #2064, and ordinary
/// browsers) reject or behave undefined on.
///
/// Non-reserved Unicode (including unescaped scalars such as the
/// `♭` flat sign emitted by the key formatter) passes through
/// unchanged because the document is UTF-8.
#[must_use]
pub(crate) fn escape_xml(input: &str) -> String {
    // Capacity hint covers the no-escape case; escape-heavy input
    // re-grows geometrically. `+ 16` slots in headroom for the
    // common one-or-two-escape titles to avoid the first re-alloc.
    let mut out = String::with_capacity(input.len() + 16);
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML-illegal C0 controls (everything below U+0020
            // except tab / newline / carriage return) are stripped
            // entirely — the rendered SVG remains well-formed
            // even when the AST carries adversarial bytes.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
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

    #[test]
    fn strips_xml_illegal_c0_controls() {
        // NUL, BEL, vertical tab, form feed, ESC are all illegal
        // in XML 1.0 and must be removed silently.
        let input = "a\u{0000}b\u{0007}c\u{000B}d\u{000C}e\u{001B}f";
        assert_eq!(escape_xml(input), "abcdef");
    }

    #[test]
    fn preserves_xml_legal_whitespace() {
        // Tab, LF, and CR are the three C0 codes XML allows; they
        // must NOT be stripped.
        assert_eq!(escape_xml("a\tb\nc\rd"), "a\tb\nc\rd");
    }
}
