# 0026. Horizontal chord diagram default string order

- **Status**: Accepted
- **Date**: 2026-05-29

## Context

Issue [#2572](https://github.com/koedame/chordsketch/issues/2572) added
horizontal (left-nut) fretted-instrument chord diagrams as an opt-in
orientation, alongside the existing vertical (top-nut) layout. The
horizontal mode is the dominant convention in Japanese tablature
publications (Yamaha / Doremi / Rittor Music chord books, J-POP scores),
and the project ships it so sheet music targeting that audience does
not need a localisation hack at the consumer layer.

Horizontal mode has to pick a string-row ordering, and Japanese
publishers do not agree on a single convention:

- **Player-view**: low pitch (6th string for guitar) on top, mirroring
  what a right-handed player sees looking down at the instrument with
  the headstock on their left. This is the layout the issue's design
  proposal initially recommended.
- **Reader-view**: high pitch (1st string for guitar) on top, matching
  the standard six-line tablature stave that places the 1st string at
  the top line. Tablature is the dominant notation surface in mainstream
  Japanese guitar method books and TAB-driven chord references.

Both layouts appear in widely-circulated publications. A single
default has to be chosen for `<ChordDiagram orientation="horizontal" />`
to be useful out of the box, and that choice is the project-wide
convention publishers will see unless they explicitly opt out.

## Decision

The default `HorizontalStringOrder` for horizontal-orientation diagrams
is **`ReaderView`** — high pitch on top.

This applies symmetrically across every surface that renders
fretted-instrument chord diagrams:

- The Rust SVG renderer (`crates/chordpro/src/chord_diagram.rs::render_svg_with_orientation`).
- The Rust PDF renderer (`crates/render-pdf/src/lib.rs::render_chord_diagram_pdf_horizontal`).
- The wasm / NAPI / FFI binding exports (`chord_diagram_svg_with_orientation`,
  `chord_diagram_svg_with_defines_orientation`).
- The React `<ChordDiagram>` component and the `chordpro-jsx` JSX walker.

Publishers wanting player-view set the config key
`diagrams.horizontal_string_order = "player"` (or pass
`horizontalStringOrder="player"` on the React component / walker
option). The configuration surface stays symmetric — neither layout is
hidden, only the unconfigured default is pinned.

The `HorizontalStringOrder` enum is `#[non_exhaustive]` from day one so
future row-order conventions (e.g. a lefty horizontal layout, or
notation-specific orderings introduced by future publications) can be
added without an API break.

## Rationale

Reader-view wins on the consistency criterion that matters most for
chord-diagram readability: the **six-line tab stave**.

ChordSketch's primary readership reaches chord diagrams in tab-driven
contexts (TAB scores, chord books with tab snippets, the
`{start_of_tab}` directive elsewhere in the same file). The standard
six-line tab stave places the 1st string at the top line and the 6th
string at the bottom — a fixed convention published every TAB-bearing
guitar method book in mainstream circulation reinforces. Aligning the
horizontal chord diagram with that ordering means a reader does not
flip their string-to-row mapping between the inline diagram and the
TAB they consult three lines down on the same page.

The player-view ordering is internally consistent too — it matches what
a player physically sees — but the "what the player sees" frame fights
the tab convention whenever the same page also carries TAB notation,
which is the dominant context this renderer ships into. The trade-off
the issue's design proposal raised acknowledges this tension; the
decision lands on consistency-with-tab as the higher-value invariant.

The chord-book corpus that informed this decision is not single-author
or single-publisher. Reader-view appears (high string on top) in
Yamaha's series of guitar chord references and Doremi Music
Publishing's TAB-format method books (a representative sample includes
their popular *J-POP コード進行ブック* line and the *はじめてのギター
TAB譜* series). Player-view appears in some Rittor Music titles and a
subset of band-score editions, particularly older catalogue entries
predating the tab-stave normalisation that became standard from the
late-1990s onward.

A formal corpus survey was out of scope for this decision; the criterion
the decision turned on was the tab-stave alignment, not a head-count of
published editions. Future evidence that flips the publisher-share view
would be a watch signal to revisit (see "References" below) but does
not by itself reverse the decision — the tab-alignment rationale would
have to weaken too.

## Consequences

Positive:

- A reader who knows the tab stave can read horizontal diagrams without
  a mental flip. The string-to-row mapping is fixed across the diagram
  and any TAB notation the same page carries.
- The default fits the publishing context the horizontal mode was
  introduced for, so `diagrams.horizontal_string_order` is a setting
  most consumers never need to touch.
- The `#[non_exhaustive]` marker on `HorizontalStringOrder` preserves
  the option to add a `HorizontalLefty` (or other) variant later
  without bumping the public API surface — left-handed-player support
  has no API blocker as a result.

Negative / mitigations:

- Publishers targeting the player-view convention have to set
  `diagrams.horizontal_string_order = "player"` explicitly. Mitigation:
  the config key is documented under `diagrams.*` alongside `frets`
  and `orientation`; a one-line setting is a low cost.
- A reader habituated to the player-view layout in a specific catalogue
  may initially read a reader-view diagram as flipped. Mitigation: the
  per-string open / muted markers (`X` for muted, `O` for open) at the
  left of the nut make the diagram self-orienting even before the
  reader internalises the stave convention.
- Choosing a default puts the project in the position of disagreeing
  with some published editions. Mitigation: ADR-0026 records the
  decision in writing so a future contributor proposing the opposite
  default sees the rationale on the table rather than relitigating it
  from scratch.

## Alternatives considered

1. **Player-view default (low pitch on top)**. Rejected because it
   conflicts with the six-line tab stave a reader most often consults
   alongside the chord diagram on the same page. The
   "what the player sees" frame is internally consistent but
   tab-misaligned in the dominant context, and tab-alignment is the
   stronger invariant for this renderer's readership.

2. **Required configuration — no default**. Rejected because it breaks
   the out-of-the-box ergonomic of
   `<ChordDiagram orientation="horizontal" />`, adds noise to every
   horizontal-mode rendering call across every binding surface, and
   forces every consumer (including the most common case — a publisher
   picking the project default) to ship a configuration line. The
   ergonomic cost is high; the benefit (forced explicit choice) is
   purchasable with a one-line clarification in the docstring, which
   ADR-0026 also writes down.

3. **Match the issue body's proposal verbatim (player-view)**. Rejected
   per the rationale above — the issue body was useful as a design
   brief but the tab-alignment argument did not surface there, and the
   decision changed once it did.

## References

- Issue [#2572](https://github.com/koedame/chordsketch/issues/2572) —
  the feature request that introduced horizontal orientation.
- [`crates/chordpro/src/chord_diagram.rs`](../../crates/chordpro/src/chord_diagram.rs) —
  the `HorizontalStringOrder` enum and the `render_svg_with_orientation`
  function this ADR governs.
- [`.claude/rules/fix-propagation.md`](../../.claude/rules/fix-propagation.md) —
  the sister-site discipline this decision applies symmetrically across
  every binding and renderer.
- **Watch signal** — a published survey of post-2020 Japanese chord
  book editions establishing a clear player-view majority would be
  cause to revisit. The tab-alignment rationale would also have to be
  re-examined (e.g. if the dominant notation surface stops being the
  six-line tab stave for some catalogue subset).
