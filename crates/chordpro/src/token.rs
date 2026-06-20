//! Token and span types for the ChordPro lexer.
//!
//! This module defines the token types produced by the lexer. Tokens represent
//! the smallest meaningful units in a ChordPro document. The lexer does not
//! understand the structure of the document (that is the parser's job); it only
//! identifies individual tokens and their positions.

/// A position in the source text, identified by line and column numbers.
///
/// Both `line` and `column` are 1-based, matching the conventions used by
/// editors and error messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    /// 1-based line number.
    pub line: usize,
    /// 1-based column number (in characters, not bytes).
    pub column: usize,
}

impl Position {
    /// Creates a new `Position` with the given line and column.
    #[must_use]
    pub fn new(line: usize, column: usize) -> Self {
        Self { line, column }
    }
}

/// A span in the source text, defined by a start and end position.
///
/// The start position is inclusive and the end position is exclusive, following
/// the convention of half-open intervals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    /// The start position (inclusive).
    pub start: Position,
    /// The end position (exclusive).
    pub end: Position,
}

impl Span {
    /// Creates a new `Span` from the given start and end positions.
    #[must_use]
    pub fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }
}

/// The kind of a token.
///
/// These represent the distinct syntactic elements that the lexer recognizes
/// in a ChordPro document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind {
    /// Opening brace `{` — starts a directive.
    DirectiveOpen,
    /// Closing brace `}` — ends a directive.
    DirectiveClose,
    /// Opening bracket `[` — starts a chord annotation.
    ChordOpen,
    /// Closing bracket `]` — ends a chord annotation.
    ChordClose,
    /// Colon `:` — separates a directive name from its value.
    ///
    /// Only emitted when the lexer is inside a directive (between `{` and `}`).
    Colon,
    /// A run of text content (lyrics, directive names, directive values, chord
    /// names, etc.).
    ///
    /// The lexer does not interpret text — it simply captures contiguous runs
    /// of characters that are not special delimiters.
    Text(String),
    /// A newline character (`\n` or `\r\n`).
    Newline,
    /// End of input.
    Eof,
}

/// A token produced by the lexer.
///
/// Each token carries its [`TokenKind`] and the [`Span`] that locates it in
/// the original source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    /// The kind of this token.
    pub kind: TokenKind,
    /// The location of this token in the source text.
    pub span: Span,
    /// The 0-based UTF-16 code-unit column of the token's start within its
    /// source line.
    ///
    /// [`Span`] tracks columns in Unicode scalar values (`char`s), which is
    /// the right unit for editor error messages but diverges from JavaScript
    /// string indexing on astral-plane characters (emoji, etc.). This field
    /// records the same start position counted in UTF-16 code units so the
    /// AST can hand chord-token source columns to JS consumers (the
    /// `@chordsketch/react` chord editor) that splice the source via
    /// `String.prototype.slice` — see [ADR-0017] and issue #2634. It equals
    /// `span.start.column - 1` for any line containing only Basic Multilingual
    /// Plane characters.
    ///
    /// [ADR-0017]: https://github.com/koedame/chordsketch/blob/main/docs/adr/0017-react-renders-from-ast.md
    pub utf16_col: usize,
}

impl Token {
    /// Creates a new `Token` with the given kind and span.
    ///
    /// [`Token::utf16_col`] is derived from `span.start.column` (the 0-based
    /// char column), which equals the UTF-16 column for Basic-Multilingual-Plane
    /// input. The lexer, which tracks the true UTF-16 column, uses
    /// [`Token::with_utf16_col`] instead so astral-plane input stays accurate.
    #[must_use]
    pub fn new(kind: TokenKind, span: Span) -> Self {
        let utf16_col = span.start.column.saturating_sub(1);
        Self {
            kind,
            span,
            utf16_col,
        }
    }

    /// Creates a new `Token` with an explicit 0-based UTF-16 start column.
    #[must_use]
    pub fn with_utf16_col(kind: TokenKind, span: Span, utf16_col: usize) -> Self {
        Self {
            kind,
            span,
            utf16_col,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_new() {
        let pos = Position::new(1, 5);
        assert_eq!(pos.line, 1);
        assert_eq!(pos.column, 5);
    }

    #[test]
    fn span_new() {
        let span = Span::new(Position::new(1, 1), Position::new(1, 5));
        assert_eq!(span.start, Position::new(1, 1));
        assert_eq!(span.end, Position::new(1, 5));
    }

    #[test]
    fn token_new() {
        let span = Span::new(Position::new(1, 1), Position::new(1, 2));
        let token = Token::new(TokenKind::DirectiveOpen, span);
        assert_eq!(token.kind, TokenKind::DirectiveOpen);
        assert_eq!(token.span, span);
    }

    #[test]
    fn token_kind_text_equality() {
        let a = TokenKind::Text("hello".to_string());
        let b = TokenKind::Text("hello".to_string());
        let c = TokenKind::Text("world".to_string());
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
