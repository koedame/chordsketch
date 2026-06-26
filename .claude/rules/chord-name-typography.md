# Chord-Name Typography

Every surface that **displays a chord name** to a reader MUST typeset its
accidentals as the Unicode musical symbols — `♭` (U+266D) and `♯` (U+266F) —
not the ASCII `b` / `#`. `Bb` reads as `B♭`, `F#m7b5` as `F♯m7♭5`,
`C7(b9,#11)` as `C7(♭9,♯11)`. The single source of truth is
`chordsketch_chordpro::typography::unicode_accidentals` (Rust) and its
sister `unicodeAccidentals` in `packages/react/src/chordpro-jsx.tsx`
(per [`fix-propagation.md`](fix-propagation.md) and
[`renderer-parity.md`](renderer-parity.md)). No surface re-implements the
conversion table; every surface routes through one of those two functions.

## What counts as a chord-name display surface

This is the **complete** set of places a chord name reaches a reader. A new
one inherits this rule automatically:

- **Inline chord names** above lyrics — the HTML renderer
  (`crates/render-html`) and the React JSX walker already typeset these.
- **Chord-diagram titles** — the chord name drawn above a fretboard /
  keyboard diagram. This was the gap that motivated this rule: the SVG /
  PDF / ASCII diagram renderers drew the raw `data.title()` / `voicing.title()`
  and showed `Bb` instead of `B♭`. The single chokepoint is
  `chordsketch_chordpro::chord_diagram::decompose_diagram_title`, which now
  returns **display-ready** `base` + `tensions` (accidentals already typeset);
  every diagram renderer routes through it:
  - the three SVG title sites (`render_svg_vertical_inner`,
    `render_svg_horizontal_inner`, `render_keyboard_svg_with_size` in
    `crates/chordpro/src/chord_diagram.rs`) — the single-line path draws
    `title.base`, **not** a re-read of `data.title()`, so it cannot bypass
    the conversion;
  - the ASCII fretted diagram (`render_ascii`, consumed by
    `chordsketch-render-text` and the LSP hover) applies `unicode_accidentals`
    to its title;
  - the render-text **keyboard** diagram branch (the `"  {name}: keys …"`
    listing in `crates/render-text/src/lib.rs`, the text renderer's
    piano-instrument fallback) applies `unicode_accidentals` to
    `voicing.title()` directly — it does not draw ASCII art and so does not go
    through `render_ascii`;
  - the PDF renderer's three `PdfTitleLayout` sites
    (`crates/render-pdf/src/lib.rs`) consume `decompose_diagram_title`'s
    `base` / `tensions` directly, so they inherit the conversion.
- **Key directives** (`{key: Bb}` → `Key: B♭`) — already typeset in the
  text / HTML / PDF renderers via `unicode_accidentals`.

## The rule

1. When adding a surface that renders a chord name (or a chord-diagram title),
   route the displayed string through `unicode_accidentals` /
   `unicodeAccidentals`. Never emit a chord name's `display_name()` / raw
   title verbatim into reader-facing output.
2. When fixing or extending typography on one chord-name surface, audit **all**
   the surfaces listed above for the same gap and fix them in the same PR
   (sister-site discipline). A diagram renderer that re-reads the raw title on
   its single-line path while the stacked path is typeset is the exact
   asymmetry this rule exists to prevent.
3. The structural work (splitting a diagram title into base + tension stack)
   keys off the ASCII `b` / `#` forms and therefore happens **before** the
   typography conversion. Apply `unicode_accidentals` last, at the boundary
   that produces the display string, so the split logic still recognises a
   flat-root (`Bb5` — the `b` is the root, not a `b5` tension) correctly.

## Cost note (PDF)

The PDF renderer embeds the bundled Noto CID font in full the first time any
non-Latin-1 glyph (`♭` / `♯`, CJK, …) appears in a document, so a PDF whose
only non-ASCII content is a typeset accidental carries the whole font
(~6.5 MB). This is a pre-existing trait of the PDF font architecture, not a
reason to leave diagram titles un-typeset — renderer parity wins. Reducing the
embed to just the used glyphs (CFF subsetting) is a separate, larger change to
the PDF font architecture, out of scope for chord-name typography; it is not
yet tracked by a dedicated issue.

## Enforcement

- `crates/chordpro/src/chord_diagram.rs` unit tests assert the typeset form on
  every diagram renderer (`render_svg_single_line_title_typesets_flat_root`,
  `render_keyboard_svg_single_line_title_typesets_flat_root`,
  `render_ascii_typesets_flat_root`,
  `render_svg_typesets_flat_in_display_override`, plus the
  `decompose_diagram_title` doctests / unit tests).
- The HTML / PDF golden fixtures (`diagrams-stacked-tensions`) pin the typeset
  output byte-for-byte.
- `crates/chordpro/src/typography.rs` tests pin `unicode_accidentals` itself;
  the React sister `unicodeAccidentals` is pinned in
  `packages/react/tests/chordpro-jsx-helpers.test.ts`.

## Why

A chord name is a piece of engraved music, not typewriter text. Showing `Bb`
where a musician expects `B♭` reads as unfinished. Every other chord-name
surface already typeset accidentals; the chord-diagram title — the surface a
beginner leans on most — silently lagged because two of its renderers re-read
the raw title instead of the typeset one. Centralising the typography in
`decompose_diagram_title` (the single source of truth all diagram renderers
already route through for the base/tension split) makes "the diagram title is
typeset" an invariant the test suite keeps true, rather than a property that
decays each time a renderer is added.
