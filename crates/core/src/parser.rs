//! Parser that transforms a token stream into a ChordPro AST.
//!
//! The parser accepts the flat token sequence produced by [`crate::Lexer`] and
//! builds a [`Song`] AST. Each source line is classified as a directive, a
//! lyrics line (with optional inline chord annotations), an empty line, or a
//! comment (the `{comment: ...}` directive).
//!
//! # Convenience Function
//!
//! The [`parse`] function combines lexing and parsing into a single step:
//!
//! ```
//! use chordpro_core::parser::parse;
//!
//! let song = parse("{title: Hello}\n[Am]World").unwrap();
//! assert_eq!(song.lines.len(), 2);
//! ```
//!
//! # Error Handling
//!
//! The parser returns [`ParseError`] when the token stream contains structural
//! problems such as unclosed directives, unclosed chords, or empty directives.

use crate::Lexer;
use crate::ast::{Chord, Directive, Line, LyricsLine, LyricsSegment, Song};
use crate::token::{Span, Token, TokenKind};

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

/// An error encountered during parsing.
///
/// Each error carries a human-readable message and the [`Span`] in the source
/// text where the problem was detected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// A description of what went wrong.
    pub message: String,
    /// The location in the source text where the error was detected.
    pub span: Span,
}

impl ParseError {
    /// Creates a new `ParseError` with the given message and span.
    fn new(message: impl Into<String>, span: Span) -> Self {
        Self {
            message: message.into(),
            span,
        }
    }
}

impl core::fmt::Display for ParseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "parse error at {}:{}: {}",
            self.span.start.line, self.span.start.column, self.message
        )
    }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// A parser that transforms a token stream into a [`Song`] AST.
///
/// The parser is created from a `Vec<Token>` (typically produced by
/// [`Lexer::tokenize`]) and consumes tokens one at a time, building up the
/// AST line by line.
pub struct Parser {
    /// The token stream to consume.
    tokens: Vec<Token>,
    /// Current index into `tokens`.
    pos: usize,
}

impl Parser {
    /// Creates a new parser for the given token stream.
    #[must_use]
    pub fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    /// Parses the token stream and returns a [`Song`] AST.
    ///
    /// Returns a [`ParseError`] if the token stream contains structural
    /// problems (e.g., unclosed directives or chords).
    pub fn parse(mut self) -> Result<Song, ParseError> {
        let mut song = Song::new();

        while !self.is_at_end() {
            let line = self.parse_line()?;
            song.lines.push(line);
        }

        Ok(song)
    }

    // -- Token navigation ---------------------------------------------------

    /// Returns `true` when all meaningful tokens have been consumed.
    fn is_at_end(&self) -> bool {
        self.pos >= self.tokens.len() || self.peek_kind() == &TokenKind::Eof
    }

    /// Returns a reference to the current token's kind without advancing.
    fn peek_kind(&self) -> &TokenKind {
        self.tokens
            .get(self.pos)
            .map(|t| &t.kind)
            .unwrap_or(&TokenKind::Eof)
    }

    /// Returns a reference to the current token without advancing.
    fn peek(&self) -> &Token {
        // SAFETY: the caller ensures we are not past the end. The last token
        // is always Eof, so indexing is safe as long as `pos < tokens.len()`.
        &self.tokens[self.pos]
    }

    /// Advances past the current token and returns it.
    fn advance(&mut self) -> &Token {
        let tok = &self.tokens[self.pos];
        self.pos += 1;
        tok
    }

    // -- Line parsing -------------------------------------------------------

    /// Parses a single line (up to and including the next Newline or Eof).
    fn parse_line(&mut self) -> Result<Line, ParseError> {
        match self.peek_kind() {
            // An empty line: just a Newline token.
            TokenKind::Newline => {
                self.advance();
                Ok(Line::Empty)
            }
            // A directive line: starts with `{`.
            TokenKind::DirectiveOpen => self.parse_directive_line(),
            // Anything else: a lyrics line.
            _ => self.parse_lyrics_line(),
        }
    }

    // -- Directive parsing --------------------------------------------------

