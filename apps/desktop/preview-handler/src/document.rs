//! Turns the bytes of a ChordPro file into the HTML document the
//! preview pane displays.
//!
//! This module is deliberately platform-independent: it is the whole
//! rendering contract of the preview handler, and keeping it off the
//! `cfg(windows)` path is what lets every CI runner compile and test
//! it. The COM plumbing in the sibling modules only moves bytes into
//! [`decode_source`] and the resulting string into a WebView2 control.

use chordsketch_chordpro::config::Config;
use chordsketch_chordpro::escape::escape_xml;
use chordsketch_chordpro::parse_multi_lenient;
use chordsketch_render_html::{render_html_css, render_songs_body_with_transpose};

/// Largest ChordPro source the preview pane will render.
///
/// Matches `MAX_OPEN_SIZE_BYTES` / `MAX_EXPORT_CHORDPRO_BYTES` in
/// `apps/desktop/src-tauri/src/main.rs`: a file the desktop app refuses
/// to open is a file the preview pane refuses to draw, so a user never
/// meets two different size ceilings for the same document. Per
/// `.claude/rules/code-style.md` §"Resource Limits" the parse + render
/// pipeline has no internal cap, so the boundary check lives here, at
/// the point where bytes enter the crate.
pub const MAX_PREVIEW_SOURCE_BYTES: usize = 10 * 1024 * 1024;

/// Content Security Policy applied to every previewed document.
///
/// The preview host renders **untrusted files picked in Explorer**, and
/// `chordsketch-render-html` emits delegate sections (`{start_of_svg}`
/// and friends) as raw markup — its own docs ask consumers handling
/// untrusted input to add a CSP on top of the crate's sanitisation.
/// This is that CSP.
///
/// - `default-src 'none'` — no scripts, no frames, no network fetches
///   of any kind, so a previewed file cannot phone home or run code.
/// - `style-src 'unsafe-inline'` — required by the `<style>` block and
///   the inline `style="…"` attributes the renderer emits for
///   `{textcolour}` and friends.
/// - `img-src data:` / `font-src data:` — only self-contained assets.
///   Documents are loaded via `NavigateToString`, so they have an
///   opaque origin and could not resolve a relative `{image}` path
///   anyway; the policy states that limit instead of leaving it to
///   chance.
pub const CONTENT_SECURITY_POLICY: &str =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/// Title used when the source declares no `{title}` directive.
const FALLBACK_TITLE: &str = "ChordPro preview";

/// Why a file could not be turned into a preview document.
#[derive(Debug, PartialEq, Eq)]
pub enum SourceError {
    /// The file is larger than [`MAX_PREVIEW_SOURCE_BYTES`].
    ///
    /// Carries only the ceiling, not the file's size: the caller stops
    /// reading the shell's stream one byte past the limit, so it never
    /// learns how large the file actually was, and reporting the
    /// truncated read count would state a number that is not the file
    /// size.
    TooLarge {
        /// The ceiling that was exceeded, in bytes.
        limit: usize,
    },
}

impl core::fmt::Display for SourceError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(
                f,
                "This file is too large to preview. The limit is {limit} bytes."
            ),
        }
    }
}

/// Decode the raw bytes of a ChordPro file into source text.
///
/// Strips a UTF-8 BOM when present, because ChordPro directives are
/// only recognised at the start of a line and a leading `\u{feff}`
/// would push the first `{title}` off column zero.
///
/// Byte sequences that are not valid UTF-8 are replaced with
/// `U+FFFD` rather than rejected. This is an intentional leniency
/// scoped to the preview surface: showing a mostly-correct song with a
/// few replacement characters is more useful in a preview pane than
/// refusing to draw the file at all, and the handler never writes the
/// decoded text back to disk.
///
/// # Errors
///
/// Returns [`SourceError::TooLarge`] when `bytes` exceeds
/// [`MAX_PREVIEW_SOURCE_BYTES`].
pub fn decode_source(bytes: &[u8]) -> Result<String, SourceError> {
    if bytes.len() > MAX_PREVIEW_SOURCE_BYTES {
        return Err(SourceError::TooLarge {
            limit: MAX_PREVIEW_SOURCE_BYTES,
        });
    }
    let without_bom = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    Ok(String::from_utf8_lossy(without_bom).into_owned())
}

