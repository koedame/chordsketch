//! Zero-dependency JSON serializer for the ChordPro AST.
//!
//! Mirrors the iReal Pro pattern in `chordsketch-ireal::json` so the
//! `chordsketch-chordpro` crate's zero-dependency policy stays
//! intact (CLAUDE.md §Dependency Policy).
//!
//! The serializer exists to expose the parsed AST to the React /
//! browser surface via `chordsketch-wasm::parseChordpro`, which is
//! how `@chordsketch/react`'s AST → JSX renderer drives its
//! preview output (see [ADR-0017](../../docs/adr/0017-react-renders-from-ast.md)).
//! TypeScript types matching this shape live at
//! `packages/react/src/chordpro-ast.ts` — keep the two in sync.
//!
//! # Format
//!
//! Compact JSON, no indentation, deterministic field order matching
//! the AST struct field order. Strings escape per RFC 8259 §7
//! (mandatory escapes plus `\u{XXXX}` for C0 controls). Tagged
//! unions encode enum variants with `{"kind":"variant","value":...}`
//! shape, matching the iReal Pro pattern.

use crate::ast::{
    Chord, ChordDefinition, CommentStyle, Directive, DirectiveKind, ImageAttributes, Line,
    LyricsLine, LyricsSegment, Metadata, Song,
};
use crate::chord::{Accidental, ChordDetail, ChordQuality, Note};
use crate::inline_markup::{SpanAttributes, TextSpan};

/// Anything that knows how to write itself as JSON into a `String`
/// buffer.
pub trait ToJson {
    /// Append this value's JSON form to `out`.
    fn to_json(&self, out: &mut String);

    /// Convenience: allocate a fresh `String` and serialise into it.
    #[must_use]
    fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.to_json(&mut out);
        out
    }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                use core::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_opt_str(out: &mut String, s: &Option<String>) {
    match s {
        Some(v) => write_str(out, v),
        None => out.push_str("null"),
    }
}

fn write_bool(out: &mut String, v: bool) {
    out.push_str(if v { "true" } else { "false" });
}

fn write_i32(out: &mut String, v: i32) {
    use core::fmt::Write;
    let _ = write!(out, "{v}");
}

fn write_str_array(out: &mut String, items: &[String]) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_str(out, item);
    }
    out.push(']');
}

fn write_array<T: ToJson>(out: &mut String, items: &[T]) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        item.to_json(out);
    }
    out.push(']');
}

fn write_pair_array(out: &mut String, items: &[(String, String)]) {
    out.push('[');
    for (i, (k, v)) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        write_str(out, k);
        out.push(',');
        write_str(out, v);
        out.push(']');
    }
    out.push(']');
}

// ---------------------------------------------------------------------------
// Song / Metadata
// ---------------------------------------------------------------------------

impl ToJson for Song {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"metadata\":");
        self.metadata.to_json(out);
        out.push_str(",\"lines\":");
        write_array(out, &self.lines);
        out.push('}');
    }
}

impl ToJson for Metadata {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"title\":");
        write_opt_str(out, &self.title);
        out.push_str(",\"subtitles\":");
        write_str_array(out, &self.subtitles);
        out.push_str(",\"artists\":");
        write_str_array(out, &self.artists);
        out.push_str(",\"composers\":");
        write_str_array(out, &self.composers);
        out.push_str(",\"lyricists\":");
        write_str_array(out, &self.lyricists);
        out.push_str(",\"album\":");
        write_opt_str(out, &self.album);
        out.push_str(",\"year\":");
        write_opt_str(out, &self.year);
        out.push_str(",\"key\":");
        write_opt_str(out, &self.key);
        out.push_str(",\"tempo\":");
        write_opt_str(out, &self.tempo);
        out.push_str(",\"time\":");
        write_opt_str(out, &self.time);
        out.push_str(",\"capo\":");
        write_opt_str(out, &self.capo);
        out.push_str(",\"sortTitle\":");
        write_opt_str(out, &self.sort_title);
        out.push_str(",\"sortArtist\":");
        write_opt_str(out, &self.sort_artist);
        out.push_str(",\"arrangers\":");
        write_str_array(out, &self.arrangers);
        out.push_str(",\"copyright\":");
        write_opt_str(out, &self.copyright);
        out.push_str(",\"duration\":");
        write_opt_str(out, &self.duration);
        out.push_str(",\"tags\":");
        write_str_array(out, &self.tags);
        out.push_str(",\"custom\":");
        write_pair_array(out, &self.custom);
        out.push('}');
    }
}

