# `chordsketch-convert` known deviations

Catalogues information dropped or approximated by each conversion
direction. Every entry corresponds to a [`ConversionWarning`] the
converter emits at runtime; this document is the durable record of
*why* each warning exists so a future contributor can reason about
whether the loss is still load-bearing.

## iReal Pro → ChordPro (#2053)

Implemented in `src/from_ireal.rs`. The mapping is **near-lossless**
— the items below are the only documented information drops.

### Letter section labels (`*A`, `*B`, …)

iReal's jazz-form letter labels do not have a ChordPro environment
directive. The converter emits each letter label as a
`{comment: Section X}` line so the renderer surfaces it visually
(matching iReal's "label above the bar" placement). On a hypothetical
ChordPro → iReal round trip the comment text would have to be
re-pattern-matched to recover the letter — that path is in scope
for #2061.

### `Intro` / `Outro` section labels

ChordPro has `start_of_chorus` / `start_of_verse` /
`start_of_bridge` / `start_of_tab` / `start_of_grid` but no
`start_of_intro` / `start_of_outro`. The converter falls back to a
`{comment: Intro}` / `{comment: Outro}` line, same shape as the
letter labels.

### Custom section labels

Multi-character custom labels (anything that is not a single letter
or one of the named variants `i v c b o`) are surfaced via a
`{comment}` with the original label text. ChordPro has no
arbitrary section directive; the comment is the closest available
primitive.

### Music symbols (segno / coda / D.C. / D.S. / Fine)

ChordPro has no first-class music-symbol directive. The converter
attaches each symbol to the bar that carries it as an inline text
segment in parentheses (e.g. `(Segno)`, `(Coda)`). This loses the
visual placement above-the-bar that iReal uses; renderers that want
to restore the iReal placement can pattern-match the inline text.

### N-th-ending markers

ChordPro has no first-class N-th-ending directive. The converter
emits the ending number as inline text (`1.`, `2.`) at the start
of the bar that carries it. Same caveat as music symbols: visual
formatting is the renderer's responsibility.

### Empty-bar repeat without prior chord

iReal's empty-chord bar means "repeat the previous bar" (the
renderer paints a `W` glyph). The converter emits the previous
chord again. If an empty bar has no prior chord — pathological
input — the converter records a [`WarningKind::LossyDrop`]
warning and emits a silent rest; ChordPro has no equivalent
"empty bar" representation.

### Bar boundaries / barline glyphs

ChordPro is fundamentally lyric-line-based; bar boundaries are
not part of its primary syntax. The converter inserts `|` /
`|||` / `|:` / `:|` text segments between chord groups so a
text-renderer surfaces the boundary visually. Renderers that
treat lyrics as freeform text will see these as plain pipe
characters; the loss is **representational**, not informational.

### Style tag

ChordPro's reference grammar has no `{style}` directive. The
converter routes the tag through `{meta: style <name>}` (the
ChordPro `{meta}` extension); every conformant ChordPro reader
preserves `{meta}` verbatim, so the round trip back to iReal is
intact via #2061.

## ChordPro → iReal Pro (#2061)

*Not yet implemented.* Documentation of expected drops will land
with the implementation.

[`ConversionWarning`]: https://docs.rs/chordsketch-convert/latest/chordsketch_convert/struct.ConversionWarning.html
[`WarningKind::LossyDrop`]: https://docs.rs/chordsketch-convert/latest/chordsketch_convert/enum.WarningKind.html
