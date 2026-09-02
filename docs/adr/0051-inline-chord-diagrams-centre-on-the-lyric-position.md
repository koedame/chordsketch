# 0051. Inline chord diagrams are centred on the lyric position they mark

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

[ADR-0027](0027-inline-hover-compact-chord-diagrams.md) added the `{diagrams:
inline}` mode, which replaces the chord name above a lyric with the chord's
compact diagram. The placement lives in the React JSX walker
(`@chordsketch/react`): each `.chord-block` is an inline-flex column stacking
the chord cell above its lyric segment, with `align-items: flex-start`.

That left alignment is right for a chord *name* — a token narrow enough that
its left edge marks the position on its own. A compact diagram is not: the
vertical guitar layout is 63px wide and the keyboard layout 136px, against an
18px kana or a ~10px Latin character. Aligning the diagram's left edge to the
segment therefore leaves the entire diagram hanging to the right of the note it
belongs to.

A first attempt (#2742) put `align-items: center` on
`.line--inline-diagrams .chord-block`. It was reverted (#2743): the cross-axis
alignment centres **both** children of the column, so every lyric segment
narrower than the diagram was pushed away from the segment before it — the
lyric line stopped reading as one continuous run, and the per-segment caret /
drag code that measures the `.lyrics` rect was measuring a segment that had
moved for a reason unrelated to the text.

The layout constraint that makes this awkward is that the two facts needed to
centre a wide box over a narrow sibling — the sibling's width, and the box's
own width — are never both available to CSS at the same time. Centring on the
segment's *midpoint* requires the block's content width to be the lyric's
width, which means the diagram can no longer reserve its own slot: neighbouring
diagrams then overlap (four kana with `{diagrams: piano}` render as one
continuous keyboard), and the reservation has to come back as a length constant
that no longer scales with the instrument.

## Decision

In `inline` mode, shift each chord cell by **half its own width**
(`transform: translateX(-50%)`), so the diagram's horizontal centre lands on
the start of the lyric segment its chord is attached to. Reserve a leading
gutter on the **whole song** (`--cs-inline-diagram-overhang`, default
`4.5rem`) for the half-diagram that now overhangs the start of the leftmost
line.

The centring transform is scoped to `.line--inline-diagrams
.chord-block-inline-diagram`, the class the walker emits only when
`diagrams.mode === 'inline'`, so chord-name (`section`) and `hover` output is
unchanged. The gutter is scoped to a `song--diagrams-inline` modifier on the
`.song` root, emitted once per document under the same condition — **not**
to `.line--inline-diagrams` directly (see Rationale).

## Rationale

- **The lyric layout is byte-identical to the left-aligned version.** A
  transform paints; it does not lay out. Every `.chord-block` keeps the width
  it had, every `.lyrics` segment keeps its position, and the caret / drag code
  that reads the `.lyrics` rect sees exactly what it saw before. This is the
  property #2742 lost, and the reason the fix is a transform rather than a
  cross-axis alignment.
- **Diagrams cannot collide, on any instrument.** The shift is a fraction of
  each diagram's *own* width, so every diagram on a line moves by the same
  amount when they are the same size and the gaps between them are preserved
  exactly. The 63px fretted layouts and the 136px keyboard layout are handled
  by the same rule, with no width constant anywhere in the stylesheet.
- **Centring on the segment start is the position the chord marks.** For the
  one-chord-per-syllable case that motivated the issue the segment start and
  the syllable's centre differ by half a character (9px for a kana). For a long
  segment (`[C]antidisestablishmentarianism`) the diagram stays over the note
  the chord is attached to instead of drifting into the middle of the word.
- **One gutter constant, exposed as a custom property.** The overhang is half
  the diagram's width, which the stylesheet cannot compute; the default covers
  the widest diagram this package renders (the keyboard's 136px) so nothing is
  clipped out of the box, and a host that only renders fretted diagrams can
  tighten it to `2rem` without touching the package.
- **The gutter applies to the song root, not to each line.** An earlier
  version of this change put the `padding-left` on `.line--inline-diagrams`
  directly. That class is per-line, so it shifted every chord-bearing (and
  chord-less) lyric line right by the gutter while leaving `.section-label`
  headings and `{comment}` paragraphs — siblings of `.line` under the same
  `.song`, never carrying the modifier — flush at the original margin,
  producing a jagged left edge on any song that mixes lyric lines with
  section headers or comments. Moving the `padding-left` to a
  `song--diagrams-inline` modifier on the `.song` root shifts every body
  element by the same amount, so the whole document keeps one consistent
  left margin.
- **A React-surface concern only.** Per ADR-0027 inline-diagram *placement* is
  a React-JSX-walker feature; the three Rust renderers do not emit inline
  diagrams, so this carries no renderer-parity obligation. The compact-diagram
  geometry in `chordsketch_chordpro::chord_diagram` is untouched.

## Consequences

- Existing `{diagrams: inline}` documents render with every diagram half a
  diagram-width further left, and the whole song carries a leading gutter so
  every line, section label, and comment stays aligned. The ChordPro source,
  the DOM, and `section` / `hover` output are unchanged.
- jsdom has no layout engine, so both halves of the decision are pinned by a
  real-browser smoke in
  `packages/playground/tests-e2e/diagrams-inline-hover.spec.ts`: the diagram's
  measured centre against its lyric segment's left edge (the pre-ADR layout
  measures 31.5px off; #2742's `align-items: center` measures 44px off), the
  lyric segments staying flush with each other (the property #2742 broke), the
  leading diagram staying inside the preview pane, and a `.comment` staying
  aligned with a chord-bearing `.line` (the property a line-scoped gutter
  broke).
- When the Rust renderers eventually gain inline-diagram placement (the
  ADR-0027 follow-up) they inherit this decision: the diagram is centred on the
  position the chord marks, the chord name stays left-aligned.

## Alternatives considered

- **`align-items: center` on the chord-block (#2742).** Rejected — reverted in
  #2743. It moves the lyric as well as the diagram; see Context.
- **Take the diagram out of the width calculation (`width: 0` on the cell) and
  centre it on the segment's midpoint.** This is the only way CSS can centre on
  the *midpoint* without moving the lyric, and it was measured: the block then
  shrinks to the lyric, so diagrams overlap by 45px for one-kana segments and
  the four keyboard diagrams of a four-kana line merge into a single strip.
  Restoring the slot needs a trailing reserve as a length constant — which does
  not scale from the 63px fretted layouts to the 136px keyboard one, and which
  lengthens every Latin line by that constant per chord. Rejected for a
  self-scaling rule that changes no widths at all.
- **Measure the lyric and the diagram at runtime and publish the exact shift as
  a custom property.** Rejected as disproportionate: it makes a cosmetic layout
  depend on JS measurement, adds an SSR / font-loading / resize failure surface,
  and buys half a character of precision.
- **Leave the diagram left-aligned.** Rejected: it is what the issue reported.

## References

- [ADR-0027](0027-inline-hover-compact-chord-diagrams.md) — the inline / hover
  compact-diagram mode this refines
- [ADR-0017](0017-react-renders-from-ast.md) — the React JSX walker as a
  renderer sister site
- `packages/react/src/styles.css` — the `.line--inline-diagrams
  .chord-block-inline-diagram` centring rule and the `.song--diagrams-inline`
  gutter rule
- `packages/playground/tests-e2e/diagrams-inline-hover.spec.ts` — the
  real-browser smoke
- #2741 — implementing issue; #2742 / #2743 — the reverted first attempt
- `docs/adr/README.md` — ADR index
