//! Structured tokeniser for `{start_of_grid}` body lines.
//!
//! Sister-site to `tokenizeGridLine` + `renderGridLine` in
//! `packages/react/src/chordpro-jsx.tsx`. The Rust side
//! exposes the same token shapes so the three Rust renderers
//! (`chordsketch-render-text`, `chordsketch-render-html`,
//! `chordsketch-render-pdf`) and the React JSX walker emit
//! sister-site-identical markup for the same grid input.
//!
//! Grid AST content remains verbatim text in
//! `LyricsSegment::text`; this module is consumed by
//! renderers at output time to extract semantic tokens.
//! Keeping the structured pass out of the AST avoids
//! breaking existing consumers that walk plain lyrics
//! lines.
//!
//! Per the ChordPro spec
//! (https://www.chordpro.org/chordpro/directives-env_grid/):
//!
//! - `shape="L+MxB+R"` — left margin cells + measures ×
//!   beats + right margin cells. Default `1+4x4+1`.
//! - `|` / `||` / `|.` / `|:` / `:|` / `:|:` / `|N` —
//!   barlines and volta endings.
//! - `%` / `%%` — repeat last / last two measures.
//! - `.` — empty beat cell (continuation).
//! - `n` — no-chord beat.
//! - `~` inside a cell — separates multiple chords sharing
//!   one beat slot (`C~G` = both C and G in this cell).
//! - `s` immediately after the opening barline — marks the
//!   row as a strum-pattern row. Subsequent cells are
//!   parsed as strum tokens (`up`/`dn`/`u+`/`d+`/`ua`/`da`).
//!
//! Dialect tokens widely used in jazz / pop chord-chart
//! conventions are passed through verbatim (no spec
//! definition, but tolerated):
//!
//! - Row labels (`A`, `Coda`) at the start of the row,
//!   before the first barline.
//! - Trailing comments (`repeat 4 times`) after the last
//!   barline.
//! - Tilde-prefixed strum tokens (`~dn`, `dn~up`, `~ux`).

/// Parsed `shape="L+MxB+R"` attribute on `{start_of_grid}`.
///
/// Renderers can use these dimensions to lay out cell
/// columns consistently (margin-left cells reserved for a
/// label column, body cells split into measures × beats,
/// margin-right cells reserved for a trailing-comment
/// column).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridShape {
    pub margin_left: u8,
    pub measures: u8,
    pub beats: u8,
    pub margin_right: u8,
}

impl Default for GridShape {
    /// Spec default when `{start_of_grid}` carries no
    /// `shape="..."` attribute: `1+4x4+1`.
    fn default() -> Self {
        Self {
            margin_left: 1,
            measures: 4,
            beats: 4,
            margin_right: 1,
        }
    }
}

impl GridShape {
    /// Parse a `shape="L+MxB+R"` attribute string.
    ///
    /// Accepts the bare value (`1+4x4+1`) or the attribute
    /// form `shape="1+4x4+1"`. Falls back to
    /// [`GridShape::default`] on parse failure.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let inner = extract_shape_value(raw).unwrap_or(raw.trim());
        parse_shape_body(inner).unwrap_or_default()
    }
}

fn extract_shape_value(raw: &str) -> Option<&str> {
    // `shape="..."` — quoted form
    if let Some(start) = find_substr_ci(raw, "shape") {
        let after = raw[start + 5..].trim_start();
        let after = after.strip_prefix('=')?.trim_start();
        if let Some(rest) = after.strip_prefix('"') {
            let end = rest.find('"')?;
            return Some(&rest[..end]);
        }
        // `shape=foo` — bare-value form, terminator is whitespace.
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        return Some(&after[..end]);
    }
    None
}

fn find_substr_ci(hay: &str, needle: &str) -> Option<usize> {
    let needle_lower = needle.to_ascii_lowercase();
    let bytes = hay.as_bytes();
    let n = needle_lower.len();
    if bytes.len() < n {
        return None;
    }
    for i in 0..=bytes.len() - n {
        if hay[i..i + n].eq_ignore_ascii_case(&needle_lower) {
            return Some(i);
        }
    }
    None
}

fn parse_shape_body(s: &str) -> Option<GridShape> {
    let parts: Vec<&str> = s.split('+').map(str::trim).collect();
    if parts.len() != 3 {
        return None;
    }
    let left = parts[0].parse::<u8>().ok()?;
    let body = parts[1];
    let right = parts[2].parse::<u8>().ok()?;
    let body_parts: Vec<&str> = body
        .split(|c| c == 'x' || c == 'X' || c == '*')
        .map(str::trim)
        .collect();
    if body_parts.len() != 2 {
        return None;
    }
    let measures = body_parts[0].parse::<u8>().ok()?;
    let beats = body_parts[1].parse::<u8>().ok()?;
    Some(GridShape {
        margin_left: left,
        measures,
        beats,
        margin_right: right,
    })
}

