; Sister sites, same nodes in a different capture vocabulary:
; queries/helix/highlights.scm (Helix) and
; packages/zed-extension/languages/chordpro/highlights.scm (Zed).
; A node rename in grammar.js has to be applied to all three.

(comment) @comment

; Directives: {name} and {name: value}
(directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword
  "}" @punctuation.bracket)

(directive
  value: (directive_value) @string)

; Delegate blocks: {start_of_X} ... {end_of_X}
(block_start_directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword
  "}" @punctuation.bracket)

(block_end_directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword
  "}" @punctuation.bracket)

(block_content) @embedded

; Chord annotations: [Am], [G/B]
(chord
  "[" @punctuation.bracket
  (chord_name) @constant
  "]" @punctuation.bracket)
