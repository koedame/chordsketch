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

Implemented in `src/to_ireal.rs`. **Lossy** in this direction —
iReal Pro has no lyrics surface and a much narrower metadata
shape than ChordPro. Every drop surfaces as a
[`ConversionWarning`] at runtime so the caller never silently
loses data.

### Lyric text

iReal stores chords-and-bars only; there is no lyric line. Every
`LyricsLine` segment with non-empty text contributes to a
single aggregated `WarningKind::LossyDrop` warning ("lyrics
dropped"). The chord annotations are preserved as `BarChord`s.

### Comments (`{comment}` / `{comment_italic}` / `{comment_box}`)

iReal has no inline comment surface. All `Line::Comment` entries
drop with a single aggregated `WarningKind::LossyDrop` warning.

### Subtitles, artists, lyricists, album, year, copyright, tags

iReal's metadata model is just `title / composer / style / key /
time / tempo / transpose`; everything else surfaces as a separate
`WarningKind::LossyDrop` warning per category. The composer
field is filled from the *first* ChordPro composer if multiple
are present.

### Section labels

ChordPro environment directives map to iReal section labels:

| ChordPro | iReal |
|---|---|
| `{start_of_verse}` ... `{end_of_verse}` | `SectionLabel::Verse` |
| `{start_of_chorus}` ... `{end_of_chorus}` | `SectionLabel::Custom("Chorus")` (#2450 — iReal Pro itself does not have a `Chorus` rehearsal mark; the Custom string is preserved at the AST level only) |
| `{start_of_bridge}` ... `{end_of_bridge}` | `SectionLabel::Custom("Bridge")` (same rationale as Chorus) |
| (no directive — bare lyrics) | `SectionLabel::Letter('A')` (default; warns with `WarningKind::Approximated`) |
| `{start_of_tab}` / `{start_of_grid}` / others | dropped silently |

**URL-cycle lossiness for multi-character custom labels.** The iReal
URL grammar's section marker is `*X` where `X` is a single
character. `serialize_section_label` for `SectionLabel::Custom(s)`
emits only `s.chars().next()` — the first character — because the
parser only consumes one character after `*`. As a consequence:

- ChordPro `{start_of_chorus}` → iReal AST `Custom("Chorus")` —
  preserved.
- iReal AST `Custom("Chorus")` → URL — emitted as `*C` (truncated).
- URL `*C` → iReal AST `Letter('C')` (per `label_for`'s
  `'A'..='Z' => Letter(c)` arm).
- iReal AST `Letter('C')` → ChordPro `{comment: Section C}`.

So a ChordPro chart that travels **through the URL** (`ChordPro →
to_ireal → irealb_serialize → parse → from_ireal → ChordPro`) ends
up with `{comment: Section C}` rather than `{start_of_chorus}` /
`{end_of_chorus}`. The in-memory round-trip (`ChordPro → to_ireal
→ from_ireal → ChordPro`, no URL serialization) preserves the
chorus / bridge identity because `from_ireal::push_section_open`
matches on the `Custom(name)` string and re-emits the matching
ChordPro environment directive.

Callers that need full ChordPro `start_of_chorus` round-trip
fidelity must either keep the iReal AST in memory (skip the URL
serialization step) or accept the lossy `{comment: Section C}`
fallback. The lossiness is structural to the iReal URL grammar
and not a defect in the serializer; introducing a multi-char
`*XX` token would diverge from the published spec.

### Bar grouping

ChordPro is line-oriented (chords float over lyrics); iReal is
bar-oriented (chords sit inside bars). Each `LyricsLine` becomes
a **single bar** containing every chord in that line, in source
order, all positioned on beat 1. This is structurally lossy
compared to a hand-laid-out iReal chart but produces a usable
round trip for short-form chord-only sources. Beat-position
recovery is out of scope for this direction.

### Fonts / sizes / colours

`{textfont}`, `{textsize}`, `{textcolour}`, `{chordfont}`,
`{chordsize}`, `{chordcolour}`, `{tabfont}`, `{tabsize}`,
`{tabcolour}` all drop with a single aggregated
`WarningKind::LossyDrop` per class (font / colour) — iReal has
no typography or theming surface.

### `{capo}`

Dropped with `WarningKind::LossyDrop` — iReal has no capo
representation.

### `{define}` chord shapes

Dropped with `WarningKind::LossyDrop` — iReal stores only chord
names, not shapes / fingerings.

### Non-`style` `{meta}` directives

Only `{meta: style <name>}` round-trips. Any other `{meta: K V}`
contributes one aggregated `WarningKind::LossyDrop` warning.

[`ConversionWarning`]: https://docs.rs/chordsketch-convert/latest/chordsketch_convert/struct.ConversionWarning.html
[`WarningKind::LossyDrop`]: https://docs.rs/chordsketch-convert/latest/chordsketch_convert/enum.WarningKind.html
