//! Allowlist sanitizer for raw SVG markup embedded in HTML output.
//!
//! `{start_of_svg}` sections and the SVG produced by external notation
//! tools (abc2svg, LilyPond, MuseScore) are untrusted. Rather than hunting
//! for dangerous constructs in the input, [`sanitize_svg_content`] parses it
//! into tags and text and writes the output from scratch:
//!
//! - an element is re-emitted only if its name is in [`ALLOWED_ELEMENTS`];
//!   other elements lose their tag (their children are still processed), and
//!   elements that can run code or load resources are dropped together with
//!   their content ([`SKIP_SUBTREE`]);
//! - an attribute is re-emitted only if its name is in [`ALLOWED_ATTRS`], its
//!   character references decode cleanly, and its value passes the check for
//!   its kind (fragment-only `href`, local-only `url(...)`, strict `style`);
//! - values are escaped on the way out and a `<` in text that does not start a
//!   tag is written as `&lt;`.
//!
//! Because everything written is either an allowlisted tag rebuilt from
//! checked parts or escaped text, the output does not depend on how a browser
//! would have parsed the original markup.

/// Elements that are written to the output. Everything else loses its tag.
const ALLOWED_ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "a",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textpath",
    "title",
    "desc",
    "lineargradient",
    "radialgradient",
    "stop",
    "pattern",
    "clippath",
    "mask",
    "marker",
];

/// Elements removed together with everything inside them: they run code,
/// load resources, switch to another content model, or carry content that
/// must not be shown as text once the tag is gone. Matched on the local name
/// (after the last `:`), so `<svg:script>` is covered.
const SKIP_SUBTREE: &[&str] = &[
    "script",
    "style",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "applet",
    "frame",
    "frameset",
    "portal",
    "math",
    "noscript",
    "noembed",
    "noframes",
    "template",
    "xmp",
    "textarea",
    "plaintext",
    "select",
    "audio",
    "video",
    "canvas",
    "feimage",
    "image",
    "set",
    "animate",
    "animatetransform",
    "animatemotion",
    "metadata",
];

/// Elements whose content is raw text in HTML: it ends at the first matching
/// end tag and is never parsed as markup.
const RAW_TEXT: &[&str] = &[
    "script",
    "style",
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "xmp",
    "textarea",
    "plaintext",
];

/// Attributes that are written to the output (compared case-insensitively).
const ALLOWED_ATTRS: &[&str] = &[
    // Identity and accessibility.
    "id",
    "class",
    "lang",
    "xml:lang",
    "xml:space",
    "role",
    "aria-label",
    "aria-hidden",
    "style",
    // Namespaces (value checked).
    "xmlns",
    "xmlns:xlink",
    // References (fragment-only).
    "href",
    "xlink:href",
    // Geometry.
    "version",
    "viewbox",
    "preserveaspectratio",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fx",
    "fy",
    "fr",
    "refx",
    "refy",
    "width",
    "height",
    "d",
    "points",
    "pathlength",
    "dx",
    "dy",
    "rotate",
    "textlength",
    "lengthadjust",
    "transform",
    "markerwidth",
    "markerheight",
    "markerunits",
    "orient",
    "offset",
    // Paint servers, clipping and masking.
    "gradientunits",
    "gradienttransform",
    "spreadmethod",
    "patternunits",
    "patterncontentunits",
    "patterntransform",
    "clippathunits",
    "maskunits",
    "maskcontentunits",
    // Presentation.
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "stop-color",
    "stop-opacity",
    "opacity",
    "color",
    "display",
    "visibility",
    "overflow",
    "clip-path",
    "clip-rule",
    "mask",
    "marker-start",
    "marker-mid",
    "marker-end",
    "paint-order",
    "vector-effect",
    "shape-rendering",
    "text-rendering",
    "color-interpolation",
    // Text.
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-variant",
    "font-stretch",
    "text-anchor",
    "text-decoration",
    "letter-spacing",
    "word-spacing",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "writing-mode",
    "direction",
    "unicode-bidi",
];

/// Attributes whose value may contain `url(...)`; every reference must be a
/// fragment of this document.
const URL_VALUED_ATTRS: &[&str] = &[
    "fill",
    "stroke",
    "clip-path",
    "mask",
    "marker-start",
    "marker-mid",
    "marker-end",
];

