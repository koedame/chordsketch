/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "chordpro",

  // Carriage returns are ignored (handle \r\n gracefully)
  extras: (_) => [/\r/],

  rules: {
    source_file: ($) => repeat($._line),

    _line: ($) =>
      choice($.comment, $.directive, $.content_line, $._empty_line),

    _empty_line: (_) => /\n/,

    // Lines starting with # are comments
    comment: (_) => token(seq("#", /[^\n]*/)),

    // Directives: {name} or {name: value}
    directive: ($) =>
      seq(
        "{",
        field("name", $.directive_name),
        optional(seq(token.immediate(/:\s*/), field("value", $.directive_value))),
        "}",
        optional("\n"),
      ),

    directive_name: (_) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    directive_value: (_) => /[^{}]+/,

    // Content lines contain chords and/or lyrics
    content_line: ($) => seq(repeat1(choice($.chord, $.lyrics)), "\n"),

    // Chord annotation: [Am], [G/B], etc.
    chord: ($) => seq("[", $.chord_name, "]"),

    chord_name: (_) => /[^\[\]\n]+/,

    // Lyric text: any text that is not a chord, directive, or comment
    lyrics: (_) => /[^\[\n{#]+/,
  },
});