// ---------------------------------------------------------------------------
// Line + CommentStyle
// ---------------------------------------------------------------------------

impl ToJson for Line {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        match self {
            Line::Lyrics(l) => {
                out.push_str("\"kind\":\"lyrics\",\"value\":");
                l.to_json(out);
            }
            Line::Directive(d) => {
                out.push_str("\"kind\":\"directive\",\"value\":");
                d.to_json(out);
            }
            Line::Comment(style, text) => {
                out.push_str("\"kind\":\"comment\",\"style\":");
                style.to_json(out);
                out.push_str(",\"text\":");
                write_str(out, text);
            }
            Line::Empty => {
                out.push_str("\"kind\":\"empty\"");
            }
        }
        out.push('}');
    }
}

impl ToJson for CommentStyle {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            CommentStyle::Normal => "\"normal\"",
            CommentStyle::Italic => "\"italic\"",
            CommentStyle::Boxed => "\"boxed\"",
            CommentStyle::Highlight => "\"highlight\"",
        };
        out.push_str(s);
    }
}

// ---------------------------------------------------------------------------
// LyricsLine / LyricsSegment / TextSpan
// ---------------------------------------------------------------------------

impl ToJson for LyricsLine {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"segments\":");
        write_array(out, &self.segments);
        out.push('}');
    }
}

impl ToJson for LyricsSegment {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"chord\":");
        match &self.chord {
            Some(c) => c.to_json(out),
            None => out.push_str("null"),
        }
        out.push_str(",\"text\":");
        write_str(out, &self.text);
        out.push_str(",\"spans\":");
        write_array(out, &self.spans);
        out.push('}');
    }
}

impl ToJson for TextSpan {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        match self {
            TextSpan::Plain(s) => {
                out.push_str("\"kind\":\"plain\",\"value\":");
                write_str(out, s);
            }
            TextSpan::Bold(children) => {
                out.push_str("\"kind\":\"bold\",\"children\":");
                write_array(out, children);
            }
            TextSpan::Italic(children) => {
                out.push_str("\"kind\":\"italic\",\"children\":");
                write_array(out, children);
            }
            TextSpan::Highlight(children) => {
                out.push_str("\"kind\":\"highlight\",\"children\":");
                write_array(out, children);
            }
            TextSpan::Comment(children) => {
                out.push_str("\"kind\":\"comment\",\"children\":");
                write_array(out, children);
            }
            TextSpan::Span(attrs, children) => {
                out.push_str("\"kind\":\"span\",\"attributes\":");
                attrs.to_json(out);
                out.push_str(",\"children\":");
                write_array(out, children);
            }
        }
        out.push('}');
    }
}

impl ToJson for SpanAttributes {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"fontFamily\":");
        write_opt_str(out, &self.font_family);
        out.push_str(",\"size\":");
        write_opt_str(out, &self.size);
        out.push_str(",\"foreground\":");
        write_opt_str(out, &self.foreground);
        out.push_str(",\"background\":");
        write_opt_str(out, &self.background);
        out.push_str(",\"weight\":");
        write_opt_str(out, &self.weight);
        out.push_str(",\"style\":");
        write_opt_str(out, &self.style);
        out.push('}');
    }
}

// ---------------------------------------------------------------------------
// Chord / ChordDetail
// ---------------------------------------------------------------------------

impl ToJson for Chord {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"name\":");
        write_str(out, &self.name);
        out.push_str(",\"detail\":");
        match &self.detail {
            Some(d) => d.to_json(out),
            None => out.push_str("null"),
        }
        out.push_str(",\"display\":");
        write_opt_str(out, &self.display);
        out.push('}');
    }
}

impl ToJson for ChordDetail {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"root\":");
        self.root.to_json(out);
        out.push_str(",\"rootAccidental\":");
        match &self.root_accidental {
            Some(a) => a.to_json(out),
            None => out.push_str("null"),
        }
        out.push_str(",\"quality\":");
        self.quality.to_json(out);
        out.push_str(",\"extension\":");
        write_opt_str(out, &self.extension);
        out.push_str(",\"bassNote\":");
        match &self.bass_note {
            Some((note, acc)) => {
                out.push('{');
                out.push_str("\"note\":");
                note.to_json(out);
                out.push_str(",\"accidental\":");
                match acc {
                    Some(a) => a.to_json(out),
                    None => out.push_str("null"),
                }
                out.push('}');
            }
            None => out.push_str("null"),
        }
        out.push('}');
    }
}

