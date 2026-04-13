(comment) @comment

(directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword
  "}" @punctuation.bracket)

(directive
  value: (directive_value) @string)

(chord
  "[" @punctuation.bracket
  (chord_name) @constant
  "]" @punctuation.bracket)

(lyrics) @string.special
