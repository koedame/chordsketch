# 0031. Chord-diagram fret numbers label fret-cell centres (press positions)

- **Status**: Accepted — compact carve-out superseded by
  [ADR-0032](0032-compact-diagrams-show-fret-number-axis.md) (compact now draws
  the press-position axis); the rest still stands
- **Date**: 2026-06-15
- **Supersedes**: the labelling-position sub-decision of
  [ADR-0030](0030-chord-diagram-fret-number-axis.md) (the rest of ADR-0030 —
  that diagrams show a fret-number axis by default, the compact carve-out, the
  ASCII deferral, CSS opt-out — still stands).

## Context

[ADR-0030](0030-chord-diagram-fret-number-axis.md) added a fret-number axis
that labels each **fret line** (wire) with `base_fret - 1 + j` for line
`j ∈ 0..=frets_shown`, so an open-position diagram read `0 1 2 3 …` with `0`
at the nut. ADR-0030 explicitly considered and rejected labelling fret *cells*,
on the grounds that cell labelling cannot place a `0` at the nut.

In use, the line-anchored numbers read as labelling the wires rather than the
positions a finger presses. The clearer convention — and the one requested — is
to put each number in the **centre of the fret cell** it names, i.e. at the
press position, with no number for the open/nut.

## Decision

Label each visible fret **cell centre** with the absolute fret number a finger
presses there: `base_fret - 1 + j` for cell `j ∈ 1..=frets_shown`, centred on
the cell along the fret axis.

- Open position (`base_fret 1`, 5 visible frets): `1 2 3 4 5`, one centred in
  each cell. There is **no `0`** — the open/nut is not a press position and is
  already shown by the nut line and the open-string `○` markers.
- High position (`base_fret 7`): `7 8 9 10 11`. There is no `6` (the wire
  behind the window is not a press position).
- Exactly `frets_shown` labels (one per cell), down from `frets_shown + 1`.
- Everything else from ADR-0030 is unchanged: regular-size default-on, the axis
  subsumes the legacy single base-fret label, compact keeps the minimal label,
  bounding boxes unchanged, both orientations, SVG (→ HTML / wasm / React) and
  PDF parity, ASCII still deferred, CSS opt-out via the `fret-number` class.

## Rationale

A chord diagram answers "where do I put my fingers?", so the number belongs on
the press position, not the wire between positions. Centring in the cell makes
the number line up with the dot that would sit there, which is what a reader
expects. ADR-0030's objection — "cell labelling cannot show 0 at the nut" — is
moot once we accept that the open/nut should carry no number at all (it is
already unambiguous from the nut line + `○` markers).

## Consequences

- Default diagram output changes again for every consumer (CLI HTML, PDF, wasm,
  React, VS Code/desktop previews); diagram golden snapshots (HTML + PDF) were
  regenerated in the same change.
- One fewer label per diagram; the labels move to cell centres. Bounding boxes
  are unchanged, so layout is unaffected.
- The `0`-at-the-nut reading from ADR-0030 is gone. Anyone who preferred it can
  still restyle/hide the axis via the `fret-number` CSS class, but the
  line-anchored variant is no longer produced.

## Alternatives considered

- **Keep ADR-0030's line labelling.** Rejected on direct preference: the wire
  numbers read less clearly than press-position numbers for a fingering aid.
- **Label cells but still add a `0` at the nut column.** Rejected: `0` is not a
  press position; mixing a nut label with cell labels reintroduces the
  line/cell ambiguity this decision removes.

## References

- Issue #2616 — place fret numbers at cell centres (press positions).
- [ADR-0030](0030-chord-diagram-fret-number-axis.md) — the superseded
  labelling-position decision (rest still in force).
