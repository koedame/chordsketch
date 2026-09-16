/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Environments whose content is verbatim: no chords, no directives, just
// text for another tool to render. Mirrors `Parser::verbatim_end_for` in
// `crates/chordpro/src/parser.rs`, the project's reference parser. Every
// other `{start_of_X}` — `verse`, `chorus`, `bridge`, a custom section — holds
// ordinary song lines, so its chords have to stay visible to the tree.
const DELEGATE_ENVIRONMENTS = ["abc", "grid", "ly", "musicxml", "svg", "tab", "textblock"];

// Built from string literals, not a regex, and deliberately with no
// `prec()`: a bare literal like "start_of_tab" has no continuation once it
// reaches its own end, so it cannot out-compete `directive_name` (which
// keeps consuming identifier characters) on a longer custom section name —
// tree-sitter's longest-match rule picks `directive_name` for
// `{start_of_tablature}` or `{start_of_lyrics}` the same way it would for
// any other non-delegate section. A `new RegExp(...)` version of this
// (tried first) used `prec(1, ...)` to win the exact-match tie against
// `directive_name`, but that same precedence let the delegate token win the
// *prefix* match too, breaking those two names outright — a plain literal
// still wins the exact-match tie without that side effect, because a tie
// between an explicit-precedence-free literal and an explicit-precedence-free
// regex of equal length is settled by declaration order, and
// `block_start_directive` is declared above `directive_name` below.
const delegateName = (prefix) =>
  choice(...DELEGATE_ENVIRONMENTS.map((env) => `${prefix}_${env}`));

module.exports = grammar({
  name: "chordpro",

  // Carriage returns are ignored (handle \r\n gracefully)
  extras: (_) => [/\r/],

  // The comment token is handled by an external scanner so that `#` is
  // only recognised as a comment start at column 0 (the beginning of a
  // line).  Mid-line `#` (e.g. in `C#` or `Play the C# note`) must be
  // treated as ordinary lyric text.
  externals: ($) => [$.comment],

  rules: {
    source_file: ($) => repeat($._line),

    _line: ($) =>
      choice(
        $.comment,
        $.delegate_block,
        $.directive,
        $.content_line,
        $._empty_line,
      ),

    _empty_line: (_) => /\n/,

    // Delegate blocks: {start_of_abc} ... {end_of_abc}
    // These wrap content like ABC notation, Lilypond, etc.
    delegate_block: ($) =>
      seq(
        $.block_start_directive,
        optional($.block_content),
        $.block_end_directive,
      ),

    block_start_directive: ($) =>
      seq(
        "{",
        field("name", alias(delegateName("start_of"), $.directive_name)),
        optional(
          seq(token.immediate(/[: ]\s*/), field("value", $.directive_value)),
        ),
        "}",
        optional("\n"),
      ),

    block_end_directive: ($) =>
      seq(
        "{",
        field("name", alias(delegateName("end_of"), $.directive_name)),
        "}",
        optional("\n"),
      ),

    block_content: (_) => repeat1(/[^\n{]*\n/),

    // Directives: {name}, {name: value}, or {name value}
    directive: ($) =>
      seq(
        "{",
        field("name", $.directive_name),
        optional(
          seq(
            token.immediate(/[: ]\s*/),
            field("value", $.directive_value),
          ),
        ),
        "}",
        optional("\n"),
      ),

    // Allows hyphens for selector suffixes (e.g., textfont-piano)
    directive_name: (_) => /[a-zA-Z_][a-zA-Z0-9_-]*/,

    directive_value: (_) => /[^{}]+/,

    // Content lines contain chords and/or lyrics.
    // Trailing newline is optional to handle files without a final newline.
    content_line: ($) =>
      prec.right(seq(repeat1(choice($.chord, $.lyrics)), optional("\n"))),

    // Chord annotation: [Am], [G/B], etc.
    chord: ($) => seq("[", $.chord_name, "]"),

    chord_name: (_) => /[^\[\]\n]+/,

    // Lyric text: any text that is not a chord, directive, or syntax delimiter.
    // `#` is allowed mid-line (e.g. `C#`, `F# note`) because the external
    // scanner only matches comments at column 0.
    lyrics: (_) => /[^\[\n{}]+/,
  },
});