    /// Parses a directive line: `{name}` or `{name: value}`.
    ///
    /// After parsing the directive itself, consumes the trailing Newline (or
    /// verifies Eof).
    fn parse_directive_line(&mut self) -> Result<Line, ParseError> {
        let open_span = self.peek().span;
        self.advance(); // consume DirectiveOpen

        // Collect the directive name.
        let name = self.parse_directive_name(&open_span)?;

        // Check for a colon (indicates a value follows).
        let value = if self.peek_kind() == &TokenKind::Colon {
            self.advance(); // consume Colon
            Some(self.parse_directive_value())
        } else {
            None
        };

        // Expect the closing brace.
        if self.peek_kind() != &TokenKind::DirectiveClose {
            let span = self.peek().span;
            return Err(ParseError::new("unclosed directive: expected `}`", span));
        }
        self.advance();

        // Consume trailing newline if present.
        if self.peek_kind() == &TokenKind::Newline {
            self.advance();
        }

        // Trim whitespace from name and value.
        let name = name.trim().to_string();
        let value = value.map(|v| v.trim().to_string());

        // Check for the special `comment` / `c` directive -> Line::Comment.
        if name == "comment" || name == "c" {
            let text = value.unwrap_or_default();
            return Ok(Line::Comment(text));
        }

        let directive = match value {
            Some(v) => Directive::with_value(name, v),
            None => Directive::name_only(name),
        };

        Ok(Line::Directive(directive))
    }

    /// Parses the directive name (text between `{` and either `:` or `}`).
    fn parse_directive_name(&mut self, open_span: &Span) -> Result<String, ParseError> {
        let mut name = String::new();

        loop {
            match self.peek_kind() {
                TokenKind::Text(text) => {
                    name.push_str(text);
                    self.advance();
                }
                TokenKind::Colon | TokenKind::DirectiveClose => break,
                TokenKind::Eof | TokenKind::Newline => {
                    return Err(ParseError::new(
                        "unclosed directive: expected `}`",
                        *open_span,
                    ));
                }
                _ => {
                    // Unexpected token inside directive name (e.g., ChordOpen).
                    let tok = self.peek();
                    return Err(ParseError::new(
                        format!("unexpected {:?} in directive name", tok.kind),
                        tok.span,
                    ));
                }
            }
        }

        if name.trim().is_empty() {
            return Err(ParseError::new("empty directive name", *open_span));
        }

        Ok(name)
    }

    /// Parses the directive value (everything between `:` and `}`).
    ///
    /// The value may contain text tokens and other tokens (like ChordOpen/Close)
    /// that appear literally in the directive value. We collect all text content.
    fn parse_directive_value(&mut self) -> String {
        let mut value = String::new();

        loop {
            match self.peek_kind() {
                TokenKind::Text(text) => {
                    value.push_str(text);
                    self.advance();
                }
                TokenKind::DirectiveClose | TokenKind::Eof | TokenKind::Newline => break,
                TokenKind::Colon => {
                    // Additional colons in value are literal text.
                    value.push(':');
                    self.advance();
                }
                TokenKind::ChordOpen => {
                    value.push('[');
                    self.advance();
                }
                TokenKind::ChordClose => {
                    value.push(']');
                    self.advance();
                }
                TokenKind::DirectiveOpen => {
                    value.push('{');
                    self.advance();
                }
            }
        }

        value
    }

    // -- Lyrics line parsing ------------------------------------------------