/// CSS properties accepted inside a `style` attribute.
const ALLOWED_STYLE_PROPERTIES: &[&str] = &[
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "stop-color",
    "stop-opacity",
    "opacity",
    "color",
    "display",
    "visibility",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-variant",
    "font-stretch",
    "text-anchor",
    "text-decoration",
    "letter-spacing",
    "word-spacing",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "writing-mode",
    "direction",
    "paint-order",
    "vector-effect",
    "shape-rendering",
    "text-rendering",
];

/// CSS functions accepted in a `style` value. `url` is further restricted to
/// fragment references.
const ALLOWED_STYLE_FUNCTIONS: &[&str] = &["rgb", "rgba", "hsl", "hsla", "url"];

const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE: &str = "http://www.w3.org/1999/xlink";

/// Sanitize untrusted SVG markup for embedding in an HTML document.
///
/// See the module documentation for the policy.
pub(crate) fn sanitize_svg_content(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pos = 0;
    while let Some((token, next)) = next_token(input, pos) {
        pos = next;
        match token {
            Token::Text(text) => out.push_str(text),
            Token::StrayLt => out.push_str("&lt;"),
            Token::Dropped => {}
            Token::Close(tag) => {
                if is_allowed_element(&tag.name.to_ascii_lowercase()) {
                    out.push_str("</");
                    out.push_str(tag.name);
                    out.push('>');
                }
            }
            Token::Open(tag) => {
                let lname = tag.name.to_ascii_lowercase();
                let local = lname.rsplit(':').next().unwrap_or(&lname);
                if SKIP_SUBTREE.contains(&local) {
                    if !tag.self_closing {
                        pos = skip_subtree(input, pos, &lname, local);
                    }
                } else if is_allowed_element(&lname) {
                    write_open_tag(&tag, &mut out);
                }
            }
        }
    }
    out
}

fn is_allowed_element(lower_name: &str) -> bool {
    ALLOWED_ELEMENTS.contains(&lower_name)
}

fn write_open_tag(tag: &Tag<'_>, out: &mut String) {
    out.push('<');
    out.push_str(tag.name);
    for (name, raw_value) in &tag.attrs {
        if let Some(value) = sanitize_attr(name, raw_value) {
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            escape_attr_value(&value, out);
            out.push('"');
        }
    }
    out.push_str(if tag.self_closing { "/>" } else { ">" });
}

fn escape_attr_value(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

struct Tag<'a> {
    name: &'a str,
    attrs: Vec<(&'a str, &'a str)>,
    self_closing: bool,
}

enum Token<'a> {
    Text(&'a str),
    /// A `<` that does not start markup; written as `&lt;`.
    StrayLt,
    Open(Tag<'a>),
    Close(Tag<'a>),
    /// Comment, declaration, processing instruction, CDATA, or a tag that is
    /// cut off by the end of the input.
    Dropped,
}

fn is_html_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0C)
}

/// Read the next token starting at `pos`. `None` at the end of the input.
/// Returns the token and the position after it.
fn next_token(input: &str, pos: usize) -> Option<(Token<'_>, usize)> {
    let bytes = input.as_bytes();
    if pos >= bytes.len() {
        return None;
    }
    if bytes[pos] != b'<' {
        let end = input[pos..].find('<').map_or(bytes.len(), |i| pos + i);
        return Some((Token::Text(&input[pos..end]), end));
    }
    match bytes.get(pos + 1) {
        Some(b) if b.is_ascii_alphabetic() => Some(match parse_tag(input, pos + 1) {
            Some((tag, end)) => (Token::Open(tag), end),
            None => (Token::Dropped, bytes.len()),
        }),
        Some(b'/') => match bytes.get(pos + 2) {
            Some(b) if b.is_ascii_alphabetic() => Some(match parse_tag(input, pos + 2) {
                Some((tag, end)) => (Token::Close(tag), end),
                None => (Token::Dropped, bytes.len()),
            }),
            _ => Some((Token::Dropped, skip_past_gt(input, pos))),
        },
        Some(b'!') if input[pos..].starts_with("<!--") => {
            // Ends at `-->` or `--!>`; `<!-->` is an empty comment.
            let search = &input[pos + 2..];
            let end = [
                search.find("-->").map(|i| i + 3),
                search.find("--!>").map(|i| i + 4),
            ]
            .into_iter()
            .flatten()
            .min()
            .map_or(bytes.len(), |i| pos + 2 + i);
            Some((Token::Dropped, end))
        }
        Some(b'!') if input[pos..].starts_with("<![CDATA[") => {
            let end = input[pos..]
                .find("]]>")
                .map_or(bytes.len(), |i| pos + i + 3);
            Some((Token::Dropped, end))
        }
        Some(b'!' | b'?') => Some((Token::Dropped, skip_past_gt(input, pos))),
        _ => Some((Token::StrayLt, pos + 1)),
    }
}

