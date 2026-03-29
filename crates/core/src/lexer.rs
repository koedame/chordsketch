//! Single-pass lexer for ChordPro documents.
//!
//! The lexer consumes a `&str` input and produces a sequence of [`Token`]s.
//! It recognises the structural delimiters of the ChordPro format (`{`, `}`,
//! `[`, `]`, and `:` inside directives) and groups everything else into
//! [`TokenKind::Text`] runs. Newlines are emitted as separate tokens because
//! they are semantically significant in the format.
//!
//! The lexer tracks whether it is currently inside a directive (between `{`
//! and `}`) so that it only emits [`TokenKind::Colon`] in that context. Outside
//! directives, a colon is simply part of a text run.
//!
//! # Escaped Characters
//!
//! A backslash (`\`) before any of the special characters (`{`, `}`, `[`, `]`,
//! `:`) causes the character to be included in the current text run rather than
//! being treated as a delimiter. A backslash before a non-special character is
//! preserved literally (both the backslash and the following character appear
//! in the text).

use crate::token::{Position, Span, Token, TokenKind};

/// A single-pass lexer for ChordPro source text.
///
/// Create a `Lexer` with [`Lexer::new`] and call [`Lexer::tokenize`] to
/// produce the full token stream.
pub struct Lexer {
    /// Pre-collected `(byte_offset, char)` pairs from the input.
    chars: Vec<(usize, char)>,
    /// Current index into `chars`.
    pos: usize,
    /// Current 1-based line number.
    line: usize,
    /// Current 1-based column number.
    column: usize,
    /// Whether the lexer is currently inside a directive (`{` … `}`).
    in_directive: bool,
}

impl Lexer {
    /// Creates a new `Lexer` for the given source text.
    #[must_use]
    pub fn new(input: &str) -> Self {
        Self {
            chars: input.char_indices().collect(),
            pos: 0,
            line: 1,
            column: 1,
            in_directive: false,
        }
    }

    /// Tokenizes the entire input and returns a vector of tokens.
    ///
    /// The returned vector always ends with a [`TokenKind::Eof`] token.
    #[must_use]
    pub fn tokenize(mut self) -> Vec<Token> {
        let mut tokens = Vec::new();

        while !self.is_at_end() {
            if let Some(token) = self.next_token() {
                tokens.push(token);
            }
        }

        // Emit the final EOF token.
        let eof_pos = Position::new(self.line, self.column);
        tokens.push(Token::new(TokenKind::Eof, Span::new(eof_pos, eof_pos)));

        tokens
    }

    /// Returns `true` when all input has been consumed.
    fn is_at_end(&self) -> bool {
        self.pos >= self.chars.len()
    }

