/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Environments whose content is verbatim: no chords, no directives, just
// text for another tool to render. Mirrors `Parser::verbatim_end_for` in
// `crates/chordpro/src/parser.rs`, the project's reference parser. Every
// other `{start_of_X}` — `verse`, `chorus`, `bridge`, a custom section — holds
// ordinary song lines, so its chords have to stay visible to the tree.
const DELEGATE_ENVIRONMENTS = ["abc", "grid", "ly", "musicxml", "svg", "tab", "textblock"];

// `prec` settles the tie with `directive_name`, which matches these names too:
// both alternatives are the same length, so without it the lexer has no reason
// to prefer the delegate token for `{start_of_abc}`.
const delegateName = (prefix) =>
  token(prec(1, new RegExp(`${prefix}_(?:${DELEGATE_ENVIRONMENTS.join("|")})`)));

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