/// Single barline variant emitted by the tokeniser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridBarline {
    /// `|` — bare single barline.
    Single,
    /// `||` — double barline.
    Double,
    /// `|.` — final barline (end of piece / section).
    Final,
    /// `|:` — start of repeated section.
    RepeatStart,
    /// `:|` — end of repeated section.
    RepeatEnd,
    /// `:|:` — combined end + start (renders as a single
    /// visual glyph in standard notation).
    RepeatBoth,
}

/// One token in a tokenised grid row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GridToken {
    Space,
    Barline(GridBarline),
    /// `|N` volta ending marker (N ∈ 1..=9).
    Volta(u8),
    /// Chord cell (1 or more chord names). Single-element
    /// vec for a plain cell like `C`; multi-element for
    /// `~`-separated cells like `C~G`. An empty string in
    /// the vec preserves a leading-tilde anticipation
    /// marker (`~A` → `["", "A"]`).
    Cell(Vec<String>),
    /// `%` — repeat previous measure.
    Percent1,
    /// `%%` — repeat previous two measures.
    Percent2,
    /// `.` — beat continuation / empty cell.
    Continuation,
    /// `n` — no-chord marker (rare; iReal Pro convention).
    NoChord,
}

/// Per-row classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridRowKind {
    /// Standard chord row.
    Chord,
    /// Strum-pattern row — cells encode `up`/`dn`/`u+`/`d+`/
    /// etc. instead of chord names. Marked by a leading
    /// `s`/`S` cell immediately after the opening barline.
    Strum,
}

/// Structured representation of a single grid body line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridRow {
    /// Optional row label (`A`, `Coda`, etc.) at the start
    /// of the line, before the first barline. Not formally
    /// in the ChordPro spec but a widely used dialect
    /// convention.
    pub label: Option<String>,
    pub kind: GridRowKind,
    /// Body tokens between the first and last barline,
    /// inclusive of the barlines themselves.
    pub body: Vec<GridToken>,
    /// Optional trailing comment (`repeat 4 times`, etc.)
    /// after the last barline. Dialect convention.
    pub trailing_comment: Option<String>,
}

/// Tokenise a grid row into `[GridToken]`.
///
/// Sister-site to `tokenizeGridLine` in
/// `packages/react/src/chordpro-jsx.tsx`. Both functions
/// MUST produce token streams with one-to-one variant
/// correspondence so the four rendering surfaces (3 Rust +
/// the React JSX walker) emit equivalent markup.
#[must_use]
pub fn tokenize_grid_line(input: &str) -> Vec<GridToken> {
    let bytes = input.as_bytes();
    let mut out: Vec<GridToken> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b' ' || c == b'\t' {
            // Coalesce whitespace runs into one Space token.
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            out.push(GridToken::Space);
            continue;
        }
        if c == b'|' {
            let next = bytes.get(i + 1).copied();
            match next {
                Some(b':') => {
                    out.push(GridToken::Barline(GridBarline::RepeatStart));
                    i += 2;
                    continue;
                }
                Some(b'.') => {
                    out.push(GridToken::Barline(GridBarline::Final));
                    i += 2;
                    continue;
                }
                Some(b'|') => {
                    out.push(GridToken::Barline(GridBarline::Double));
                    i += 2;
                    continue;
                }
                Some(d @ b'1'..=b'9') => {
                    out.push(GridToken::Volta(d - b'0'));
                    i += 2;
                    continue;
                }
                _ => {
                    out.push(GridToken::Barline(GridBarline::Single));
                    i += 1;
                    continue;
                }
            }
        }
        if c == b':' && bytes.get(i + 1) == Some(&b'|') {
            if bytes.get(i + 2) == Some(&b':') {
                out.push(GridToken::Barline(GridBarline::RepeatBoth));
                i += 3;
                continue;
            }
            out.push(GridToken::Barline(GridBarline::RepeatEnd));
            i += 2;
            continue;
        }
        if c == b'%' {
            if bytes.get(i + 1) == Some(&b'%') {
                out.push(GridToken::Percent2);
                i += 2;
                continue;
            }
            out.push(GridToken::Percent1);
            i += 1;
            continue;
        }
        if c == b'.' {
            out.push(GridToken::Continuation);
            i += 1;
            continue;
        }
        if c == b'n'
            && (i + 1 >= bytes.len()
                || matches!(bytes[i + 1], b' ' | b'\t' | b'|'))
        {
            out.push(GridToken::NoChord);
            i += 1;
            continue;
        }
        // Read a cell token — any contiguous run of
        // non-whitespace / non-bar / non-colon characters.
        // Chord brackets `[X]` are unwrapped.
        let start = i;
        while i < bytes.len() && !matches!(bytes[i], b' ' | b'\t' | b'|' | b':') {
            i += 1;
        }
        let mut raw = &input[start..i];
        if raw.starts_with('[') && raw.ends_with(']') && raw.len() >= 2 {
            raw = &raw[1..raw.len() - 1];
        }
        if !raw.is_empty() {
            let names: Vec<String> = raw.split('~').map(|s| s.to_string()).collect();
            out.push(GridToken::Cell(names));
        }
    }
    out
}

