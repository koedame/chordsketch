# 0039. Inline chord diagrams are centered over their lyric position

- **Status**: Accepted
- **Date**: 2026-06-27

## Context

[ADR-0027](0027-inline-hover-compact-chord-diagrams.md) added a `{diagrams:
inline}` mode that replaces each chord name above a lyric with a compact chord
diagram. The placement is implemented in the React JSX walker
(`@chordsketch/react`): each `.chord-block` is a vertical flex column stacking
the diagram (or chord name) above its lyric segment, with `align-items:
flex-start` so the column's children align to the lyric's left edge.

That left alignment is the right default for a chord **name** — a short text
token whose left edge naturally marks the position of the note in the lyric.
But a compact diagram is much wider than the syllable it sits over (≈73 px vs a
one- or two-character syllable). Left-aligning the diagram's edge to the
syllable therefore leaves the diagram hanging off to the right of the note it
belongs to, so the diagram no longer reads as belonging to that syllable.

The request was to align the diagram's **center** to the lyric position
instead.

## Decision

In `inline` diagram mode, center each chord-block's children on the cross axis
(`align-items: center`) instead of left-aligning them. Because the diagram is
the widest child of the flex column, centering keeps the diagram spanning the
block's full width — its left edge never overflows the line start — while the
narrower `.lyrics` child is the element that recenters beneath the diagram. The
net visual effect is the diagram centered over its syllable.

The change is a single CSS rule scoped to `.line--inline-diagrams .chord-block`
in `packages/react/src/styles.css`. The `.line--inline-diagrams` class is
emitted by the walker only when `diagrams.mode === 'inline'`, so:

- chord-**name** (`section`) mode keeps `align-items: flex-start` (left edge
  marks the position), and
- `hover` mode keeps the chord name as text and is likewise unaffected.

It pairs with the existing `.line--inline-diagrams { align-items: flex-end }`
rule (ADR-0027) that bottom-aligns the blocks on the shared lyric baseline; the
two rules act on orthogonal axes (the line is a row, each block is a column).

## Rationale

- **Centering matches how a wide glyph is placed over a beat.** A wide diagram
  centered over its syllable reads as annotating that syllable; a name's left
  edge already does that job, so the two surfaces deserve different alignment —
  this is a deliberate asymmetry, not an inconsistency.
- **No overflow.** Because the widest child of a shrink-wrapped flex column
  defines the column width and spans it fully, centering moves only the
  narrower `.lyrics` child. The first block on every (possibly wrapped) line
  keeps its diagram's left edge at the line start, so centering introduces no
  left-edge overflow. (Centering the diagram on the syllable's *start point*
  rather than on the whole segment — which would overflow — was considered and
  rejected; see Alternatives.)
- **One CSS rule, scoped to the mode.** The behaviour lives entirely in the
  walker's stylesheet as a mode-scoped selector, so it cannot leak into chord-
  name or hover layouts and needs no AST, JSON, or component change.
- **A React-surface concern only.** Per ADR-0027 the inline-diagram *placement*
  is a React-JSX-walker feature; the three Rust renderers (text / HTML / PDF)
  do not yet emit inline diagrams, so this alignment carries no renderer-parity
  obligation. The shared compact-diagram *geometry* in
  `chordsketch-chordpro::chord_diagram` is untouched.

## Consequences

- The visible inline-diagram layout changes for existing `{diagrams: inline}`
  documents: diagrams that previously hung to the right of their syllable now
  sit centered over it. The ChordPro source is unchanged, and `section` /
  `hover` output is byte-identical.
- jsdom has no layout engine, so the centering is verified in a real browser by
  `packages/playground/tests-e2e/diagrams-inline-hover.spec.ts` (the diagram's
  measured horizontal center matches its lyric's center within tolerance); the
  walker unit test continues to assert only the `.line--inline-diagrams` hook
  is emitted in inline mode and withheld elsewhere.
- When the Rust renderers eventually gain inline-diagram placement (the
  ADR-0027 follow-up), they inherit this alignment decision: the diagram is
  centered over its lyric segment, the chord name is left-aligned.

## Alternatives considered

- **Keep left alignment.** Rejected: it is what motivated the request — a wide
  diagram's left edge at the syllable leaves the diagram visually detached from
  the note.
- **Center the diagram on the syllable's *start point* (first character), even
  if the diagram's left half overflows the line.** Rejected: it requires
  positioning the diagram independently of the flex column (negative margins or
  absolute positioning), reintroduces left-edge overflow at the line start, and
  the simpler "center within the segment" reading is what was confirmed against
  the mock-up.
- **Make alignment configurable (a prop / directive value).** Rejected as
  premature: there is one correct default for inline diagrams and no evidence a
  second mode is wanted; a config knob would expand the directive value space
  (ADR-0027) for no demonstrated need.

## References

- [ADR-0027](0027-inline-hover-compact-chord-diagrams.md) — the inline / hover
  compact-diagram mode this refines
- [ADR-0017](0017-react-renders-from-ast.md) — React JSX walker as a renderer
  sister site (and why the Rust renderers owe inline placement later)
- `packages/react/src/styles.css` — the `.line--inline-diagrams .chord-block`
  rule
- `packages/react/src/chordpro-jsx.tsx` — the walker emits `.line--inline-
  diagrams` in inline mode
- `packages/playground/tests-e2e/diagrams-inline-hover.spec.ts` — the
  real-browser center-alignment smoke
- #2741 — implementing issue
- `docs/adr/README.md` — ADR index
