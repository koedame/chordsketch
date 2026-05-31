//! LSP completion support for ChordPro files.
//!
//! Completion items are built from static, compile-time data — no external
//! files or network access. The four completion contexts are:
//!
//! - **Directive name**: inside `{...}` before the `:`
//! - **Directive value**: after the `:` of an enum-valued directive (e.g. `{diagrams: }`)
//! - **Chord name**: inside `[...]`
//! - **Metadata key**: inside `{meta: ...}` after the space
//!
//! Context detection works by scanning the line text up to the cursor column
//! and finding the innermost open delimiter.

use chordsketch_chordpro::directive_catalog;
use tower_lsp::lsp_types::{
    CompletionItem, CompletionItemKind, Documentation, MarkupContent, MarkupKind,
};

// ---------------------------------------------------------------------------
// Completion context detection
// ---------------------------------------------------------------------------

/// The kind of completion triggered at a given cursor position.
#[derive(Debug, PartialEq)]
pub enum CompletionContext {
    /// Inside `{...}` before or at the colon: complete directive names.
    DirectiveName {
        /// Characters typed so far (lowercased prefix).
        prefix: String,
    },
    /// After `{meta: `: complete known metadata keys.
    MetadataKey { prefix: String },
    /// After `{<directive>: ` for a directive whose value is a fixed set
    /// (e.g. `{diagrams: }`): complete that directive's allowed values.
    DirectiveValue {
        /// Canonical directive name (lowercased).
        directive: String,
        /// Value characters typed so far (lowercased prefix).
        prefix: String,
    },
    /// Inside `[...]`: complete chord names.
    ChordName { prefix: String },
    /// Not inside a recognized completion context.
    None,
}

/// Detects the completion context for `line` at 0-based `col`.
///
/// Scans forward through the line prefix up to `col`, tracking open/close
/// delimiter state to determine the innermost active context.
/// Returns [`CompletionContext::None`] if the cursor is not inside a
/// recognized completion region.
#[must_use]
pub fn detect_context(line: &str, col: usize) -> CompletionContext {
    // Work with char boundaries; col is a 0-based character offset.
    let chars: Vec<char> = line.chars().collect();
    let col = col.min(chars.len());
    let prefix_chars = &chars[..col];

    // Track delimiter state scanning left to right through the prefix.
    let mut in_bracket = false; // inside [
    let mut in_brace = false; // inside {
    let mut brace_colon_pos: Option<usize> = None; // position of `:` inside `{`
    let mut directive_name = String::new();

    for (i, &ch) in prefix_chars.iter().enumerate() {
        match ch {
            '{' => {
                in_brace = true;
                in_bracket = false;
                brace_colon_pos = None;
                directive_name.clear();
            }
            '}' => {
                in_brace = false;
                brace_colon_pos = None;
                directive_name.clear();
            }
            '[' => {
                in_bracket = true;
                in_brace = false;
            }
            ']' => {
                in_bracket = false;
            }
            ':' if in_brace => {
                brace_colon_pos = Some(i);
                // Extract the directive name as text between the most-recent
                // `{` and the colon, ignoring any text before the brace.
                let brace_start = chars[..i]
                    .iter()
                    .rposition(|&c| c == '{')
                    .map(|p| p + 1)
                    .expect("invariant: ':' inside in_brace always follows a scanned '{'");
                directive_name = chars[brace_start..i]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_ascii_lowercase();
            }
            _ => {}
        }
    }

    if in_bracket {
        // Collect text after `[` up to cursor.
        // in_bracket is true only after a `[` was scanned — rposition always finds it.
        let open_bracket = prefix_chars
            .iter()
            .rposition(|&c| c == '[')
            .expect("invariant: in_bracket requires a scanned `[`");
        let prefix: String = chars[open_bracket + 1..col].iter().collect();
        return CompletionContext::ChordName { prefix };
    }

    if in_brace {
        if let Some(colon_pos) = brace_colon_pos {
            let prefix: String = chars[colon_pos + 1..col]
                .iter()
                .skip_while(|&&c| c == ' ')
                .collect::<String>()
                .to_ascii_lowercase();
            if directive_name == "meta" {
                return CompletionContext::MetadataKey { prefix };
            }
            // Directives whose value is a fixed set (e.g. `{diagrams: }`)
            // complete their allowed values; free-form / value-less
            // directives still offer nothing (ADR-0028).
            if directive_catalog::directive_value_options(&directive_name).is_some() {
                return CompletionContext::DirectiveValue {
                    directive: directive_name,
                    prefix,
                };
            }
            return CompletionContext::None;
        }
        // Before the colon: completing the directive name.
        // in_brace is true only after a `{` was scanned — rposition always finds it.
        let open_brace = prefix_chars
            .iter()
            .rposition(|&c| c == '{')
            .expect("invariant: in_brace requires a scanned `{`");
        let prefix: String = chars[open_brace + 1..col].iter().collect();
        let prefix = prefix.trim().to_ascii_lowercase();
        return CompletionContext::DirectiveName { prefix };
    }

    CompletionContext::None
}