fn skip_past_gt(input: &str, pos: usize) -> usize {
    input[pos..].find('>').map_or(input.len(), |i| pos + i + 1)
}

/// Parse a tag whose name starts at `start`. Returns the tag and the position
/// after its `>`, or `None` if the input ends inside the tag.
fn parse_tag(input: &str, start: usize) -> Option<(Tag<'_>, usize)> {
    let bytes = input.as_bytes();
    let mut i = start;
    while i < bytes.len() && !is_html_space(bytes[i]) && bytes[i] != b'/' && bytes[i] != b'>' {
        i += 1;
    }
    let name = &input[start..i];
    let mut attrs = Vec::new();
    loop {
        while i < bytes.len() && is_html_space(bytes[i]) {
            i += 1;
        }
        match bytes.get(i)? {
            b'>' => {
                let tag = Tag {
                    name,
                    attrs,
                    self_closing: false,
                };
                return Some((tag, i + 1));
            }
            b'/' => {
                if bytes.get(i + 1) == Some(&b'>') {
                    let tag = Tag {
                        name,
                        attrs,
                        self_closing: true,
                    };
                    return Some((tag, i + 2));
                }
                i += 1;
            }
            _ => {
                // An attribute name may start with `=`; after that it ends at
                // whitespace, `/`, `>` or `=`.
                let name_start = i;
                i += 1;
                while i < bytes.len()
                    && !is_html_space(bytes[i])
                    && !matches!(bytes[i], b'/' | b'>' | b'=')
                {
                    i += 1;
                }
                let attr_name = &input[name_start..i];
                let mut j = i;
                while j < bytes.len() && is_html_space(bytes[j]) {
                    j += 1;
                }
                if bytes.get(j) != Some(&b'=') {
                    attrs.push((attr_name, ""));
                    continue;
                }
                j += 1;
                while j < bytes.len() && is_html_space(bytes[j]) {
                    j += 1;
                }
                match bytes.get(j)? {
                    q @ (b'"' | b'\'') => {
                        let value_start = j + 1;
                        let close = input[value_start..].find(*q as char)?;
                        attrs.push((attr_name, &input[value_start..value_start + close]));
                        i = value_start + close + 1;
                    }
                    _ => {
                        let value_start = j;
                        while j < bytes.len() && !is_html_space(bytes[j]) && bytes[j] != b'>' {
                            j += 1;
                        }
                        attrs.push((attr_name, &input[value_start..j]));
                        i = j;
                    }
                }
            }
        }
    }
}

/// Position after the element opened just before `pos`, including everything
/// inside it. An element that is never closed swallows the rest of the input.
fn skip_subtree(input: &str, pos: usize, lname: &str, local: &str) -> usize {
    if RAW_TEXT.contains(&local) {
        return skip_raw_text(input, pos, lname);
    }
    let mut depth = 1;
    let mut pos = pos;
    while let Some((token, next)) = next_token(input, pos) {
        pos = next;
        match token {
            Token::Open(tag) if !tag.self_closing && tag.name.eq_ignore_ascii_case(lname) => {
                depth += 1;
            }
            Token::Close(tag) if tag.name.eq_ignore_ascii_case(lname) => {
                depth -= 1;
                if depth == 0 {
                    return pos;
                }
            }
            _ => {}
        }
    }
    input.len()
}