impl ToJson for Note {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            Note::C => "\"C\"",
            Note::D => "\"D\"",
            Note::E => "\"E\"",
            Note::F => "\"F\"",
            Note::G => "\"G\"",
            Note::A => "\"A\"",
            Note::B => "\"B\"",
        };
        out.push_str(s);
    }
}

impl ToJson for Accidental {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            Accidental::Sharp => "\"sharp\"",
            Accidental::Flat => "\"flat\"",
        };
        out.push_str(s);
    }
}

impl ToJson for ChordQuality {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            ChordQuality::Major => "\"major\"",
            ChordQuality::Minor => "\"minor\"",
            ChordQuality::Diminished => "\"diminished\"",
            ChordQuality::Augmented => "\"augmented\"",
        };
        out.push_str(s);
    }
}

// ---------------------------------------------------------------------------
// ImageAttributes / ChordDefinition
// ---------------------------------------------------------------------------

impl ToJson for ImageAttributes {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"src\":");
        write_str(out, &self.src);
        out.push_str(",\"width\":");
        write_opt_str(out, &self.width);
        out.push_str(",\"height\":");
        write_opt_str(out, &self.height);
        out.push_str(",\"scale\":");
        write_opt_str(out, &self.scale);
        out.push_str(",\"title\":");
        write_opt_str(out, &self.title);
        out.push_str(",\"anchor\":");
        write_opt_str(out, &self.anchor);
        out.push('}');
    }
}

impl ToJson for ChordDefinition {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"name\":");
        write_str(out, &self.name);
        out.push_str(",\"keys\":");
        match &self.keys {
            Some(keys) => {
                out.push('[');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_i32(out, *k);
                }
                out.push(']');
            }
            None => out.push_str("null"),
        }
        out.push_str(",\"copy\":");
        write_opt_str(out, &self.copy);
        out.push_str(",\"copyall\":");
        write_opt_str(out, &self.copyall);
        out.push_str(",\"display\":");
        write_opt_str(out, &self.display);
        out.push_str(",\"format\":");
        write_opt_str(out, &self.format);
        out.push_str(",\"raw\":");
        write_opt_str(out, &self.raw);
        out.push_str(",\"transposable\":");
        write_bool(out, self.transposable);
        out.push('}');
    }
}

// ---------------------------------------------------------------------------
// Directive / DirectiveKind
// ---------------------------------------------------------------------------

impl ToJson for Directive {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"name\":");
        write_str(out, &self.name);
        out.push_str(",\"value\":");
        write_opt_str(out, &self.value);
        out.push_str(",\"kind\":");
        self.kind.to_json(out);
        out.push_str(",\"selector\":");
        write_opt_str(out, &self.selector);
        out.push('}');
    }
}