// ---------------------------------------------------------------------------
// Static completion data
// ---------------------------------------------------------------------------

/// Common `{meta: KEY}` keys.
const META_KEYS: &[&str] = &[
    "album",
    "arranger",
    "artist",
    "capo",
    "composer",
    "copyright",
    "duration",
    "instrument",
    "key",
    "lyricist",
    "sorttitle",
    "sortartist",
    "subtitle",
    "tag",
    "tempo",
    "time",
    "title",
    "year",
];

/// Note roots.
const ROOTS: &[&str] = &[
    "A", "A#", "Ab", "B", "Bb", "C", "C#", "D", "D#", "Db", "E", "Eb", "F", "F#", "G", "G#", "Gb",
];

/// Chord quality suffixes.
const SUFFIXES: &[&str] = &[
    "", "m", "7", "m7", "maj7", "M7", "dim", "dim7", "aug", "sus2", "sus4", "add9", "9", "m9",
    "maj9", "11", "13", "6", "m6", "5",
];

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

/// Returns directive name completion items matching `prefix`.
///
/// Sourced from the shared `chordsketch_chordpro::directive_catalog` so the
/// LSP, the web editor, and the playground all offer the same directive set
/// (ADR-0028) — no hand-maintained copy to drift.
#[must_use]
pub fn directive_items(prefix: &str) -> Vec<CompletionItem> {
    directive_catalog::directives()
        .iter()
        .filter(|d| d.name.starts_with(prefix))
        .map(|d| {
            // Surface the first short alias (if any) in `detail`, matching
            // the prior "alias: soc" hint shape.
            let detail = d.aliases.first().map(|a| format!("alias: {a}"));
            CompletionItem {
                label: d.name.to_string(),
                kind: Some(CompletionItemKind::KEYWORD),
                detail,
                documentation: Some(Documentation::MarkupContent(MarkupContent {
                    kind: MarkupKind::PlainText,
                    value: d.summary.to_string(),
                })),
                ..Default::default()
            }
        })
        .collect()
}

/// Returns value completion items for an enum-valued directive (e.g.
/// `{diagrams: }`), filtered by `prefix`. Empty for free-form / value-less
/// directives and unknown names. Backed by the shared directive catalog
/// (ADR-0028).
#[must_use]
pub fn directive_value_items(directive: &str, prefix: &str) -> Vec<CompletionItem> {
    let Some(values) = directive_catalog::directive_value_options(directive) else {
        return Vec::new();
    };
    values
        .iter()
        .filter(|v| v.starts_with(prefix))
        .map(|v| CompletionItem {
            label: (*v).to_string(),
            kind: Some(CompletionItemKind::VALUE),
            ..Default::default()
        })
        .collect()
}

/// Returns metadata key completion items matching `prefix`.
#[must_use]
pub fn meta_key_items(prefix: &str) -> Vec<CompletionItem> {
    META_KEYS
        .iter()
        .filter(|k| k.starts_with(prefix))
        .map(|k| CompletionItem {
            label: k.to_string(),
            kind: Some(CompletionItemKind::FIELD),
            documentation: Some(Documentation::MarkupContent(MarkupContent {
                kind: MarkupKind::PlainText,
                value: format!("Metadata key: {k}"),
            })),
            ..Default::default()
        })
        .collect()
}