/// Render ChordPro source into the self-contained HTML document the
/// preview pane loads via `NavigateToString`.
///
/// Built from `chordsketch-render-html`'s fragment API
/// (`render_songs_body_with_transpose` + `render_html_css`) rather than
/// its full-document API so the envelope can carry
/// [`CONTENT_SECURITY_POLICY`]. The body markup and the stylesheet are
/// byte-identical to what `chordsketch --format html`, the desktop
/// app's `Export HTML…`, and the browser playground produce, so the
/// preview pane is not a fourth rendering of the same song.
///
/// Multi-song files are rendered in full, matching the desktop app's
/// `parse_multi_lenient` open / export path.
#[must_use]
pub fn render_document(source: &str) -> String {
    let config = Config::defaults();
    let songs: Vec<_> = parse_multi_lenient(source)
        .results
        .into_iter()
        .map(|r| r.song)
        .collect();
    let title = songs
        .first()
        .and_then(|song| song.metadata.title.as_deref())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(FALLBACK_TITLE);
    let body = render_songs_body_with_transpose(&songs, 0, &config);

    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\">\n\
         <title>{title}</title>\n\
         <style>\n{css}</style>\n\
         </head>\n<body>\n{body}</body>\n</html>\n",
        csp = CONTENT_SECURITY_POLICY,
        title = escape_xml(title),
        css = render_html_css(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_source_strips_utf8_bom() {
        let bytes = b"\xef\xbb\xbf{title: With BOM}\n";
        assert_eq!(decode_source(bytes).unwrap(), "{title: With BOM}\n");
    }

    #[test]
    fn test_decode_source_keeps_plain_utf8_unchanged() {
        let bytes = "{title: 春よ、来い}\n".as_bytes();
        assert_eq!(decode_source(bytes).unwrap(), "{title: 春よ、来い}\n");
    }

    #[test]
    fn test_decode_source_replaces_invalid_utf8_instead_of_failing() {
        let decoded = decode_source(b"{title: caf\xe9}").unwrap();
        assert_eq!(decoded, "{title: caf\u{fffd}}");
    }

    #[test]
    fn test_decode_source_rejects_input_over_the_size_limit() {
        let oversized = vec![b'x'; MAX_PREVIEW_SOURCE_BYTES + 1];
        assert_eq!(
            decode_source(&oversized),
            Err(SourceError::TooLarge {
                limit: MAX_PREVIEW_SOURCE_BYTES,
            })
        );
    }

    #[test]
    fn test_decode_source_accepts_input_exactly_at_the_size_limit() {
        let at_limit = vec![b'x'; MAX_PREVIEW_SOURCE_BYTES];
        assert_eq!(
            decode_source(&at_limit).unwrap().len(),
            MAX_PREVIEW_SOURCE_BYTES
        );
    }

    #[test]
    fn test_render_document_emits_a_complete_html_envelope() {
        let html = render_document("{title: Hey}\n[C]Hello\n");
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<meta charset=\"utf-8\">"));
        assert!(html.trim_end().ends_with("</html>"));
    }

    #[test]
    fn test_render_document_carries_the_content_security_policy() {
        let html = render_document("[C]Hello\n");
        assert!(html.contains(&format!(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"{CONTENT_SECURITY_POLICY}\">"
        )));
        assert!(CONTENT_SECURITY_POLICY.contains("default-src 'none'"));
    }

    #[test]
    fn test_render_document_uses_the_song_title_as_the_document_title() {
        let html = render_document("{title: Yesterday}\n");
        assert!(html.contains("<title>Yesterday</title>"));
    }

    #[test]
    fn test_render_document_escapes_a_hostile_title() {
        let html = render_document("{title: </title><script>alert(1)</script>}\n");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn test_render_document_falls_back_to_a_generic_title_without_a_title_directive() {
        let html = render_document("[C]Hello\n");
        assert!(html.contains(&format!("<title>{FALLBACK_TITLE}</title>")));
    }

    #[test]
    fn test_render_document_falls_back_to_a_generic_title_for_a_blank_title() {
        let html = render_document("{title:    }\n");
        assert!(html.contains(&format!("<title>{FALLBACK_TITLE}</title>")));
    }

    #[test]
    fn test_render_document_renders_chords_and_lyrics_from_the_source() {
        let html = render_document("{title: Hey}\n[Am]Hello world\n");
        assert!(html.contains("Am"));
        assert!(html.contains("Hello world"));
    }

    #[test]
    fn test_render_document_renders_every_song_in_a_multi_song_file() {
        let html = render_document("{title: First}\n[C]one\n{new_song}\n{title: Second}\n[G]two\n");
        assert!(html.contains("First"));
        assert!(html.contains("Second"));
        assert!(html.contains("<hr class=\"song-separator\">"));
    }

    #[test]
    fn test_render_document_embeds_the_shared_stylesheet() {
        let html = render_document("[C]Hello\n");
        assert!(html.contains(&render_html_css()));
    }

    #[test]
    fn test_render_document_of_an_empty_source_still_produces_a_document() {
        let html = render_document("");
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains(&format!("<title>{FALLBACK_TITLE}</title>")));
    }

    #[test]
    fn test_source_error_message_names_the_limit() {
        let message = SourceError::TooLarge { limit: 7 }.to_string();
        assert!(message.contains("too large"));
        assert!(message.contains('7'));
    }
}
