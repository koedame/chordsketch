# 0032. Inline / hover (compact) diagrams also show the fret-number axis

- **Status**: Accepted
- **Date**: 2026-06-15
- **Supersedes**: the compact carve-out of
  [ADR-0030](0030-chord-diagram-fret-number-axis.md) (reaffirmed by
  [ADR-0031](0031-chord-diagram-fret-numbers-at-cell-centres.md)) — compact
  diagrams now draw the press-position axis instead of the legacy single
  base-fret label. The rest of both ADRs still stands.

## Context

[ADR-0030](0030-chord-diagram-fret-number-axis.md) added the fret-number axis
to regular-size diagrams but carved out the compact size
(`{diagrams: inline}` / `{diagrams: hover}`, ADR-0027), keeping only the
legacy single base-fret label there on the grounds that a full axis "would add
clutter and height" above a lyric line. [ADR-0031](0031-chord-diagram-fret-numbers-at-cell-centres.md)
moved the regular axis to fret-cell centres (press positions) but left the
compact carve-out in place.

In use, the inline / hover diagrams are exactly where a learner reads the
shapes while following the lyrics, so omitting the fret numbers there is the
opposite of helpful. The fret numbers should appear on inline / hover diagrams
too, with the same press-position semantics as the regular size.

## Decision

The compact size draws the same per-cell press-position fret-number axis as
the regular size (`base_fret - 1 + j` centred in cell `j ∈ 1..=frets_shown`;
no nut `0`). It no longer draws the legacy single base-fret label.

To keep the inline layout tight, the compact axis uses a dedicated smaller
font and gutter gap rather than the regular metrics:

- `fret_label_font` = 6 (vs the regular 10 / compact `label_font` 8), so the
  numbers fit the compact diagram's narrow left gutter and bottom padding.
- The compact left gutter widens from 9 to 11 SVG-px so a 2-digit label
  (e.g. a base-fret-7 window's `10` / `11`) clears the left edge of the
  viewBox.

These are the only compact-geometry changes; the diagram grows by ~4 px in
the affected dimension and otherwise keeps ADR-0027's compact proportions.

## Rationale

The inline / hover modes exist to put the shape next to the chord it belongs
to; the fret numbers are part of "the shape" for anyone learning where to put
their fingers. A separate smaller axis font preserves ADR-0027's core reason
for a dedicated compact layout (legibility without a CSS `scale()` that would
shrink every glyph together) while still fitting the numbers in.

## Consequences

- Inline / hover diagrams (React `<ChordDiagram compact>`, the playground's
  inline / hover modes) now show press-position fret numbers, inheriting the
  change through the shared wasm SVG renderer.
- The compact diagram's bounding box grows by ~4 px in the gutter / pad
  direction; downstream inline layout absorbs this. No golden snapshots use
  the compact size (it is a screen-only mode driven via wasm), so none change.
- The PDF renderer has no compact size and is unaffected.
- The `fret-number` CSS class still lets a consumer hide / restyle the axis,
  including on compact diagrams, for anyone who preferred the bare layout.

## Alternatives considered

- **Keep the compact carve-out.** Rejected on direct request: the inline /
  hover modes are the most useful place to show the numbers.
- **Reuse the regular axis metrics for compact.** Rejected: the regular font
  (10) overflows the compact gutter and would force a much larger inline
  diagram, undercutting ADR-0027's reason for a separate compact layout. A
  dedicated smaller font fits without that cost.

## References

- Issue #2618 — show fret numbers on inline / hover (compact) diagrams.
- [ADR-0027](0027-inline-hover-compact-chord-diagrams.md) — the compact layout.
- [ADR-0030](0030-chord-diagram-fret-number-axis.md),
  [ADR-0031](0031-chord-diagram-fret-numbers-at-cell-centres.md) — the
  fret-number axis and its move to cell centres; this ADR extends both to the
  compact size.