/// Returns chord name completion items matching `prefix`.
///
/// Only root+suffix combinations whose label starts with `prefix` are
/// returned, keeping the list small for common cases (e.g. `"C"` matches
/// `C`, `Cm`, `C7`, etc.).
#[must_use]
pub fn chord_items(prefix: &str) -> Vec<CompletionItem> {
    let mut items = Vec::new();
    for root in ROOTS {
        for suffix in SUFFIXES {
            let label = format!("{root}{suffix}");
            if label.starts_with(prefix) {
                items.push(CompletionItem {
                    label,
                    kind: Some(CompletionItemKind::VALUE),
                    ..Default::default()
                });
            }
        }
        // Bass-note slash chords (e.g. C/G): generated only when `prefix`
        // starts with the root string, so they are suppressed for an empty
        // prefix (preventing a combinatorial explosion of root×bass items).
        if !prefix.is_empty() && prefix.starts_with(root) {
            for bass in ROOTS {
                let label = format!("{root}/{bass}");
                if label.starts_with(prefix) {
                    items.push(CompletionItem {
                        label,
                        kind: Some(CompletionItemKind::VALUE),
                        ..Default::default()
                    });
                }
            }
        }
    }
    items
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- context detection ---

    #[test]
    fn context_directive_name_empty_prefix() {
        let ctx = detect_context("{", 1);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveName {
                prefix: String::new()
            }
        );
    }

    #[test]
    fn context_directive_name_with_prefix() {
        let ctx = detect_context("{tit", 4);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveName {
                prefix: "tit".to_string()
            }
        );
    }

    #[test]
    fn context_chord_name_empty() {
        let ctx = detect_context("[", 1);
        assert_eq!(
            ctx,
            CompletionContext::ChordName {
                prefix: String::new()
            }
        );
    }

    #[test]
    fn context_chord_name_with_prefix() {
        let ctx = detect_context("[Am", 3);
        assert_eq!(
            ctx,
            CompletionContext::ChordName {
                prefix: "Am".to_string()
            }
        );
    }

    #[test]
    fn context_metadata_key() {
        let ctx = detect_context("{meta: ", 7);
        assert_eq!(
            ctx,
            CompletionContext::MetadataKey {
                prefix: String::new()
            }
        );
    }

    #[test]
    fn context_metadata_key_with_prefix() {
        let ctx = detect_context("{meta: art", 10);
        assert_eq!(
            ctx,
            CompletionContext::MetadataKey {
                prefix: "art".to_string()
            }
        );
    }

    #[test]
    fn context_outside_any_delimiter_is_none() {
        let ctx = detect_context("Hello world", 5);
        assert_eq!(ctx, CompletionContext::None);
    }

    #[test]
    fn context_after_closed_brace_is_none() {
        let ctx = detect_context("{title: My Song} ", 17);
        assert_eq!(ctx, CompletionContext::None);
    }

    // --- item builders ---

    #[test]
    fn directive_items_filters_by_prefix() {
        let items = directive_items("start_of_");
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"start_of_chorus"));
        assert!(labels.contains(&"start_of_verse"));
        assert!(!labels.contains(&"end_of_chorus"));
    }

    #[test]
    fn directive_items_empty_prefix_returns_all() {
        let items = directive_items("");
        assert!(
            items.len() >= 40,
            "expected many directives, got {}",
            items.len()
        );
    }

    #[test]
    fn chord_items_filters_by_root() {
        let items = chord_items("C");
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"C"));
        assert!(labels.contains(&"Cm"));
        assert!(labels.contains(&"C7"));
        // C# / Cb items are also included (they start with "C").
        // Unrelated roots (D, G, …) must not appear.
        assert!(
            !labels
                .iter()
                .any(|l| l.starts_with('D') || l.starts_with('G'))
        );
    }

    #[test]
    fn meta_key_items_filters_by_prefix() {
        let items = meta_key_items("art");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "artist");
    }

    // --- non-ASCII input ---

    #[test]
    fn context_chord_name_non_ascii_prefix() {
        // "Ré" contains a 2-byte UTF-8 character; col is a char count, not a
        // byte count. The function must not panic or produce a wrong prefix.
        let line = "[Ré";
        let col = line.chars().count(); // 3 chars: '[', 'R', 'é'
        let ctx = detect_context(line, col);
        assert_eq!(
            ctx,
            CompletionContext::ChordName {
                prefix: "Ré".to_string()
            }
        );
    }

    #[test]
    fn context_directive_name_non_ascii_text_before_brace() {
        // Non-ASCII lyrics text on the same line before the `{`.
        let line = "Ré [Am] {tit";
        let col = line.chars().count();
        let ctx = detect_context(line, col);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveName {
                prefix: "tit".to_string()
            }
        );
    }

    // --- edge cases from issue #1193 ---

    #[test]
    fn context_col_zero_is_none() {
        // Cursor at column 0: no prefix to scan, always None.
        assert_eq!(detect_context("{title", 0), CompletionContext::None);
        assert_eq!(detect_context("[Am", 0), CompletionContext::None);
    }

    #[test]
    fn context_col_beyond_length_clamped() {
        // col > line length: clamped to line length, same as end of line.
        let line = "{ti";
        let ctx = detect_context(line, 999);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveName {
                prefix: "ti".to_string()
            }
        );
    }

    #[test]
    fn context_brace_inside_bracket_last_delimiter_wins() {
        // `[Am {` — malformed but the last opened delimiter ({) wins.
        // After `[`, in_bracket=true; then `{` sets in_brace=true and clears in_bracket.
        let ctx = detect_context("[Am {", 5);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveName {
                prefix: String::new()
            }
        );
    }

    #[test]
    fn context_reopened_directive_after_closed_one() {
        // `{title: My Song} {ti` — the first brace is closed, the second is open.
        let ctx = detect_context("{title: My Song} {ti", 20);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveName {
                prefix: "ti".to_string()
            }
        );
    }

    #[test]
    fn context_directive_value_non_meta_is_none() {
        // A FREE-FORM directive value (e.g. `{title: …}`) still offers no
        // completion — only enum-valued directives do (ADR-0028).
        let ctx = detect_context("{title: My", 10);
        assert_eq!(ctx, CompletionContext::None);
    }

    #[test]
    fn context_enum_directive_value_completes() {
        // `{diagrams: }` is enum-valued, so the cursor after the colon is a
        // DirectiveValue context carrying the directive name + typed prefix.
        let ctx = detect_context("{diagrams: ", 11);
        assert_eq!(
            ctx,
            CompletionContext::DirectiveValue {
                directive: "diagrams".to_string(),
                prefix: String::new(),
            }
        );
        let ctx2 = detect_context("{diagrams: in", 13);
        assert_eq!(
            ctx2,
            CompletionContext::DirectiveValue {
                directive: "diagrams".to_string(),
                prefix: "in".to_string(),
            }
        );
    }

    #[test]
    fn directive_value_items_offers_diagrams_values() {
        let items = directive_value_items("diagrams", "");
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"inline"));
        assert!(labels.contains(&"hover"));
        assert!(labels.contains(&"off"));
        // Prefix filtering narrows the set.
        let inl = directive_value_items("diagrams", "in");
        assert!(inl.iter().all(|i| i.label.starts_with("in")));
        assert!(inl.iter().any(|i| i.label == "inline"));
    }

    #[test]
    fn directive_value_items_empty_for_free_form() {
        assert!(directive_value_items("title", "").is_empty());
        assert!(directive_value_items("not-a-directive", "").is_empty());
    }

    #[test]
    fn directive_items_still_includes_previously_missing_directives() {
        // The catalog fixed the hand-list's gaps — these must now appear.
        let labels: Vec<String> = directive_items("").into_iter().map(|i| i.label).collect();
        for name in ["highlight", "no_diagrams", "pagetype", "start_of_musicxml"] {
            assert!(labels.contains(&name.to_string()), "missing {name}");
        }
    }
}
