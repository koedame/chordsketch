; Fold captures use the nvim-treesitter vocabulary (@fold).
;
; Delegate blocks ({start_of_abc} … {end_of_abc}, {start_of_ly} …
; {end_of_ly}, …) are the only multi-line construct the grammar
; produces, so they are the only region worth folding. A {start_of_verse}
; section is not one: its lines are ordinary song lines, each a node of
; its own, so the grammar has nothing spanning the section to fold.
(delegate_block) @fold