    /// Parses a lyrics line containing text and optional chord annotations.
    ///
    /// The line is split into [`LyricsSegment`]s, each consisting of an
    /// optional chord followed by lyric text.
    fn parse_lyrics_line(&mut self) -> Result<Line, ParseError> {
        let mut segments: Vec<LyricsSegment> = Vec::new();
        let mut current_chord: Option<Chord> = None;
        let mut current_text = String::new();

        loop {
            match self.peek_kind() {
                TokenKind::Newline | TokenKind::Eof => {
                    break;
                }
                TokenKind::ChordOpen => {
                    // Flush the current segment before starting a new chord.
                    if current_chord.is_some() || !current_text.is_empty() {
                        segments.push(LyricsSegment::new(
                            current_chord.take(),
                            core::mem::take(&mut current_text),
                        ));
                    }

                    current_chord = Some(self.parse_chord()?);
                }
                TokenKind::Text(text) => {
                    current_text.push_str(text);
                    self.advance();
                }
                TokenKind::DirectiveOpen => {
                    // A directive starting mid-line is unexpected in well-formed
                    // ChordPro, but we handle it gracefully by treating it as
                    // the start of a directive line. First, flush the current
                    // lyrics if any, then break and let the directive be parsed
                    // on a subsequent call.
                    //
                    // However, per the task spec, directives always start at the
                    // beginning of a line. If we see one mid-line, it is likely
                    // a stray `{`. Treat the rest as text.
                    current_text.push('{');
                    self.advance();
                }
                TokenKind::DirectiveClose => {
                    // A stray `}` outside a directive — include as literal text.
                    current_text.push('}');
                    self.advance();
                }
                TokenKind::ChordClose => {
                    // A stray `]` outside a chord — include as literal text.
                    current_text.push(']');
                    self.advance();
                }
                TokenKind::Colon => {
                    // Outside a directive, colons are text. The lexer only emits
                    // Colon inside directives, so this shouldn't normally occur
                    // here, but handle defensively.
                    current_text.push(':');
                    self.advance();
                }
            }
        }

        // Flush the last segment.
        if current_chord.is_some() || !current_text.is_empty() {
            segments.push(LyricsSegment::new(current_chord, current_text));
        }

        // Consume the trailing newline if present.
        if self.peek_kind() == &TokenKind::Newline {
            self.advance();
        }

        if segments.is_empty() {
            Ok(Line::Empty)
        } else {
            Ok(Line::Lyrics(LyricsLine { segments }))
        }
    }

    /// Parses a chord annotation: `[` text `]`.
    ///
    /// The opening bracket has already been peeked; this method consumes it,
    /// the chord text, and the closing bracket.
    fn parse_chord(&mut self) -> Result<Chord, ParseError> {
        let open_span = self.peek().span;
        self.advance(); // consume ChordOpen

        let mut name = String::new();

        loop {
            match self.peek_kind() {
                TokenKind::Text(text) => {
                    name.push_str(text);
                    self.advance();
                }
                TokenKind::ChordClose => {
                    self.advance(); // consume ChordClose
                    break;
                }
                TokenKind::Newline | TokenKind::Eof => {
                    return Err(ParseError::new("unclosed chord: expected `]`", open_span));
                }
                _ => {
                    // Unexpected token inside a chord (e.g., DirectiveOpen).
                    let tok = self.peek();
                    return Err(ParseError::new(
                        format!("unexpected {:?} inside chord", tok.kind),
                        tok.span,
                    ));
                }
            }
        }

        Ok(Chord::new(name))
    }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/// Parses a ChordPro source string into a [`Song`] AST.
///
/// This is a convenience function that runs the lexer and parser in sequence.
///
/// # Errors
///
/// Returns a [`ParseError`] if the input contains structural problems.
///
/// # Examples
///
/// ```
/// use chordpro_core::parser::parse;
///
/// let song = parse("{title: Hello World}\n[Am]La la la").unwrap();
/// assert_eq!(song.lines.len(), 2);
/// ```
pub fn parse(input: &str) -> Result<Song, ParseError> {
    let tokens = Lexer::new(input).tokenize();
    Parser::new(tokens).parse()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Chord, Directive, Line, LyricsLine, LyricsSegment};

    // -- Helper -------------------------------------------------------------

    /// Parses the input and returns the lines, panicking on error.
    fn lines(input: &str) -> Vec<Line> {
        parse(input).expect("parse failed").lines
    }

    // -- Empty input --------------------------------------------------------

    #[test]
    fn empty_input() {
        let song = parse("").unwrap();
        assert!(song.lines.is_empty());
    }

    // -- Empty lines --------------------------------------------------------

    #[test]
    fn single_empty_line() {
        let result = lines("\n");
        assert_eq!(result, vec![Line::Empty]);
    }