/// Position after the first `</name` end tag at or after `pos`.
fn skip_raw_text(input: &str, pos: usize, lname: &str) -> usize {
    let bytes = input.as_bytes();
    let mut from = pos;
    while let Some(i) = input[from..].find("</") {
        let name_start = from + i + 2;
        let name_end = name_start + lname.len();
        if input
            .get(name_start..name_end)
            .is_some_and(|n| n.eq_ignore_ascii_case(lname))
            && bytes
                .get(name_end)
                .is_none_or(|b| is_html_space(*b) || matches!(b, b'/' | b'>'))
        {
            return skip_past_gt(input, name_end);
        }
        from = name_start;
    }
    input.len()
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/// Decide whether an attribute is written, and with which value (decoded;
/// the caller escapes it).
fn sanitize_attr(name: &str, raw_value: &str) -> Option<String> {
    let lname = name.to_ascii_lowercase();
    if !ALLOWED_ATTRS.contains(&lname.as_str()) {
        return None;
    }
    let value = decode_char_refs(raw_value)?;
    match lname.as_str() {
        "href" | "xlink:href" => fragment_reference(&value),
        "style" => is_safe_style(&value).then_some(value),
        "xmlns" => (value == SVG_NAMESPACE).then_some(value),
        "xmlns:xlink" => (value == XLINK_NAMESPACE).then_some(value),
        n if URL_VALUED_ATTRS.contains(&n) => local_url_references_only(&value).then_some(value),
        _ => Some(value),
    }
}

/// A reference attribute is kept only if it points into this document: after
/// the whitespace and control characters browsers strip, it must start with
/// `#`. Returns the value without that prefix.
fn fragment_reference(value: &str) -> Option<String> {
    let trimmed =
        value.trim_start_matches(|c: char| c.is_ascii_whitespace() || c.is_ascii_control());
    trimmed.starts_with('#').then(|| trimmed.to_string())
}

/// Whether an `href` written as `raw_attr_value` in the markup is kept.
/// Exposed for the shared URI corpus test.
#[cfg(test)]
fn is_kept_reference(raw_attr_value: &str) -> bool {
    decode_char_refs(raw_attr_value)
        .and_then(|v| fragment_reference(&v))
        .is_some()
}

/// Every `url(...)` in `value` must refer to a fragment (`url(#id)`).
fn local_url_references_only(value: &str) -> bool {
    if value.contains('\\') {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(i) = rest.find("url(") {
        let after = rest[i + 4..].trim_start();
        let after = after.strip_prefix(['"', '\'']).unwrap_or(after);
        if !after.starts_with('#') {
            return false;
        }
        rest = &rest[i + 4..];
    }
    true
}

/// Strict check for a `style` attribute: `property: value` declarations with
/// allowlisted properties, plain value characters, allowlisted functions,
/// and only local `url(#id)` references.
fn is_safe_style(value: &str) -> bool {
    for declaration in value.split(';') {
        if declaration.trim().is_empty() {
            continue;
        }
        let Some((property, val)) = declaration.split_once(':') else {
            return false;
        };
        let property = property.trim().to_ascii_lowercase();
        if !ALLOWED_STYLE_PROPERTIES.contains(&property.as_str()) || !is_safe_style_value(val) {
            return false;
        }
    }
    true
}

fn is_safe_style_value(value: &str) -> bool {
    let plain = |c: char| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                ' ' | '#' | '.' | ',' | '%' | '+' | '-' | '_' | '\'' | '"' | '(' | ')' | '!' | '/'
            )
    };
    if !value.chars().all(plain) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    for (i, _) in lower.match_indices('(') {
        let name_start = lower[..i]
            .rfind(|c: char| !(c.is_ascii_alphabetic() || c == '-'))
            .map_or(0, |p| p + 1);
        if !ALLOWED_STYLE_FUNCTIONS.contains(&&lower[name_start..i]) {
            return false;
        }
    }
    local_url_references_only(&lower)
}

// ---------------------------------------------------------------------------
// Character references
// ---------------------------------------------------------------------------