    /// Peeks at the current character without advancing.
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).map(|&(_, ch)| ch)
    }

    /// Advances past the current character and updates line/column tracking.
    fn advance(&mut self) -> Option<char> {
        if let Some(&(_, ch)) = self.chars.get(self.pos) {
            self.pos += 1;
            if ch == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
            Some(ch)
        } else {
            None
        }
    }

    /// Produces the next token, or `None` if the input is exhausted.
    fn next_token(&mut self) -> Option<Token> {
        let ch = self.peek()?;

        match ch {
            '\n' => self.lex_newline(),
            '\r' => self.lex_carriage_return(),
            '{' => self.lex_single(TokenKind::DirectiveOpen, true),
            '}' => self.lex_single(TokenKind::DirectiveClose, false),
            '[' => self.lex_single(TokenKind::ChordOpen, false),
            ']' => self.lex_single(TokenKind::ChordClose, false),
            ':' if self.in_directive => self.lex_single(TokenKind::Colon, false),
            _ => self.lex_text(),
        }
    }

    /// Lexes a single-character token. If `enter_directive` is `true`, sets
    /// `in_directive` to `true`; if the token kind is `DirectiveClose`, sets
    /// it to `false`.
    fn lex_single(&mut self, kind: TokenKind, enter_directive: bool) -> Option<Token> {
        let start = Position::new(self.line, self.column);
        self.advance();
        let end = Position::new(self.line, self.column);

        if enter_directive {
            self.in_directive = true;
        }
        if kind == TokenKind::DirectiveClose {
            self.in_directive = false;
        }

        Some(Token::new(kind, Span::new(start, end)))
    }

    /// Lexes a newline token (`\n`).
    fn lex_newline(&mut self) -> Option<Token> {
        let start = Position::new(self.line, self.column);
        self.advance(); // consume '\n'
        let end = Position::new(self.line, self.column);
        Some(Token::new(TokenKind::Newline, Span::new(start, end)))
    }

    /// Lexes a `\r` character. If followed by `\n`, emits a single newline
    /// token covering both characters. Otherwise the `\r` is treated as text.
    fn lex_carriage_return(&mut self) -> Option<Token> {
        let start = Position::new(self.line, self.column);

        // Peek ahead: is this \r\n?
        let is_crlf = self.chars.get(self.pos + 1).map(|&(_, c)| c) == Some('\n');

        if is_crlf {
            // Advance past \r (does NOT bump line — we only bump on \n)
            self.pos += 1;
            self.column += 1;
            // Advance past \n (bumps line)
            self.advance(); // consumes '\n'
            let end = Position::new(self.line, self.column);
            Some(Token::new(TokenKind::Newline, Span::new(start, end)))
        } else {
            // Bare \r — treat as text.
            self.lex_text()
        }
    }

    /// Lexes a run of text characters.
    ///
    /// Text continues until a special delimiter, a newline, or end of input is
    /// reached. Backslash-escaped special characters are included in the text
    /// run rather than acting as delimiters.
    fn lex_text(&mut self) -> Option<Token> {
        let start = Position::new(self.line, self.column);
        let mut buf = String::new();

        while let Some(ch) = self.peek() {
            match ch {
                '\n' => break,
                '\r' => {
                    // Check for \r\n
                    let is_crlf = self.chars.get(self.pos + 1).map(|&(_, c)| c) == Some('\n');
                    if is_crlf {
                        break;
                    }
                    // Bare \r — include in text.
                    self.advance();
                    buf.push(ch);
                }
                '\\' => {
                    // Look ahead to see if the next char is a special character.
                    if let Some(&(_, next_ch)) = self.chars.get(self.pos + 1) {
                        if is_special(next_ch, self.in_directive) {
                            // Skip the backslash, include the escaped character.
                            self.advance(); // skip '\'
                            self.advance(); // consume the special char
                            buf.push(next_ch);
                        } else {
                            // Not a special char — keep both backslash and char.
                            self.advance();
                            buf.push(ch);
                        }
                    } else {
                        // Backslash at end of input — include it literally.
                        self.advance();
                        buf.push(ch);
                    }
                }
                '{' | '}' | '[' | ']' => break,
                ':' if self.in_directive => break,
                _ => {
                    self.advance();
                    buf.push(ch);
                }
            }
        }

        if buf.is_empty() {
            return None;
        }

        let end = Position::new(self.line, self.column);
        Some(Token::new(TokenKind::Text(buf), Span::new(start, end)))
    }
}

