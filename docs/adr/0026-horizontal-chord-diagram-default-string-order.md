# 0026. Horizontal chord diagram is reader-view only

- **Status**: Accepted
- **Date**: 2026-05-30

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

Both layouts appear in widely-circulated publications. An initial
iteration of #2572 shipped reader-view as a default and exposed
player-view via a `diagrams.horizontal_string_order = "player"` config
key plus a `horizontalStringOrder` prop on `<ChordDiagram>` and a
toolbar dropdown in the React `<PreviewToolbar>`. The maintainer then
chose to remove player-view entirely rather than ship the escape
hatch — the per-knob complexity (two enum variants, every binding
surface threading the second argument, a toolbar select that only
appears in horizontal mode, an extra prop on three React components,
docs and tests covering both variants) outweighed the value of
supporting both conventions.

## Decision

`Orientation::Horizontal` is a **unit variant** rendered exclusively in
reader-view (high pitch on top). There is no `HorizontalStringOrder`
enum, no `diagrams.horizontal_string_order` config key, no
`horizontalStringOrder` prop, and no string-order toolbar select.

This applies symmetrically across every surface that renders
fretted-instrument chord diagrams:

- The Rust SVG renderer (`crates/chordpro/src/chord_diagram.rs::render_svg_with_orientation`).
- The Rust PDF renderer (`crates/render-pdf/src/lib.rs::render_chord_diagram_pdf_horizontal`).
- The wasm / NAPI / FFI binding exports (`chord_diagram_svg_with_orientation`,
  `chord_diagram_svg_with_defines_orientation`) — each takes a single
  `orientation` string, no companion string-order argument.
- The React `<ChordDiagram>` component, the `chordpro-jsx` JSX walker,
  `<ChordSheet>`, `<RendererPreview>`, and `<PreviewToolbar>` —
  `orientation` is the only diagram-row prop.

The `Orientation` enum stays `#[non_exhaustive]` so future row-order
conventions (e.g. a lefty horizontal layout) can be added without an
API break. A future variant would be a new top-level enum case
(`Orientation::HorizontalLefty`, etc.), not a parameter on the existing
`Horizontal` variant.

## Rationale

Reader-view wins on the consistency criterion that matters most for
chord-diagram readability: the **six-line tab stave**.

ChordSketch's primary readership reaches chord diagrams in tab-driven
contexts (TAB scores, chord books with tab snippets, the
`{start_of_tab}` directive elsewhere in the same file). The standard
six-line tab stave places the 1st string at the top line and the 6th
string at the bottom — a fixed convention every TAB-bearing guitar
method book in mainstream circulation reinforces. Aligning the
horizontal chord diagram with that ordering means a reader does not
flip their string-to-row mapping between the inline diagram and the
TAB they consult three lines down on the same page.

Given that asymmetry, exposing player-view as an opt-in second
variant carries asymmetric costs: it forces every binding ABI
(wasm / NAPI / FFI) to thread a second argument through, every React
component in the chain to accept and forward a second prop, every
test to cover both shapes, and every host (the playground, hosts
embedding `<PreviewToolbar>`) to wire a second toggle. The dominant
context the renderer ships into rewards a single canonical layout,
and a publisher genuinely needing player-view can localise at the
consumer layer (e.g. flip the SVG via CSS `transform: scaleY(-1)`)
without the project shipping a second code path.