/// Walk a tokenised grid row to extract its label, strum
/// classification, body, and trailing comment.
///
/// Sister-site to the bucket-split logic in
/// `renderGridLine` (React JSX walker). The two implementations
/// MUST agree on every classification rule.
#[must_use]
pub fn classify_grid_row(input: &str) -> GridRow {
    let tokens = tokenize_grid_line(input);
    let first_bar = tokens
        .iter()
        .position(|t| is_barline_like(t));
    let last_bar = tokens
        .iter()
        .rposition(|t| is_barline_like(t));

    let label = match first_bar {
        Some(idx) if idx > 0 => {
            let text = render_label_text(&tokens[..idx]);
            if text.is_empty() { None } else { Some(text) }
        }
        _ => None,
    };
    let trailing_comment = match last_bar {
        Some(idx) if idx + 1 < tokens.len() => {
            let text = render_label_text(&tokens[idx + 1..]);
            if text.is_empty() { None } else { Some(text) }
        }
        _ => None,
    };
    let body_range = match (first_bar, last_bar) {
        (Some(f), Some(l)) if l >= f => f..=l,
        _ => 0..=tokens.len().saturating_sub(1),
    };
    let body_slice: &[GridToken] = if tokens.is_empty() {
        &[]
    } else {
        &tokens[*body_range.start()..=*body_range.end()]
    };

    // Strum row detection: the first cell after the opening
    // barline is `s` / `S` (case-insensitive).
    let mut kind = GridRowKind::Chord;
    let mut strum_marker_idx: Option<usize> = None;
    for (i, t) in body_slice.iter().enumerate() {
        if is_barline_like(t) {
            continue;
        }
        if matches!(t, GridToken::Space) {
            continue;
        }
        if let GridToken::Cell(names) = t {
            if names.len() == 1 && (names[0] == "s" || names[0] == "S") {
                kind = GridRowKind::Strum;
                strum_marker_idx = Some(i);
            }
        }
        break;
    }

    // Drop the strum-row marker cell from the body — it's a
    // row-type signal, not a musical cell.
    let body: Vec<GridToken> = body_slice
        .iter()
        .enumerate()
        .filter(|(i, _)| strum_marker_idx.map_or(true, |sm| *i != sm))
        .map(|(_, t)| t.clone())
        .collect();

    GridRow {
        label,
        kind,
        body,
        trailing_comment,
    }
}

fn is_barline_like(t: &GridToken) -> bool {
    matches!(t, GridToken::Barline(_) | GridToken::Volta(_))
}