/// Decode the character references of an attribute value once, the way a
/// browser does before it looks at the value.
///
/// Numeric references (decimal or hex, with or without the closing `;`) and
/// the five predefined names are decoded. Returns `None` for anything else
/// that looks like a reference — other names (`&Tab;`, `&NewLine;`,
/// `&colon;`), references to NUL, surrogates or code points past U+10FFFF,
/// and names without a `;` — so a value that could hide a scheme is dropped
/// rather than guessed at. A lone `&` that is not followed by a letter, digit
/// or `#` stays a literal ampersand.
fn decode_char_refs(value: &str) -> Option<String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        if let Some(numeric) = after.strip_prefix('#') {
            let (digits, radix, tail) = match numeric.strip_prefix(['x', 'X']) {
                Some(hex) => (take_while(hex, |c| c.is_ascii_hexdigit()), 16, hex),
                None => (take_while(numeric, |c| c.is_ascii_digit()), 10, numeric),
            };
            if digits.is_empty() {
                return None;
            }
            let code = digits
                .chars()
                .try_fold(0u32, |acc, d| {
                    acc.checked_mul(radix)?.checked_add(d.to_digit(radix)?)
                })
                .and_then(char::from_u32)
                .filter(|&c| c != '\0')?;
            out.push(code);
            let tail = &tail[digits.len()..];
            rest = tail.strip_prefix(';').unwrap_or(tail);
        } else {
            let name = take_while(after, |c| c.is_ascii_alphanumeric());
            if name.is_empty() {
                out.push('&');
                rest = after;
                continue;
            }
            let decoded = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                _ => return None,
            };
            rest = after[name.len()..].strip_prefix(';')?;
            out.push(decoded);
        }
    }
    out.push_str(rest);
    Some(out)
}

