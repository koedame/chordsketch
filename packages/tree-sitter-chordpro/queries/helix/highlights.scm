; Helix highlight queries. Sister file: ../highlights.scm.
;
; The two files cover the same nodes but speak different capture
; vocabularies, so neither can be copied over the other:
;
;   node            ../highlights.scm   this file
;   directive_name  @keyword            @keyword.directive
;   block_content   @embedded           @markup.raw.block
;   comment         @comment            @comment.line
;
; The names here come from Helix's theme scope list
; (https://docs.helix-editor.com/themes.html#syntax-highlighting), which
; asks for the most specific scope that fits; unstyled sub-scopes fall
; back to their parent (`keyword.directive` → `keyword`), so no theme
; loses colour by us being specific. In Helix, `embedded` means an
; interpolated expression inside a string template — the wrong meaning
; for a delegate block's foreign notation, which is a raw block.
;
; Copy destination: runtime/queries/chordpro/highlights.scm, either in
; ~/.config/helix or in a helix-editor/helix checkout.

(comment) @comment.line

; Directives: {name} and {name: value}
(directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword.directive
  "}" @punctuation.bracket)

(directive
  value: (directive_value) @string)

; Delegate blocks: {start_of_X} ... {end_of_X}
(block_start_directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword.directive
  "}" @punctuation.bracket)

(block_end_directive
  "{" @punctuation.bracket
  name: (directive_name) @keyword.directive
  "}" @punctuation.bracket)

; Tablature, ABC and LilyPond bodies are a foreign notation carried
; verbatim, not ChordPro source.
(block_content) @markup.raw.block

; Chord annotations: [Am], [G/B]
(chord
  "[" @punctuation.bracket
  (chord_name) @constant
  "]" @punctuation.bracket)
