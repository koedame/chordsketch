# 0030. Chord diagrams label the full visible fret range by default

- **Status**: Accepted — labelling position superseded by
  [ADR-0031](0031-chord-diagram-fret-numbers-at-cell-centres.md) (fret numbers
  now sit at fret-cell centres / press positions, not on fret lines; the rest
  of this ADR still stands)
- **Date**: 2026-06-15

## Context

ChordSketch renders fretted chord diagrams (the end-of-song `{diagrams}` grid
and `{define}` shapes) as SVG (`crates/chordpro/src/chord_diagram.rs`, the
single source for the CLI HTML output, the wasm bundle, the React
`<ChordDiagram>`, and the VS Code / desktop previews) and, independently, as
vector graphics in the PDF renderer (`crates/render-pdf`).

Before this decision a diagram labelled **only its base fret**: a single
integer drawn beside the grid when `base_fret > 1`, and nothing at all at the
open position. Conventional guitar chord charts instead label **every fret
line in the visible window** — `0 1 2 3 …`, where `0` marks the nut / open
position — so a reader can immediately tell which frets the shape spans
without counting cells. The canonical reference is the horizontal
Japanese-tablature layout, which prints the `0 1 2 3` strip directly beneath
the fretboard.

The two surfaces also disagreed on the legacy label's spelling: the SVG
renderer drew a bare integer (`7`) while the PDF renderer drew `7fr`. Any
fix to the labelling had to reconcile that drift as well.

## Decision

Draw a **fret-number axis** on every regular-size fretted diagram: one label
per fret line across the full visible window, showing the absolute fret
number `base_fret - 1 + j` for fret line `j ∈ 0..=frets_shown`. Fret line `0`
is the nut, so an open-position diagram reads `0 1 2 3 …` and a window that
starts higher up reads e.g. `6 7 8 9 10 11` for `base_fret = 7`.

- **Default-on, no opt-out knob.** The axis is part of the standard diagram,
  not gated behind a directive or config value. The `0 1 2 3` strip is what
  the requested reference shows, and the ChordPro spec defines no
  diagram-labelling knob to hang an opt-out on. A `fret-number` CSS class is
  emitted on each SVG label so a consumer that wants to hide or restyle the
  axis can do so in CSS without an API change.
- **The axis subsumes the legacy single base-fret label** at the regular
  size. The standalone label is no longer drawn there because the axis
  already labels the first visible fret; keeping both would duplicate it.
- **Compact diagrams keep the legacy single label.** The compact layout
  (`{diagrams: inline}` / `{diagrams: hover}`, ADR-0027) sits directly above
  a lyric line where a full axis would add clutter and height, so it retains
  the minimal single base-fret label and does **not** draw the axis.
- **Layout stays inside the existing margins / padding.** The axis is placed
  in the left gutter (vertical) or the existing bottom padding (horizontal),
  so the SVG and PDF bounding boxes are unchanged. This keeps page flow and
  the horizontal "wider than tall" aspect invariant intact.
- **Parity across surfaces.** The SVG change reaches HTML, wasm, and React
  through the shared renderer; the PDF renderer gains the identical axis in
  both orientations, which also retires the `7fr` vs `7` drift in favour of
  the bare-integer spelling everywhere.

## Rationale

The request is literally "display all fret numbers for the range the diagram
shows," and the reference image renders the axis unconditionally. Gating it
behind a directive would mean the default output still does not match the
reference, defeating the purpose; an opt-out belongs in CSS (cheap, no new
parse surface) rather than a new spec-adjacent directive value (which would
need parsing, validation, and propagation across every renderer and binding).

Labelling fret **lines** (not cells) is what makes the open position read
`0` at the nut, matching the reference exactly. The same uniform rule
(`base_fret - 1 + j`) then labels the fret wires a shifted window spans, which
is internally consistent and needs no special-casing on `base_fret`.

## Consequences

- Every diagram consumer's default output changes: the CLI HTML, PDF, wasm,
  React `<ChordDiagram>`, VS Code preview, and desktop app now show the axis.
  Diagram golden snapshots (HTML + PDF) were regenerated in the same change.
- The bounding box is unchanged, so downstream layout that depends on diagram
  dimensions is unaffected.
- A consumer that preferred the old minimal labelling can hide the axis with
  `.chord-diagram .fret-number { display: none }`; there is no Rust-level
  opt-out, which is an accepted limitation until one is requested.
- The ASCII text renderer (`render_ascii`) is intentionally **not** changed:
  its single-line-per-chord format already prints absolute fret numbers per
  string and carries no fret grid to hang an axis on. This is recorded as a
  deliberate deferral, not an omission.

## Alternatives considered

- **Config / directive opt-in (`{diagrams: fretnumbers}` or a config key).**
  Rejected: it leaves the default output not matching the reference, and adds
  parse + validation + propagation surface across every renderer and binding
  for a facet the spec does not define. CSS hiding covers the opt-out need.
- **Label cells instead of fret lines.** Rejected: cell labelling cannot show
  `0` at the nut, so it would not match the reference for the common
  open-position case.
- **Only show the axis for the open position (`base_fret == 1`).** Rejected:
  positional diagrams benefit most from knowing which frets the window spans,
  and a uniform rule is simpler than branching on `base_fret`.
- **A CSS `transform: scale()` shrink for compact rather than suppressing the
  axis.** Rejected for the same legibility reason ADR-0027 already records.

## References

- Issue #2602 — show fret-number labels for the full visible range.
- ADR-0026 — horizontal chord-diagram default string order (reader-view).
- ADR-0027 — inline / hover compact chord diagrams (the compact layout that
  keeps the legacy single label).
- `.claude/rules/renderer-parity.md`, `.claude/rules/fix-propagation.md` —
  the sister-site obligations this change follows across SVG / HTML / PDF /
  React.