fn take_while(s: &str, f: impl Fn(char) -> bool) -> &str {
    let end = s.find(|c: char| !f(c)).unwrap_or(s.len());
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitize(input: &str) -> String {
        sanitize_svg_content(input)
    }

    /// `c` written as a decimal character reference.
    fn dec(c: char) -> String {
        format!("&#{};", c as u32)
    }

    // -- Shape of the output ------------------------------------------------

    #[test]
    fn allowed_markup_is_written_unchanged() {
        let svg = r##"<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g id="a" transform="translate(1,2)"><path d="M0,0 L10,10" fill="none" stroke="#000"/><text x="5" y="5">C&amp;G</text></g></svg>"##;
        assert_eq!(sanitize(svg), svg);
    }

    #[test]
    fn non_ascii_text_is_preserved() {
        let svg = "<svg><text x=\"10\">コード譜 🎵 café</text></svg>";
        assert_eq!(sanitize(svg), svg);
    }

    #[test]
    fn a_lone_less_than_in_text_is_escaped() {
        assert_eq!(
            sanitize("<text>1 < 2 <3</text>"),
            "<text>1 &lt; 2 &lt;3</text>"
        );
    }

    #[test]
    fn single_quoted_and_unquoted_values_are_written_double_quoted() {
        assert_eq!(
            sanitize("<rect x='1' y=2 width=\"3\"/>"),
            "<rect x=\"1\" y=\"2\" width=\"3\"/>"
        );
    }

    #[test]
    fn a_value_with_markup_characters_is_escaped_when_written() {
        let out = sanitize("<text aria-label='a\"><img src=x onerror=alert(1)>'>t</text>");
        assert_eq!(
            out,
            "<text aria-label=\"a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;\">t</text>"
        );
    }

    #[test]
    fn a_greater_than_inside_a_quoted_value_does_not_end_the_tag() {
        assert_eq!(
            sanitize("<rect aria-label=\"a>b\" onclick=\"x()\" width=\"1\"/>"),
            "<rect aria-label=\"a&gt;b\" width=\"1\"/>"
        );
    }

    #[test]
    fn a_tag_cut_off_by_the_end_of_the_input_is_dropped() {
        assert_eq!(
            sanitize("<rect width=\"1\"/><circle r=\"2"),
            "<rect width=\"1\"/>"
        );
    }

    // -- Elements -----------------------------------------------------------

    #[test]
    fn elements_that_run_script_are_removed_with_their_content() {
        assert_eq!(
            sanitize("<svg><script>alert(1)</script><circle r=\"5\"/></svg>"),
            "<svg><circle r=\"5\"/></svg>"
        );
    }

    #[test]
    fn a_script_tag_split_across_lines_is_removed_with_its_content() {
        assert_eq!(sanitize("<script\n>alert(1)</script\n>ok"), "ok");
    }

    #[test]
    fn a_style_element_is_removed_with_its_content() {
        let out = sanitize(
            "<svg><style>h1{display:none}@import 'https://x.example/a.css';</style><rect/></svg>",
        );
        assert_eq!(out, "<svg><rect/></svg>");
    }

    #[test]
    fn elements_in_a_namespace_prefix_are_removed_by_their_local_name() {
        assert_eq!(sanitize("<svg:script>alert(1)</svg:script>text"), "text");
        assert_eq!(
            sanitize("<foo.bar:script>alert(1)</foo.bar:script>text"),
            "text"
        );
        assert_eq!(
            sanitize("<XHTML:Iframe src=\"x\"></XHTML:Iframe>text"),
            "text"
        );
    }

    #[test]
    fn a_foreign_object_is_removed_with_nested_content() {
        let out = sanitize(
            "<svg><foreignObject><foreignObject>x</foreignObject><body><script>a()</script></body></foreignObject><rect/></svg>",
        );
        assert_eq!(out, "<svg><rect/></svg>");
    }

    #[test]
    fn an_unclosed_removed_element_swallows_the_rest_of_the_input() {
        assert_eq!(sanitize("<svg><rect/><script>alert(1)"), "<svg><rect/>");
        assert_eq!(sanitize("<svg><rect/><foreignObject><p>x"), "<svg><rect/>");
    }

    #[test]
    fn a_self_closing_removed_element_leaves_the_following_markup() {
        assert_eq!(
            sanitize("<svg><set to=\"a>b\"/><text>safe</text></svg>"),
            "<svg><text>safe</text></svg>"
        );
    }

    #[test]
    fn animation_and_resource_loading_elements_are_removed() {
        for tag in [
            "animate",
            "animateTransform",
            "animateMotion",
            "set",
            "image",
            "feImage",
            "iframe",
            "object",
            "embed",
            "math",
        ] {
            let out = sanitize(&format!(
                "<svg><{tag} href=\"https://x.example/\" attributeName=\"href\" to=\"javascript:1\">x</{tag}><rect/></svg>"
            ));
            assert_eq!(out, "<svg><rect/></svg>", "{tag}");
        }
    }

    #[test]
    fn html_elements_lose_their_tag_and_keep_their_text() {
        let out = sanitize(
            "<form action=\"https://x.example/\"><input name=\"u\"><button>Go</button></form><img src=\"https://x.example/p.gif\"><a href=\"https://x.example/\">link</a>",
        );
        assert_eq!(out, "Go<a>link</a>");
    }

    #[test]
    fn unknown_elements_lose_their_tag() {
        assert_eq!(
            sanitize("<svg><blink>x</blink><rect/></svg>"),
            "<svg>x<rect/></svg>"
        );
    }

    #[test]
    fn comments_declarations_and_cdata_are_dropped() {
        assert_eq!(
            sanitize(
                "<?xml version=\"1.0\"?><!DOCTYPE svg><!-- c --><svg><![CDATA[<script>]]><rect/></svg>"
            ),
            "<svg><rect/></svg>"
        );
        assert_eq!(sanitize("a<!-- x --!>b<!-->c"), "abc");
        assert_eq!(sanitize("a<!-- never closed <svg>"), "a");
    }

    #[test]
    fn a_stray_closing_tag_of_a_removed_element_is_dropped() {
        assert_eq!(sanitize("lyrics</svg:script>more"), "lyricsmore");
    }

    // -- Attributes ---------------------------------------------------------

    #[test]
    fn event_handler_attributes_are_not_written() {
        assert_eq!(
            sanitize(
                "<svg><rect onmouseover=\"alert(1)\" OnClick=\"x()\" ONLOAD=\"y()\" width=\"10\"/></svg>"
            ),
            "<svg><rect width=\"10\"/></svg>"
        );
    }

    #[test]
    fn attributes_outside_the_allowlist_are_not_written() {
        assert_eq!(
            sanitize(
                "<rect src=\"https://x.example/\" action=\"x\" formaction=\"x\" ping=\"x\" to=\"x\" values=\"x\" data-a=\"b\" target=\"_top\" width=\"1\"/>"
            ),
            "<rect width=\"1\"/>"
        );
    }

    #[test]
    fn a_non_namespace_xmlns_value_is_not_written() {
        assert_eq!(
            sanitize(
                "<svg xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"/>"
            ),
            "<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\"/>"
        );
    }

    #[test]
    fn a_reference_to_another_document_is_not_written() {
        for href in [
            "https://x.example/",
            "//x.example/",
            "sprites.svg#icon",
            "mailto:a@b.example",
            "javascript:alert(1)",
            "data:image/svg+xml,<svg/>",
        ] {
            for attr in ["href", "xlink:href"] {
                for tag in ["a", "use"] {
                    let out = sanitize(&format!("<{tag} {attr}=\"{href}\"/>"));
                    assert_eq!(out, format!("<{tag}/>"), "{tag} {attr}={href}");
                }
            }
        }
    }

    #[test]
    fn a_fragment_reference_is_written() {
        assert_eq!(sanitize("<use href=\"#a\"/>"), "<use href=\"#a\"/>");
        assert_eq!(
            sanitize("<use xlink:href=\"#a\"/>"),
            "<use xlink:href=\"#a\"/>"
        );
        assert_eq!(sanitize("<use href=\" #my\"/>"), "<use href=\"#my\"/>");
    }

    #[test]
    fn a_character_reference_hiding_a_scheme_in_an_href_is_not_written() {
        let hidden = [
            format!("java{}cript:window.__x=2", dec('s')),
            "java&#x73;cript:window.__x=3".to_string(),
            "java&Tab;script:window.__x=4".to_string(),
            "java&NewLine;script:window.__x=5".to_string(),
            format!("{}avascript:window.__x=6", dec('j')),
            "&#x6A;avascript:window.__x=7".to_string(),
            "javascript&colon;window.__x=8".to_string(),
            format!("javascript{}window.__x=9", dec(':')),
            format!("java&#{}cript:window.__x=10", 's' as u32),
            "&#X6a;avascript:window.__x=11".to_string(),
        ];
        for href in hidden {
            let out = sanitize(&format!("<a id=\"p\" href=\"{href}\"><text>t</text></a>"));
            assert_eq!(out, "<a id=\"p\"><text>t</text></a>", "{href}");
        }
    }

    #[test]
    fn a_broken_character_reference_drops_the_attribute() {
        let broken = [
            "a&#;b".to_string(),
            "a&#x;b".to_string(),
            "a&#0;b".to_string(),
            "a&#xD800;b".to_string(),
            "a&#x110000;b".to_string(),
            format!("a&#{};b", 99_999_999_999u64),
            "a&nbsp;b".to_string(),
            "a&amp b".to_string(),
        ];
        for value in broken {
            let out = sanitize(&format!("<rect id=\"{value}\" width=\"1\"/>"));
            assert_eq!(out, "<rect width=\"1\"/>", "{value}");
        }
    }

    #[test]
    fn character_references_are_decoded_once() {
        let input = format!("<rect id=\"a&amp;lt;b &#38;#{}; &lt;\"/>", 's' as u32);
        let expected = format!("<rect id=\"a&amp;lt;b &amp;#{}; &lt;\"/>", 's' as u32);
        assert_eq!(sanitize(&input), expected);
    }

    #[test]
    fn a_lone_ampersand_in_a_value_is_kept() {
        assert_eq!(
            sanitize("<rect aria-label=\"Q & A\"/>"),
            "<rect aria-label=\"Q &amp; A\"/>"
        );
    }

    #[test]
    fn a_paint_value_pointing_outside_the_document_is_not_written() {
        for value in [
            "url(https://x.example/p.svg#a)",
            "url('//x.example/p.svg#a')",
            "URL( \"data:image/svg+xml,x\" )",
            "url(#a) url(https://x.example/)",
            "ur&#x6c;(https://x.example/)",
            "u\\72l(https://x.example/)",
        ] {
            for attr in ["fill", "stroke", "clip-path", "mask", "marker-end"] {
                let out = sanitize(&format!("<path {attr}=\"{value}\"/>"));
                assert_eq!(out, "<path/>", "{attr}={value}");
            }
        }
    }

    #[test]
    fn a_paint_value_pointing_into_the_document_is_written() {
        assert_eq!(
            sanitize("<path fill=\"url(#g)\"/>"),
            "<path fill=\"url(#g)\"/>"
        );
        assert_eq!(
            sanitize("<path fill=\"url( '#g' ) red\"/>"),
            "<path fill=\"url( '#g' ) red\"/>"
        );
    }

    // -- style attribute ----------------------------------------------------

    #[test]
    fn a_style_with_allowed_properties_is_written() {
        let rect = "<rect style=\"fill: red; stroke: rgb(0, 0, 255); font-family: 'Times New Roman', serif\"/>";
        assert_eq!(sanitize(rect), rect);
        let gradient = "<rect style=\"fill:url(#g)\"/>";
        assert_eq!(sanitize(gradient), gradient);
    }

    #[test]
    fn a_style_that_can_load_a_resource_or_run_code_is_not_written() {
        for style in [
            "background-image: url('https://x.example/exfil')",
            "fill: url(https://x.example/p.svg#a)",
            "fill: image-set('/x' 1x)",
            "fill: image('/x')",
            "fill: cross-fade(url(/a) 50%)",
            "width: expression(alert(1))",
            "@import url(evil.css)",
            "behavior: url(#default)",
            "-moz-binding: url(http://x.example/x)",
            "fill: url\\28/x\\29",
            "position: fixed; top: 0; left: 0; width: 100%; height: 100%",
            "fill: red; display",
            "fill: var(--x)",
        ] {
            let out = sanitize(&format!("<rect style=\"{style}\" width=\"10\"/>"));
            assert_eq!(out, "<rect width=\"10\"/>", "{style}");
        }
    }

    // -- Shared URI corpus --------------------------------------------------

    /// Every entry of the corpus shared with the React walker and the
    /// playground's docs pipeline gets the same verdict here: a blocked entry
    /// is never kept as a reference, and only a fragment is kept at all.
    #[test]
    fn references_agree_with_shared_corpus() {
        let corpus = include_str!("../../../tests/fixtures/uri-scheme-corpus.txt");
        let mut checked = 0;
        for line in corpus.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut columns = line.splitn(3, '\t');
            let (verdict, label, href) = match (columns.next(), columns.next(), columns.next()) {
                (Some(v), Some(l), Some(h)) => (v, l, decode_corpus_href(h)),
                _ => panic!("corpus line does not have three tab-separated columns: {line:?}"),
            };
            let kept = is_kept_reference(&href);
            match verdict {
                "blocked" => assert!(!kept, "corpus entry {label:?} (blocked): {href:?}"),
                "allowed" => assert_eq!(
                    kept,
                    href.starts_with('#'),
                    "corpus entry {label:?} (allowed): {href:?}"
                ),
                other => panic!("unknown corpus verdict {other:?} in line {line:?}"),
            }
            checked += 1;
        }
        assert!(checked >= 40, "corpus looks truncated: {checked} entries");
    }

    /// Decodes the `\u{HEX}` escapes the shared corpus uses for control and
    /// invisible characters.
    fn decode_corpus_href(raw: &str) -> String {
        let mut out = String::new();
        let mut rest = raw;
        while let Some(start) = rest.find("\\u{") {
            out.push_str(&rest[..start]);
            let after = &rest[start + 3..];
            let end = after.find('}').expect("unterminated \\u{ escape in corpus");
            let code = u32::from_str_radix(&after[..end], 16).expect("hex digits in corpus");
            out.push(char::from_u32(code).expect("valid code point in corpus"));
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        out
    }

    // -- Robustness ---------------------------------------------------------

    #[test]
    fn markup_cut_off_at_every_position_does_not_panic() {
        let svg =
            "<svg a='1' b=\"2\" c=3><!-- c --><g/><![CDATA[x]]><?p?><script>s</script></svg>é日";
        for end in 0..=svg.len() {
            if svg.is_char_boundary(end) {
                let _ = sanitize(&svg[..end]);
            }
        }
    }

    #[test]
    fn output_never_contains_an_element_outside_the_allowlist() {
        let hostile = "<<svg><scr<script>ipt>alert(1)</script></scr<script>ipt><svg/onload=alert(1)><a href=java&#x73;cript:x()>x</a><IMG SRC=x onerror=y><style>*{}</style><title><img src=x onerror=z></title><svg><p title=\"</p><img src=x onerror=w>\">";
        let out = sanitize(hostile);
        let lower = out.to_ascii_lowercase();
        for banned in [
            "<script",
            "<img",
            "<style",
            "<p",
            "onerror",
            "onload",
            "javascript",
        ] {
            assert!(!lower.contains(banned), "{banned} in {out}");
        }
    }
}