impl ToJson for DirectiveKind {
    fn to_json(&self, out: &mut String) {
        // Tagged-union encoding: every variant emits `{"tag":"…"}`,
        // payload-bearing variants add a `value` field. Camel-case
        // tag names so the TS consumer can index by literal type
        // without an extra mapping table.
        out.push('{');
        match self {
            // -- Metadata ------------------------------------------------
            DirectiveKind::Title => out.push_str("\"tag\":\"title\""),
            DirectiveKind::Subtitle => out.push_str("\"tag\":\"subtitle\""),
            DirectiveKind::Artist => out.push_str("\"tag\":\"artist\""),
            DirectiveKind::Composer => out.push_str("\"tag\":\"composer\""),
            DirectiveKind::Lyricist => out.push_str("\"tag\":\"lyricist\""),
            DirectiveKind::Album => out.push_str("\"tag\":\"album\""),
            DirectiveKind::Year => out.push_str("\"tag\":\"year\""),
            DirectiveKind::Key => out.push_str("\"tag\":\"key\""),
            DirectiveKind::Tempo => out.push_str("\"tag\":\"tempo\""),
            DirectiveKind::Time => out.push_str("\"tag\":\"time\""),
            DirectiveKind::Capo => out.push_str("\"tag\":\"capo\""),
            DirectiveKind::SortTitle => out.push_str("\"tag\":\"sortTitle\""),
            DirectiveKind::SortArtist => out.push_str("\"tag\":\"sortArtist\""),
            DirectiveKind::Arranger => out.push_str("\"tag\":\"arranger\""),
            DirectiveKind::Copyright => out.push_str("\"tag\":\"copyright\""),
            DirectiveKind::Duration => out.push_str("\"tag\":\"duration\""),
            DirectiveKind::Tag => out.push_str("\"tag\":\"tag\""),

            // -- Transpose -----------------------------------------------
            DirectiveKind::Transpose => out.push_str("\"tag\":\"transpose\""),

            // -- Comment -------------------------------------------------
            DirectiveKind::Comment => out.push_str("\"tag\":\"comment\""),
            DirectiveKind::CommentItalic => out.push_str("\"tag\":\"commentItalic\""),
            DirectiveKind::CommentBox => out.push_str("\"tag\":\"commentBox\""),
            DirectiveKind::Highlight => out.push_str("\"tag\":\"highlight\""),

            // -- Sections ------------------------------------------------
            DirectiveKind::StartOfChorus => out.push_str("\"tag\":\"startOfChorus\""),
            DirectiveKind::EndOfChorus => out.push_str("\"tag\":\"endOfChorus\""),
            DirectiveKind::StartOfVerse => out.push_str("\"tag\":\"startOfVerse\""),
            DirectiveKind::EndOfVerse => out.push_str("\"tag\":\"endOfVerse\""),
            DirectiveKind::StartOfBridge => out.push_str("\"tag\":\"startOfBridge\""),
            DirectiveKind::EndOfBridge => out.push_str("\"tag\":\"endOfBridge\""),
            DirectiveKind::StartOfTab => out.push_str("\"tag\":\"startOfTab\""),
            DirectiveKind::EndOfTab => out.push_str("\"tag\":\"endOfTab\""),
            DirectiveKind::StartOfGrid => out.push_str("\"tag\":\"startOfGrid\""),
            DirectiveKind::EndOfGrid => out.push_str("\"tag\":\"endOfGrid\""),

            // -- Font / size / colour ------------------------------------
            DirectiveKind::TextFont => out.push_str("\"tag\":\"textFont\""),
            DirectiveKind::TextSize => out.push_str("\"tag\":\"textSize\""),
            DirectiveKind::TextColour => out.push_str("\"tag\":\"textColour\""),
            DirectiveKind::ChordFont => out.push_str("\"tag\":\"chordFont\""),
            DirectiveKind::ChordSize => out.push_str("\"tag\":\"chordSize\""),
            DirectiveKind::ChordColour => out.push_str("\"tag\":\"chordColour\""),
            DirectiveKind::TabFont => out.push_str("\"tag\":\"tabFont\""),
            DirectiveKind::TabSize => out.push_str("\"tag\":\"tabSize\""),
            DirectiveKind::TabColour => out.push_str("\"tag\":\"tabColour\""),

            // -- Recall --------------------------------------------------
            DirectiveKind::Chorus => out.push_str("\"tag\":\"chorus\""),

            // -- Page control --------------------------------------------
            DirectiveKind::NewPage => out.push_str("\"tag\":\"newPage\""),
            DirectiveKind::NewPhysicalPage => out.push_str("\"tag\":\"newPhysicalPage\""),
            DirectiveKind::ColumnBreak => out.push_str("\"tag\":\"columnBreak\""),
            DirectiveKind::Columns => out.push_str("\"tag\":\"columns\""),
            DirectiveKind::Pagetype => out.push_str("\"tag\":\"pagetype\""),

            // -- Extended fonts ------------------------------------------
            DirectiveKind::TitleFont => out.push_str("\"tag\":\"titleFont\""),
            DirectiveKind::TitleSize => out.push_str("\"tag\":\"titleSize\""),
            DirectiveKind::TitleColour => out.push_str("\"tag\":\"titleColour\""),
            DirectiveKind::ChorusFont => out.push_str("\"tag\":\"chorusFont\""),
            DirectiveKind::ChorusSize => out.push_str("\"tag\":\"chorusSize\""),
            DirectiveKind::ChorusColour => out.push_str("\"tag\":\"chorusColour\""),
            DirectiveKind::FooterFont => out.push_str("\"tag\":\"footerFont\""),
            DirectiveKind::FooterSize => out.push_str("\"tag\":\"footerSize\""),
            DirectiveKind::FooterColour => out.push_str("\"tag\":\"footerColour\""),
            DirectiveKind::HeaderFont => out.push_str("\"tag\":\"headerFont\""),
            DirectiveKind::HeaderSize => out.push_str("\"tag\":\"headerSize\""),
            DirectiveKind::HeaderColour => out.push_str("\"tag\":\"headerColour\""),
            DirectiveKind::LabelFont => out.push_str("\"tag\":\"labelFont\""),
            DirectiveKind::LabelSize => out.push_str("\"tag\":\"labelSize\""),
            DirectiveKind::LabelColour => out.push_str("\"tag\":\"labelColour\""),
            DirectiveKind::GridFont => out.push_str("\"tag\":\"gridFont\""),
            DirectiveKind::GridSize => out.push_str("\"tag\":\"gridSize\""),
            DirectiveKind::GridColour => out.push_str("\"tag\":\"gridColour\""),
            DirectiveKind::TocFont => out.push_str("\"tag\":\"tocFont\""),
            DirectiveKind::TocSize => out.push_str("\"tag\":\"tocSize\""),
            DirectiveKind::TocColour => out.push_str("\"tag\":\"tocColour\""),

            // -- Song boundary -------------------------------------------
            DirectiveKind::NewSong => out.push_str("\"tag\":\"newSong\""),

            // -- Chord definition ----------------------------------------
            DirectiveKind::Define => out.push_str("\"tag\":\"define\""),
            DirectiveKind::ChordDirective => out.push_str("\"tag\":\"chordDirective\""),

            // -- Delegate envs -------------------------------------------
            DirectiveKind::StartOfAbc => out.push_str("\"tag\":\"startOfAbc\""),
            DirectiveKind::EndOfAbc => out.push_str("\"tag\":\"endOfAbc\""),
            DirectiveKind::StartOfLy => out.push_str("\"tag\":\"startOfLy\""),
            DirectiveKind::EndOfLy => out.push_str("\"tag\":\"endOfLy\""),
            DirectiveKind::StartOfSvg => out.push_str("\"tag\":\"startOfSvg\""),
            DirectiveKind::EndOfSvg => out.push_str("\"tag\":\"endOfSvg\""),
            DirectiveKind::StartOfTextblock => out.push_str("\"tag\":\"startOfTextblock\""),
            DirectiveKind::EndOfTextblock => out.push_str("\"tag\":\"endOfTextblock\""),
            DirectiveKind::StartOfMusicxml => out.push_str("\"tag\":\"startOfMusicxml\""),
            DirectiveKind::EndOfMusicxml => out.push_str("\"tag\":\"endOfMusicxml\""),

            // -- Custom sections -----------------------------------------
            DirectiveKind::StartOfSection(name) => {
                out.push_str("\"tag\":\"startOfSection\",\"value\":");
                write_str(out, name);
            }
            DirectiveKind::EndOfSection(name) => {
                out.push_str("\"tag\":\"endOfSection\",\"value\":");
                write_str(out, name);
            }

            // -- Generic meta --------------------------------------------
            DirectiveKind::Meta(value) => {
                out.push_str("\"tag\":\"meta\",\"value\":");
                write_str(out, value);
            }

            // -- Diagrams -----------------------------------------------
            DirectiveKind::Diagrams => out.push_str("\"tag\":\"diagrams\""),
            DirectiveKind::NoDiagrams => out.push_str("\"tag\":\"noDiagrams\""),

            // -- Image --------------------------------------------------
            DirectiveKind::Image(attrs) => {
                out.push_str("\"tag\":\"image\",\"value\":");
                attrs.to_json(out);
            }

            // -- Config override -----------------------------------------
            DirectiveKind::ConfigOverride(key) => {
                out.push_str("\"tag\":\"configOverride\",\"value\":");
                write_str(out, key);
            }

            // -- Unknown ------------------------------------------------
            DirectiveKind::Unknown(name) => {
                out.push_str("\"tag\":\"unknown\",\"value\":");
                write_str(out, name);
            }
        }
        out.push('}');
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Chord, LyricsSegment, Song};
    use crate::parse;

