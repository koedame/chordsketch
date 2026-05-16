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
    /// Parse a `shape="..."` attribute string.
    ///
    /// Three spec-defined forms are accepted:
    /// - `L+MxB+R` — full form (margin-left + measures × beats
    ///   + margin-right).
    /// - `MxB` — body only; margins default to 0.
    /// - `N` — bare cell count; treated as a single measure of
    ///   N beats with no margins.
    ///
    /// The `shape` attribute name and the `x` / `X` / `*`
    /// separator between measures and beats are all matched
    /// case-insensitively. Numeric components must be valid
    /// `u8` (0..=255). Falls back to [`GridShape::default`]
    /// (the spec default `1+4x4+1`) on parse failure.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let inner = extract_shape_value(raw).unwrap_or(raw.trim());
        parse_shape_body(inner).unwrap_or_default()
    }
}

/// Extract a `label="..."` attribute from a grid directive's
/// inline value. Returns the unquoted label string if found,
/// otherwise `None`. Used by all renderers to surface the
/// spec-defined `{start_of_grid label="Intro"}` form as a
/// human-readable section heading without leaking the
/// attribute syntax into the rendered output.
#[must_use]
pub fn extract_grid_label(raw: &str) -> Option<String> {
    let start = find_substr_ci(raw, "label")?;
    let after = raw[start + 5..].trim_start();
    let after = after.strip_prefix('=')?.trim_start();
    if let Some(rest) = after.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    // Bare-value form `label=Intro` — terminator is whitespace.
    let end = after.find(char::is_whitespace).unwrap_or(after.len());
    if end == 0 {
        return None;
    }
    Some(after[..end].to_string())
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

/// Find an ASCII case-insensitive substring in a (possibly
/// non-ASCII) string, returning the BYTE offset of the match.
///
/// Walks char boundaries via `char_indices` instead of raw byte
/// offsets so multibyte UTF-8 sequences preceding the needle
/// don't trigger a "byte index N is not a char boundary" panic
/// when we slice for the comparison. The needle is restricted
/// to ASCII (the grid module only searches for the literal
/// `"shape"`), so byte-length comparison is safe.
fn find_substr_ci(hay: &str, needle: &str) -> Option<usize> {
    let n = needle.len();
    if n == 0 {
        return Some(0);
    }
    for (idx, _) in hay.char_indices() {
        let end = idx.checked_add(n)?;
        if end > hay.len() {
            return None;
        }
        // Only attempt the slice when `end` lands on a char
        // boundary; otherwise this position is the middle of a
        // multibyte sequence and the substring obviously can't
        // match an ASCII needle.
        if !hay.is_char_boundary(end) {
            continue;
        }
        if hay[idx..end].eq_ignore_ascii_case(needle) {
            return Some(idx);
        }
    }
    None
}

fn parse_shape_body(s: &str) -> Option<GridShape> {
    // The spec defines three forms (see
    // https://www.chordpro.org/chordpro/directives-env_grid/):
    //   `L+MxB+R`  — full form with explicit margin cells
    //   `MxB`      — body only; margins fall back to 0
    //   `N`        — bare cell count; treated as `0+NxN+0`
    //                where the body is a single measure of N
    //                beats (the spec lets the second factor
    //                default to the missing one)
    let parts: Vec<&str> = s.split('+').map(str::trim).collect();
    match parts.as_slice() {
        // Full form: L+MxB+R
        [left, body, right] => {
            let left = left.parse::<u8>().ok()?;
            let right = right.parse::<u8>().ok()?;
            let (measures, beats) = split_body_measures_beats(body)?;
            Some(GridShape {
                margin_left: left,
                measures,
                beats,
                margin_right: right,
            })
        }
        // Body-only form: MxB (margins default to 0)
        [body] => {
            let (measures, beats) = split_body_measures_beats(body)?;
            Some(GridShape {
                margin_left: 0,
                measures,
                beats,
                margin_right: 0,
            })
        }
        _ => None,
    }
}

/// Split a body specifier into `(measures, beats)`.
///
/// `4x4` → `(4, 4)`. `16` (bare cell count) → `(1, 16)` — the
/// spec treats a single integer as a flat 1-measure × N-beats
/// strip, which is what `shape="16"` renders to in the
/// reference implementation.
fn split_body_measures_beats(body: &str) -> Option<(u8, u8)> {
    let parts: Vec<&str> = body.split(['x', 'X', '*']).map(str::trim).collect();
    match parts.as_slice() {
        [measures, beats] => Some((measures.parse().ok()?, beats.parse().ok()?)),
        [single] => Some((1, single.parse().ok()?)),
        _ => None,
    }
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
        if c == b'n' && (i + 1 >= bytes.len() || matches!(bytes[i + 1], b' ' | b'\t' | b'|')) {
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
    // Empty input early-out — avoids two layers of
    // `saturating_sub(1)` guarding against an empty token
    // stream later in the function.
    if tokens.is_empty() {
        return GridRow {
            label: None,
            kind: GridRowKind::Chord,
            body: Vec::new(),
            trailing_comment: None,
        };
    }
    let first_bar = tokens.iter().position(is_barline_like);
    let last_bar = tokens.iter().rposition(is_barline_like);

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
    let body_slice: &[GridToken] = match (first_bar, last_bar) {
        (Some(f), Some(l)) if l >= f => &tokens[f..=l],
        // No barline anywhere — every token is body content.
        _ => &tokens[..],
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
        .filter(|(i, _)| strum_marker_idx != Some(*i))
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
    fn shape_survives_multibyte_preceding_text() {
        // Regression: previous `find_substr_ci` byte-indexed
        // through the input, panicking when a multibyte char
        // preceded "shape". Public API must not panic on any
        // input.
        let shape = GridShape::parse("\u{3042}shape=\"2+8x3+1\"");
        assert_eq!(
            shape,
            GridShape {
                margin_left: 2,
                measures: 8,
                beats: 3,
                margin_right: 1,
            }
        );
        // Multibyte preceding bare-value form should also work.
        assert_eq!(GridShape::parse("\u{30B7}shape=1+4x4+1").measures, 4);
        // Pure non-ASCII input falls back to default (no panic).
        assert_eq!(GridShape::parse("\u{4E2D}\u{6587}"), GridShape::default());
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
    fn extract_label_quoted_form() {
        assert_eq!(
            extract_grid_label(r#"label="Intro" shape="4x4""#),
            Some("Intro".to_string())
        );
    }

    #[test]
    fn extract_label_bare_form() {
        assert_eq!(extract_grid_label("label=Outro"), Some("Outro".to_string()));
    }

    #[test]
    fn extract_label_missing() {
        assert_eq!(extract_grid_label(r#"shape="1+4x4+1""#), None);
        assert_eq!(extract_grid_label(""), None);
    }

    #[test]
    fn shape_parses_body_only_form() {
        // Spec form `shape="MxB"` — margins default to 0.
        assert_eq!(
            GridShape::parse(r#"shape="4x4""#),
            GridShape {
                margin_left: 0,
                measures: 4,
                beats: 4,
                margin_right: 0,
            }
        );
    }

    #[test]
    fn shape_parses_bare_cell_count() {
        // Spec form `shape="N"` — single-measure strip of N
        // beats, no margins.
        assert_eq!(
            GridShape::parse(r#"shape="16""#),
            GridShape {
                margin_left: 0,
                measures: 1,
                beats: 16,
                margin_right: 0,
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
    fn tokenize_empty_bracket_cell_drops_to_no_token() {
        // `[]` unwraps to an empty string, which is then
        // filtered out by the cell-emission step. This is
        // intentional: an explicitly-empty bracket carries no
        // chord information, so the tokeniser treats it the
        // same as whitespace. The renderer therefore lays out
        // the surrounding beats as if `[]` weren't there.
        let toks = tokenize_grid_line("| [] G |");
        // Exactly one cell token surfaces — the `G`.
        let cells: Vec<&Vec<String>> = toks
            .iter()
            .filter_map(|t| match t {
                GridToken::Cell(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0], &vec!["G".to_string()]);
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