    #[test]
    fn multiple_empty_lines() {
        let result = lines("\n\n\n");
        assert_eq!(result, vec![Line::Empty, Line::Empty, Line::Empty]);
    }

    // -- Plain text (lyrics without chords) ---------------------------------

    #[test]
    fn plain_text_line() {
        let result = lines("Hello world");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::text_only("Hello world")],
            })]
        );
    }

    #[test]
    fn multiple_plain_text_lines() {
        let result = lines("Line one\nLine two");
        assert_eq!(
            result,
            vec![
                Line::Lyrics(LyricsLine {
                    segments: vec![LyricsSegment::text_only("Line one")],
                }),
                Line::Lyrics(LyricsLine {
                    segments: vec![LyricsSegment::text_only("Line two")],
                }),
            ]
        );
    }

    // -- Chord annotations --------------------------------------------------

    #[test]
    fn single_chord_with_text() {
        let result = lines("[Am]Hello");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::new(Some(Chord::new("Am")), "Hello")],
            })]
        );
    }

    #[test]
    fn multiple_chords_with_text() {
        let result = lines("[Am]Hello [G]world");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![
                    LyricsSegment::new(Some(Chord::new("Am")), "Hello "),
                    LyricsSegment::new(Some(Chord::new("G")), "world"),
                ],
            })]
        );
    }

    #[test]
    fn chord_only_no_text() {
        let result = lines("[Am]");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::chord_only(Chord::new("Am"))],
            })]
        );
    }

    #[test]
    fn consecutive_chords_no_text_between() {
        let result = lines("[Am][G]");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![
                    LyricsSegment::chord_only(Chord::new("Am")),
                    LyricsSegment::chord_only(Chord::new("G")),
                ],
            })]
        );
    }

    #[test]
    fn text_before_first_chord() {
        let result = lines("Hello [Am]world");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![
                    LyricsSegment::text_only("Hello "),
                    LyricsSegment::new(Some(Chord::new("Am")), "world"),
                ],
            })]
        );
    }

    #[test]
    fn chord_at_end_of_line() {
        let result = lines("Hello [Am]");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![
                    LyricsSegment::text_only("Hello "),
                    LyricsSegment::chord_only(Chord::new("Am")),
                ],
            })]
        );
    }

    #[test]
    fn empty_chord_name() {
        // An empty chord `[]` is valid — chord name is an empty string.
        let result = lines("[]text");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::new(Some(Chord::new("")), "text")],
            })]
        );
    }

    // -- Directives ---------------------------------------------------------

    #[test]
    fn directive_with_value() {
        let result = lines("{title: My Song}");
        assert_eq!(
            result,
            vec![Line::Directive(Directive::with_value("title", "My Song"))],
        );
    }

    #[test]
    fn directive_without_value() {
        let result = lines("{start_of_chorus}");
        assert_eq!(
            result,
            vec![Line::Directive(Directive::name_only("start_of_chorus"))],
        );
    }

    #[test]
    fn directive_value_trimmed() {
        let result = lines("{title:  Hello World  }");
        assert_eq!(
            result,
            vec![Line::Directive(Directive::with_value(
                "title",
                "Hello World"
            ))],
        );
    }

    #[test]
    fn directive_name_trimmed() {
        let result = lines("{  title  : value}");
        assert_eq!(
            result,
            vec![Line::Directive(Directive::with_value("title", "value"))],
        );
    }

    #[test]
    fn directive_with_colon_in_value() {
        // The lexer emits multiple Colon tokens; the parser joins extra colons.
        let result = lines("{comment: time 10:30}");
        // This is the `comment` directive, so it becomes Line::Comment.
        assert_eq!(result, vec![Line::Comment("time 10:30".to_string())]);
    }

    #[test]
    fn directive_followed_by_lyrics() {
        let result = lines("{title: Test}\n[Am]Hello");
        assert_eq!(
            result,
            vec![
                Line::Directive(Directive::with_value("title", "Test")),
                Line::Lyrics(LyricsLine {
                    segments: vec![LyricsSegment::new(Some(Chord::new("Am")), "Hello")],
                }),
            ]
        );
    }

    // -- Comment directive --------------------------------------------------

    #[test]
    fn comment_directive_full_name() {
        let result = lines("{comment: This is a comment}");
        assert_eq!(result, vec![Line::Comment("This is a comment".to_string())],);
    }

    #[test]
    fn comment_directive_short_name() {
        let result = lines("{c: Short comment}");
        assert_eq!(result, vec![Line::Comment("Short comment".to_string())],);
    }

    #[test]
    fn comment_directive_no_value() {
        let result = lines("{comment}");
        assert_eq!(result, vec![Line::Comment(String::new())]);
    }

    // -- Error cases --------------------------------------------------------

    #[test]
    fn unclosed_directive() {
        let err = parse("{title: oops").unwrap_err();
        assert!(
            err.message.contains("unclosed directive"),
            "error message was: {}",
            err.message
        );
    }

    #[test]
    fn unclosed_chord() {
        let err = parse("[Am").unwrap_err();
        assert!(
            err.message.contains("unclosed chord"),
            "error message was: {}",
            err.message
        );
    }

    #[test]
    fn empty_directive_name() {
        let err = parse("{}").unwrap_err();
        assert!(
            err.message.contains("empty directive name"),
            "error message was: {}",
            err.message
        );
    }

    #[test]
    fn empty_directive_with_colon() {
        let err = parse("{: value}").unwrap_err();
        assert!(
            err.message.contains("empty directive name"),
            "error message was: {}",
            err.message
        );
    }

    #[test]
    fn unclosed_chord_at_newline() {
        let err = parse("[Am\ntext").unwrap_err();
        assert!(
            err.message.contains("unclosed chord"),
            "error message was: {}",
            err.message
        );
    }

    #[test]
    fn parse_error_display() {
        let err = parse("{title: no close").unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("parse error at"));
        assert!(msg.contains("unclosed directive"));
    }

    // -- Mixed content / integration ----------------------------------------

    #[test]
    fn full_song() {
        let input = "\
{title: Amazing Grace}
{artist: John Newton}

[G]Amazing [G7]grace, how [C]sweet the [G]sound
[G]That saved a [Em]wretch like [D]me";

        let song = parse(input).unwrap();
        assert_eq!(song.lines.len(), 5);

        // First line: title directive
        assert_eq!(
            song.lines[0],
            Line::Directive(Directive::with_value("title", "Amazing Grace")),
        );

        // Second line: artist directive
        assert_eq!(
            song.lines[1],
            Line::Directive(Directive::with_value("artist", "John Newton")),
        );

        // Third line: empty
        assert_eq!(song.lines[2], Line::Empty);

        // Fourth line: lyrics with chords
        if let Line::Lyrics(ref lyrics) = song.lines[3] {
            assert_eq!(lyrics.text(), "Amazing grace, how sweet the sound");
            assert!(lyrics.has_chords());
            assert_eq!(lyrics.segments.len(), 4);
            assert_eq!(lyrics.segments[0].chord.as_ref().unwrap().name, "G");
            assert_eq!(lyrics.segments[0].text, "Amazing ");
            assert_eq!(lyrics.segments[1].chord.as_ref().unwrap().name, "G7");
            assert_eq!(lyrics.segments[1].text, "grace, how ");
            assert_eq!(lyrics.segments[2].chord.as_ref().unwrap().name, "C");
            assert_eq!(lyrics.segments[2].text, "sweet the ");
            assert_eq!(lyrics.segments[3].chord.as_ref().unwrap().name, "G");
            assert_eq!(lyrics.segments[3].text, "sound");
        } else {
            panic!("expected Line::Lyrics for line 4");
        }

        // Fifth line: lyrics with chords
        if let Line::Lyrics(ref lyrics) = song.lines[4] {
            assert_eq!(lyrics.text(), "That saved a wretch like me");
            assert_eq!(lyrics.segments.len(), 3);
        } else {
            panic!("expected Line::Lyrics for line 5");
        }
    }

    #[test]
    fn song_with_sections() {
        let input = "\
{start_of_chorus}
[C]La la [G]la
{end_of_chorus}";

        let song = parse(input).unwrap();
        assert_eq!(song.lines.len(), 3);
        assert!(matches!(song.lines[0], Line::Directive(_)));
        assert!(matches!(song.lines[1], Line::Lyrics(_)));
        assert!(matches!(song.lines[2], Line::Directive(_)));
    }

    #[test]
    fn song_with_comments_and_empty_lines() {
        let input = "\
{title: Test}
{comment: Intro}

[Am]Hello
";

        let song = parse(input).unwrap();
        assert_eq!(song.lines.len(), 4);
        assert_eq!(
            song.lines[0],
            Line::Directive(Directive::with_value("title", "Test"))
        );
        assert_eq!(song.lines[1], Line::Comment("Intro".to_string()));
        assert_eq!(song.lines[2], Line::Empty);
        assert!(matches!(song.lines[3], Line::Lyrics(_)));
    }

    #[test]
    fn crlf_line_endings() {
        let input = "{title: Test}\r\n[Am]Hello\r\n";
        let song = parse(input).unwrap();
        assert_eq!(song.lines.len(), 2);
        assert_eq!(
            song.lines[0],
            Line::Directive(Directive::with_value("title", "Test")),
        );
        assert!(matches!(song.lines[1], Line::Lyrics(_)));
    }

    #[test]
    fn stray_close_brace_in_lyrics() {
        // A stray `}` outside a directive is treated as literal text.
        let result = lines("hello } world");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::text_only("hello } world")],
            })]
        );
    }

    #[test]
    fn stray_close_bracket_in_lyrics() {
        // A stray `]` outside a chord is treated as literal text.
        let result = lines("hello ] world");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::text_only("hello ] world")],
            })]
        );
    }

    #[test]
    fn unicode_in_chords_and_lyrics() {
        let result = lines("[Am]こんにちは [G]世界");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![
                    LyricsSegment::new(Some(Chord::new("Am")), "こんにちは "),
                    LyricsSegment::new(Some(Chord::new("G")), "世界"),
                ],
            })]
        );
    }

    #[test]
    fn metadata_not_populated_by_parser() {
        // The parser does not populate metadata — that is a separate concern.
        let song = parse("{title: Test}").unwrap();
        assert_eq!(song.metadata.title, None);
    }

    #[test]
    fn multiple_colons_in_directive_value() {
        // Extra colons after the first are treated as part of the value.
        let result = lines("{meta: key:value:extra}");
        assert_eq!(
            result,
            vec![Line::Directive(Directive::with_value(
                "meta",
                "key:value:extra"
            ))],
        );
    }

    #[test]
    fn directive_only_whitespace_name() {
        let err = parse("{   }").unwrap_err();
        assert!(
            err.message.contains("empty directive name"),
            "error message was: {}",
            err.message
        );
    }

    #[test]
    fn directive_with_brackets_in_value() {
        // Brackets inside a directive value are included literally.
        let result = lines("{comment: play [Am] here}");
        assert_eq!(result, vec![Line::Comment("play [Am] here".to_string())],);
    }

    #[test]
    fn chord_line_with_spaces() {
        let result = lines("[Am]  [G]  [C]");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![
                    LyricsSegment::new(Some(Chord::new("Am")), "  "),
                    LyricsSegment::new(Some(Chord::new("G")), "  "),
                    LyricsSegment::chord_only(Chord::new("C")),
                ],
            })]
        );
    }

    #[test]
    fn trailing_newline_produces_empty_line() {
        let result = lines("text\n");
        assert_eq!(
            result,
            vec![Line::Lyrics(LyricsLine {
                segments: vec![LyricsSegment::text_only("text")],
            })]
        );
    }

    #[test]
    fn parser_struct_directly() {
        // Test using Parser::new directly with tokens.
        let tokens = Lexer::new("[C]Hello").tokenize();
        let song = Parser::new(tokens).parse().unwrap();
        assert_eq!(song.lines.len(), 1);
    }
}