/// Render label / comment tokens as a flat string. Used
/// for the label column (text before the first barline) and
/// the comment column (text after the last barline).
fn render_label_text(tokens: &[GridToken]) -> String {
    let mut out = String::new();
    for t in tokens {
        match t {
            GridToken::Space => out.push(' '),
            GridToken::Cell(names) => out.push_str(&names.join("~")),
            GridToken::Continuation => out.push('.'),
            GridToken::Percent1 => out.push('%'),
            GridToken::Percent2 => out.push_str("%%"),
            GridToken::NoChord => out.push('n'),
            _ => {}
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_default_when_missing() {
        assert_eq!(GridShape::parse(""), GridShape::default());
        assert_eq!(GridShape::parse("garbage"), GridShape::default());
    }

    #[test]
    fn shape_parses_attribute_form() {
        assert_eq!(
            GridShape::parse(r#"shape="1+4x2+4""#),
            GridShape {
                margin_left: 1,
                measures: 4,
                beats: 2,
                margin_right: 4,
            }
        );
        assert_eq!(
            GridShape::parse(r#"shape="0+2x4+4""#),
            GridShape {
                margin_left: 0,
                measures: 2,
                beats: 4,
                margin_right: 4,
            }
        );
    }

    #[test]
    fn shape_parses_bare_value() {
        assert_eq!(
            GridShape::parse("2+8x3+1"),
            GridShape {
                margin_left: 2,
                measures: 8,
                beats: 3,
                margin_right: 1,
            }
        );
    }

    #[test]
    fn tokenize_basic_bar() {
        let toks = tokenize_grid_line("| G  .  .  . |");
        let kinds: Vec<_> = toks
            .iter()
            .filter(|t| !matches!(t, GridToken::Space))
            .collect();
        assert_eq!(kinds.len(), 6);
        assert!(matches!(kinds[0], GridToken::Barline(GridBarline::Single)));
        assert!(matches!(kinds[1], GridToken::Cell(n) if n == &vec!["G".to_string()]));
        assert!(matches!(kinds[2], GridToken::Continuation));
        assert!(matches!(kinds[3], GridToken::Continuation));
        assert!(matches!(kinds[4], GridToken::Continuation));
        assert!(matches!(kinds[5], GridToken::Barline(GridBarline::Single)));
    }

    #[test]
    fn tokenize_all_barline_variants() {
        let toks = tokenize_grid_line("|: G :|: C :| D || E |.");
        let bars: Vec<_> = toks
            .iter()
            .filter_map(|t| match t {
                GridToken::Barline(b) => Some(*b),
                _ => None,
            })
            .collect();
        assert_eq!(
            bars,
            vec![
                GridBarline::RepeatStart,
                GridBarline::RepeatBoth,
                GridBarline::RepeatEnd,
                GridBarline::Double,
                GridBarline::Final,
            ]
        );
    }

    #[test]
    fn tokenize_volta_endings() {
        let toks = tokenize_grid_line("|1 Em |2 Am");
        let voltas: Vec<u8> = toks
            .iter()
            .filter_map(|t| match t {
                GridToken::Volta(n) => Some(*n),
                _ => None,
            })
            .collect();
        assert_eq!(voltas, vec![1, 2]);
    }

    #[test]
    fn tokenize_percent_repeat_markers() {
        let toks = tokenize_grid_line("| % . | %% . |");
        let kinds: Vec<_> = toks
            .iter()
            .filter(|t| !matches!(t, GridToken::Space))
            .map(|t| std::mem::discriminant(t))
            .collect();
        // bar percent1 cont bar percent2 cont bar
        assert_eq!(kinds.len(), 7);
        assert!(matches!(toks[2], GridToken::Percent1));
        // toks[8] should be Percent2 (depending on spaces); find it
        assert!(toks.iter().any(|t| matches!(t, GridToken::Percent2)));
    }

    #[test]
    fn tokenize_multi_chord_tilde_split() {
        let toks = tokenize_grid_line("| C~G ~A |");
        let cells: Vec<&Vec<String>> = toks
            .iter()
            .filter_map(|t| match t {
                GridToken::Cell(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(cells[0], &vec!["C".to_string(), "G".to_string()]);
        assert_eq!(cells[1], &vec!["".to_string(), "A".to_string()]);
    }

    #[test]
    fn tokenize_no_chord_marker() {
        let toks = tokenize_grid_line("| n | G |");
        assert!(toks.iter().any(|t| matches!(t, GridToken::NoChord)));
    }

    #[test]
    fn tokenize_unwraps_bracketed_chord_names() {
        let toks = tokenize_grid_line("| [Am] [C] |");
        let cells: Vec<&Vec<String>> = toks
            .iter()
            .filter_map(|t| match t {
                GridToken::Cell(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(cells[0], &vec!["Am".to_string()]);
        assert_eq!(cells[1], &vec!["C".to_string()]);
    }

    #[test]
    fn classify_row_with_label() {
        let row = classify_grid_row("A || G7 . | C . |");
        assert_eq!(row.label.as_deref(), Some("A"));
        assert_eq!(row.kind, GridRowKind::Chord);
        assert!(row.trailing_comment.is_none());
    }

    #[test]
    fn classify_row_with_trailing_comment() {
        let row = classify_grid_row("|: G :| repeat 4 times");
        assert_eq!(row.label, None);
        assert_eq!(row.trailing_comment.as_deref(), Some("repeat 4 times"));
    }

    #[test]
    fn classify_row_strum_detection() {
        let row = classify_grid_row("|s dn up dn up |");
        assert_eq!(row.kind, GridRowKind::Strum);
        // The leading `s` cell should be filtered out.
        let cells: Vec<&Vec<String>> = row
            .body
            .iter()
            .filter_map(|t| match t {
                GridToken::Cell(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(cells.len(), 4);
        assert_eq!(cells[0], &vec!["dn".to_string()]);
    }

    #[test]
    fn classify_row_chord_when_not_strum() {
        let row = classify_grid_row("| G7 . . . |");
        assert_eq!(row.kind, GridRowKind::Chord);
    }
}
