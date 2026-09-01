; Indent captures use the nvim-treesitter vocabulary (@indent.zero /
; @indent.auto). Helix uses a different one (@indent / @outdent) and
; does not read this file; its query set is queries/helix/.
;
; ChordPro is line-oriented and flat: comments, directives and
; chord/lyric lines all begin at column 0 and nothing nests, so no
; construct ever opens an indent level.
[
  (comment)
  (directive)
  (block_start_directive)
  (block_end_directive)
  (content_line)
] @indent.zero

; Delegate-block bodies carry a foreign notation (ABC, LilyPond,
; tablature) whose own indentation is meaningful. Hand those lines to
; the editor's own indent logic rather than flattening them to
; column 0.
(block_content) @indent.auto