The chord-book corpus that informed this decision is not single-author
or single-publisher. Reader-view appears (high string on top) in
Yamaha's series of guitar chord references and Doremi Music
Publishing's TAB-format method books — representative titles include
their *J-POP Chord Progression Book* line ("J-POP Koudo Shinkou
Bukku") and the *First-Time Guitar TAB Score* series ("Hajimete no
Guitar TAB-fu"). Player-view appears in some Rittor Music titles and a
subset of band-score editions, particularly older catalogue entries
predating the tab-stave normalisation that became standard from the
late-1990s onward.

A formal corpus survey was out of scope for this decision; the
criterion the decision turned on was the tab-stave alignment plus
the per-knob complexity cost, not a head-count of published editions.
Future evidence that flips the publisher-share view would be a watch
signal to revisit (see "References" below) but does not by itself
reverse the decision — the tab-alignment rationale would have to
weaken too.

## Consequences

Positive:

- A reader who knows the tab stave can read horizontal diagrams without
  a mental flip. The string-to-row mapping is fixed across the diagram
  and any TAB notation the same page carries.
- The API stays narrow: `Orientation` has two unit variants
  (`Vertical`, `Horizontal`), every binding surface takes a single
  `orientation` argument, and every React surface takes a single
  `orientation` prop. No string-order argument threads through the
  pipeline.
- The toolbar surface is one select, not two. The playground and any
  embedding host pays one knob's worth of UI weight.
- The `#[non_exhaustive]` marker on `Orientation` preserves the option
  to add new variants later — left-handed-player support has no API
  blocker as a result; it would land as a separate top-level variant.

Negative / mitigations:

- Publishers targeting the player-view convention cannot configure
  their way into it from the chordsketch API. Mitigation: consumer-side
  CSS / SVG post-processing (`transform: scaleY(-1)` on the diagram
  group) achieves the same visual result without the project shipping a
  second code path. The escape hatch lives at the rendering boundary
  the consumer already owns.
- An earlier iteration of #2572 shipped the player-view config key and
  prop in pre-merge commits. Removing them is a backward-incompatible
  change for anyone who pinned a pre-merge revision. Mitigation: #2572
  has not shipped in any tagged release, so the affected population is
  the empty set.
- Choosing a default puts the project in the position of disagreeing
  with some published editions. Mitigation: ADR-0026 records the
  decision in writing so a future contributor proposing player-view
  support sees the rationale on the table rather than relitigating it
  from scratch.

## Alternatives considered

1. **Ship both layouts via a `HorizontalStringOrder` knob, reader-view
   default**. Initial implementation shape. Rejected because the
   per-binding API surface area, the toolbar dropdown, and the
   per-component prop chain cost more in long-term maintenance than the
   value of supporting both conventions warrants.

2. **Player-view default (no escape hatch)**. Rejected because it
   conflicts with the six-line tab stave a reader most often consults
   alongside the chord diagram on the same page. The
   "what the player sees" frame is internally consistent but
   tab-misaligned in the dominant context, and tab-alignment is the
   stronger invariant for this renderer's readership.

3. **Required configuration — no default**. Rejected because it breaks
   the out-of-the-box ergonomic of
   `<ChordDiagram orientation="horizontal" />`, adds noise to every
   horizontal-mode rendering call across every binding surface, and
   forces every consumer to ship a configuration line. The ergonomic
   cost is high; the benefit (forced explicit choice) is purchasable
   with a one-line clarification in the docstring, which ADR-0026 also
   writes down.

4. **Match the issue body's proposal verbatim (player-view)**. Rejected
   per the rationale above — the issue body was useful as a design
   brief but the tab-alignment argument did not surface there, and the
   decision changed once it did.

## References

- Issue [#2572](https://github.com/koedame/chordsketch/issues/2572) —
  the feature request that introduced horizontal orientation.
- [`crates/chordpro/src/chord_diagram.rs`](../../crates/chordpro/src/chord_diagram.rs) —
  the `Orientation` enum and the `render_svg_with_orientation`
  function this ADR governs.
- This decision applies symmetrically across every binding (wasm /
  NAPI / FFI) and renderer (HTML / PDF / React JSX walker) — the
  orientation resolution lives in one helper (`resolve_orientation` in
  the crate above) so it cannot drift between surfaces.
- **Watch signal** — a published survey of post-2020 Japanese chord
  book editions establishing a clear player-view majority would be
  cause to revisit. The tab-alignment rationale would also have to be
  re-examined (e.g. if the dominant notation surface stops being the
  six-line tab stave for some catalogue subset). A subsequent ADR
  would re-add a `HorizontalLefty` (or similar) variant rather than
  reintroduce the per-knob string-order argument.