    #[test]
    fn empty_song_serialises_to_minimal_object() {
        let song = Song::new();
        let json = song.to_json_string();
        assert!(json.starts_with('{'));
        assert!(json.contains("\"metadata\":"));
        assert!(json.contains("\"lines\":[]"));
    }

    #[test]
    fn lyrics_line_round_trips_chord_and_text() {
        let song = parse("[Am]Hello [G]world").unwrap();
        let json = song.to_json_string();
        // Structural assertions, not byte-exact: enough fields present.
        assert!(json.contains("\"kind\":\"lyrics\""));
        assert!(json.contains("\"name\":\"Am\""));
        assert!(json.contains("\"name\":\"G\""));
        assert!(json.contains("\"text\":\"Hello \""));
        assert!(json.contains("\"text\":\"world\""));
    }

    #[test]
    fn directive_emits_kind_tag() {
        let song = parse("{title: My Song}").unwrap();
        let json = song.to_json_string();
        assert!(json.contains("\"kind\":\"directive\""));
        assert!(json.contains("\"tag\":\"title\""));
        assert!(json.contains("\"value\":\"My Song\""));
    }

    #[test]
    fn comment_line_carries_style() {
        let song = parse("{comment_italic: chorus next}").unwrap();
        let json = song.to_json_string();
        // The parser materialises `{comment_italic: …}` as a
        // `Line::Comment(Italic, …)` rather than a directive line —
        // the style flows through as the `style` field on the
        // comment-line JSON variant.
        assert!(json.contains("\"kind\":\"comment\""));
        assert!(json.contains("\"style\":\"italic\""));
        assert!(json.contains("\"text\":\"chorus next\""));
    }