/// Returns `true` if the character is a special ChordPro delimiter.
///
/// The colon is only special inside directives.
fn is_special(ch: char, in_directive: bool) -> bool {
    matches!(ch, '{' | '}' | '[' | ']') || (ch == ':' && in_directive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::TokenKind::*;

    /// Helper: tokenize the input and return only the token kinds (dropping
    /// spans) for easier assertion.
    fn kinds(input: &str) -> Vec<TokenKind> {
        Lexer::new(input)
            .tokenize()
            .into_iter()
            .map(|t| t.kind)
            .collect()
    }

    // ------------------------------------------------------------------
    // Basic token types
    // ------------------------------------------------------------------

    #[test]
    fn empty_input() {
        let tokens = Lexer::new("").tokenize();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].kind, Eof);
    }

    #[test]
    fn single_newline() {
        assert_eq!(kinds("\n"), vec![Newline, Eof]);
    }

    #[test]
    fn crlf_newline() {
        assert_eq!(kinds("\r\n"), vec![Newline, Eof]);
    }

    #[test]
    fn plain_text() {
        assert_eq!(kinds("Hello world"), vec![Text("Hello world".into()), Eof],);
    }

    // ------------------------------------------------------------------
    // Directive syntax
    // ------------------------------------------------------------------

    #[test]
    fn simple_directive() {
        assert_eq!(
            kinds("{title: My Song}"),
            vec![
                DirectiveOpen,
                Text("title".into()),
                Colon,
                Text(" My Song".into()),
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn directive_without_value() {
        assert_eq!(
            kinds("{soc}"),
            vec![DirectiveOpen, Text("soc".into()), DirectiveClose, Eof,],
        );
    }

    #[test]
    fn directive_with_spaces_around_colon() {
        assert_eq!(
            kinds("{key : Am}"),
            vec![
                DirectiveOpen,
                Text("key ".into()),
                Colon,
                Text(" Am".into()),
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn colon_outside_directive_is_text() {
        assert_eq!(kinds("Note: hello"), vec![Text("Note: hello".into()), Eof],);
    }

    // ------------------------------------------------------------------
    // Chord syntax
    // ------------------------------------------------------------------

    #[test]
    fn chord_in_lyrics() {
        assert_eq!(
            kinds("[Am]Hello [G]world"),
            vec![
                ChordOpen,
                Text("Am".into()),
                ChordClose,
                Text("Hello ".into()),
                ChordOpen,
                Text("G".into()),
                ChordClose,
                Text("world".into()),
                Eof,
            ],
        );
    }

    #[test]
    fn chord_only_line() {
        assert_eq!(
            kinds("[Am]  [G]  [C]"),
            vec![
                ChordOpen,
                Text("Am".into()),
                ChordClose,
                Text("  ".into()),
                ChordOpen,
                Text("G".into()),
                ChordClose,
                Text("  ".into()),
                ChordOpen,
                Text("C".into()),
                ChordClose,
                Eof,
            ],
        );
    }

    // ------------------------------------------------------------------
    // Multiple lines
    // ------------------------------------------------------------------

    #[test]
    fn multiple_lines() {
        assert_eq!(
            kinds("{title: Test}\n[Am]Hello\nWorld"),
            vec![
                DirectiveOpen,
                Text("title".into()),
                Colon,
                Text(" Test".into()),
                DirectiveClose,
                Newline,
                ChordOpen,
                Text("Am".into()),
                ChordClose,
                Text("Hello".into()),
                Newline,
                Text("World".into()),
                Eof,
            ],
        );
    }

    #[test]
    fn empty_lines() {
        assert_eq!(
            kinds("Hello\n\nWorld"),
            vec![
                Text("Hello".into()),
                Newline,
                Newline,
                Text("World".into()),
                Eof,
            ],
        );
    }

    #[test]
    fn text_only_lines() {
        assert_eq!(
            kinds("just text here"),
            vec![Text("just text here".into()), Eof],
        );
    }

    // ------------------------------------------------------------------
    // Escaped characters
    // ------------------------------------------------------------------

    #[test]
    fn escaped_brace_in_text() {
        assert_eq!(
            kinds("hello \\{ world"),
            vec![Text("hello { world".into()), Eof],
        );
    }

    #[test]
    fn escaped_bracket() {
        assert_eq!(
            kinds("\\[not a chord\\]"),
            vec![Text("[not a chord]".into()), Eof],
        );
    }

    #[test]
    fn escaped_colon_inside_directive() {
        assert_eq!(
            kinds("{comment: 10\\:30 AM}"),
            vec![
                DirectiveOpen,
                Text("comment".into()),
                Colon,
                Text(" 10:30 AM".into()),
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn backslash_before_normal_char() {
        // Backslash before a non-special char is kept literally.
        assert_eq!(kinds("back\\slash"), vec![Text("back\\slash".into()), Eof],);
    }

    #[test]
    fn backslash_at_end_of_input() {
        assert_eq!(kinds("end\\"), vec![Text("end\\".into()), Eof],);
    }

    // ------------------------------------------------------------------
    // Span / position tracking
    // ------------------------------------------------------------------

    #[test]
    fn spans_for_directive() {
        let tokens = Lexer::new("{t: X}").tokenize();

        // {
        assert_eq!(tokens[0].span.start, Position::new(1, 1));
        assert_eq!(tokens[0].span.end, Position::new(1, 2));

        // t
        assert_eq!(tokens[1].span.start, Position::new(1, 2));
        assert_eq!(tokens[1].span.end, Position::new(1, 3));

        // :
        assert_eq!(tokens[2].span.start, Position::new(1, 3));
        assert_eq!(tokens[2].span.end, Position::new(1, 4));

        // " X"
        assert_eq!(tokens[3].span.start, Position::new(1, 4));
        assert_eq!(tokens[3].span.end, Position::new(1, 6));

        // }
        assert_eq!(tokens[4].span.start, Position::new(1, 6));
        assert_eq!(tokens[4].span.end, Position::new(1, 7));

        // EOF
        assert_eq!(tokens[5].span.start, Position::new(1, 7));
    }

    #[test]
    fn spans_across_lines() {
        let tokens = Lexer::new("AB\nCD").tokenize();

        // "AB"
        assert_eq!(tokens[0].span.start, Position::new(1, 1));
        assert_eq!(tokens[0].span.end, Position::new(1, 3));

        // \n
        assert_eq!(tokens[1].span.start, Position::new(1, 3));
        assert_eq!(tokens[1].span.end, Position::new(2, 1));

        // "CD"
        assert_eq!(tokens[2].span.start, Position::new(2, 1));
        assert_eq!(tokens[2].span.end, Position::new(2, 3));
    }

    // ------------------------------------------------------------------
    // Edge cases
    // ------------------------------------------------------------------

    #[test]
    fn nested_braces_produce_separate_tokens() {
        // Nested braces are not valid ChordPro, but the lexer should still
        // tokenize them without crashing.
        let toks = kinds("{{inner}}");
        assert_eq!(
            toks,
            vec![
                DirectiveOpen,
                DirectiveOpen,
                Text("inner".into()),
                DirectiveClose,
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn bracket_inside_directive() {
        // A bracket inside a directive is just a bracket token.
        assert_eq!(
            kinds("{comment: [Am] chord}"),
            vec![
                DirectiveOpen,
                Text("comment".into()),
                Colon,
                Text(" ".into()),
                ChordOpen,
                Text("Am".into()),
                ChordClose,
                Text(" chord".into()),
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn empty_directive() {
        assert_eq!(kinds("{}"), vec![DirectiveOpen, DirectiveClose, Eof],);
    }

    #[test]
    fn empty_chord() {
        assert_eq!(kinds("[]"), vec![ChordOpen, ChordClose, Eof],);
    }

    #[test]
    fn directive_across_lines_is_not_special() {
        // If a user forgets to close a directive, the lexer keeps
        // `in_directive` true through the newline. This is intentional —
        // the parser will report the error.
        let toks = kinds("{title\nvalue}");
        assert_eq!(
            toks,
            vec![
                DirectiveOpen,
                Text("title".into()),
                Newline,
                Text("value".into()),
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn multiple_colons_in_directive() {
        assert_eq!(
            kinds("{meta: key:value}"),
            vec![
                DirectiveOpen,
                Text("meta".into()),
                Colon,
                Text(" key".into()),
                Colon,
                Text("value".into()),
                DirectiveClose,
                Eof,
            ],
        );
    }

    #[test]
    fn unicode_text() {
        assert_eq!(
            kinds("[Am]こんにちは"),
            vec![
                ChordOpen,
                Text("Am".into()),
                ChordClose,
                Text("こんにちは".into()),
                Eof,
            ],
        );
    }

    #[test]
    fn full_song_snippet() {
        let input = "\
{title: Amazing Grace}
{artist: John Newton}

[G]Amazing [G7]grace, how [C]sweet the [G]sound
[G]That saved a [Em]wretch like [D]me";

        let toks = kinds(input);
        assert_eq!(
            toks,
            vec![
                // {title: Amazing Grace}
                DirectiveOpen,
                Text("title".into()),
                Colon,
                Text(" Amazing Grace".into()),
                DirectiveClose,
                Newline,
                // {artist: John Newton}
                DirectiveOpen,
                Text("artist".into()),
                Colon,
                Text(" John Newton".into()),
                DirectiveClose,
                Newline,
                // empty line
                Newline,
                // [G]Amazing [G7]grace, how [C]sweet the [G]sound
                ChordOpen,
                Text("G".into()),
                ChordClose,
                Text("Amazing ".into()),
                ChordOpen,
                Text("G7".into()),
                ChordClose,
                Text("grace, how ".into()),
                ChordOpen,
                Text("C".into()),
                ChordClose,
                Text("sweet the ".into()),
                ChordOpen,
                Text("G".into()),
                ChordClose,
                Text("sound".into()),
                Newline,
                // [G]That saved a [Em]wretch like [D]me
                ChordOpen,
                Text("G".into()),
                ChordClose,
                Text("That saved a ".into()),
                ChordOpen,
                Text("Em".into()),
                ChordClose,
                Text("wretch like ".into()),
                ChordOpen,
                Text("D".into()),
                ChordClose,
                Text("me".into()),
                Eof,
            ],
        );
    }
}
