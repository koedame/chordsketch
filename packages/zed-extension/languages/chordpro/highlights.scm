; Sister site: packages/tree-sitter-chordpro/queries/highlights.scm
; Keep both files in sync when making changes.

(comment) @comment

; Directives: {name} and {name: value}
(directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword
  "}" @punctuation.bracket)

(directive
  value: (directive_value) @string)

; Delegate blocks: {start_of_abc} ... {end_of_abc}, and the other
; environments whose content is verbatim
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