    #[test]
    fn empty_lines_emit_empty_kind() {
        let song = parse("[Am]Hello\n\nWorld").unwrap();
        let json = song.to_json_string();
        assert!(json.contains("\"kind\":\"empty\""));
    }

    #[test]
    fn json_strings_escape_control_chars() {
        let mut s = String::new();
        write_str(&mut s, "tab\there");
        assert_eq!(s, "\"tab\\there\"");
        let mut s = String::new();
        write_str(&mut s, "\x01ctrl");
        assert_eq!(s, "\"\\u0001ctrl\"");
    }

    #[test]
    fn json_strings_escape_quote_and_backslash() {
        let mut s = String::new();
        write_str(&mut s, "she said \"hi\"\\back");
        assert_eq!(s, "\"she said \\\"hi\\\"\\\\back\"");
    }

    #[test]
    fn chord_detail_round_trips_root_quality_extension() {
        let chord = Chord::new("C#m7");
        let json = chord.to_json_string();
        assert!(json.contains("\"root\":\"C\""));
        assert!(json.contains("\"rootAccidental\":\"sharp\""));
        assert!(json.contains("\"quality\":\"minor\""));
        assert!(json.contains("\"extension\":\"7\""));
    }

    #[test]
    fn chord_with_no_detail_emits_null_detail() {
        // A non-parseable chord — the AST keeps the raw name and
        // `detail` is `None`; JSON should still round-trip.
        let seg = LyricsSegment::chord_only(Chord::new("???"));
        let json = seg.to_json_string();
        assert!(json.contains("\"name\":\"???\""));
        assert!(json.contains("\"detail\":null"));
    }

    #[test]
    fn section_directives_emit_distinct_tags() {
        let song = parse("{start_of_chorus}\n[Am]Hi\n{end_of_chorus}").unwrap();
        let json = song.to_json_string();
        assert!(json.contains("\"tag\":\"startOfChorus\""));
        assert!(json.contains("\"tag\":\"endOfChorus\""));
    }

    #[test]
    fn unknown_directive_carries_raw_name() {
        let song = parse("{frobnicate: yes}").unwrap();
        let json = song.to_json_string();
        assert!(json.contains("\"tag\":\"unknown\""));
        assert!(json.contains("\"value\":\"frobnicate\""));
    }

    #[test]
    fn multibyte_unicode_lyrics_round_trip() {
        // Regression guard for `.claude/rules/code-style.md` §"Unicode
        // Safety". The hand-rolled JSON serializer must preserve
        // multi-byte UTF-8 (CJK, RTL, emoji) verbatim — a regression
        // that escaped them through `\uXXXX` would still parse, but
        // a regression that truncated mid-byte would break the
        // `parseChordpro` → JSX walker pipeline silently.
        let song = parse("[Am]こんにちは [G]世界").unwrap();
        let json = song.to_json_string();
        assert!(
            json.contains("\"text\":\"こんにちは \""),
            "CJK lyrics must round-trip verbatim, got: {json}"
        );
        assert!(
            json.contains("\"text\":\"世界\""),
            "trailing CJK lyric must round-trip, got: {json}"
        );
    }

    #[test]
    fn rtl_and_emoji_lyrics_round_trip() {
        // Bidi marks and 4-byte emoji codepoints — separate test
        // because the parser's lyric handling for RTL-bearing
        // input has bitten us before (#2087-class).
        let song = parse("[Am]שלום 🎵").unwrap();
        let json = song.to_json_string();
        assert!(
            json.contains("\"text\":\"שלום 🎵\""),
            "RTL + emoji lyric must round-trip verbatim, got: {json}"
        );
    }
}
