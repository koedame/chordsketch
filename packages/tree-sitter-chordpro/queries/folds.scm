; Fold captures use the nvim-treesitter vocabulary (@fold).
;
; Delegate blocks ({start_of_chorus} … {end_of_chorus},
; {start_of_tab} … {end_of_tab}, {start_of_abc} … {end_of_abc}, …) are
; the only multi-line construct the grammar produces, so they are the
; only region worth folding. Everything else in ChordPro is a single
; line.
(delegate_block) @fold
