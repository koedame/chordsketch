# Playground Is A Sample

The playground at `packages/playground/` is **a sample consumer of
the chordsketch libraries**, not a place to grow library
functionality.

## Rule

When the playground needs behaviour the underlying libraries do
not yet provide, the fix MUST land in the library, not in the
playground. This applies symmetrically to:

- **ChordPro pipeline**: `chordsketch-chordpro` (parser / AST),
  `chordsketch-render-html`, `chordsketch-render-pdf`,
  `chordsketch-render-text`, `@chordsketch/react`.
- **iReal Pro pipeline**: `chordsketch-ireal` (parser /
  serializer / AST), `chordsketch-render-ireal`,
  `@chordsketch/ui-irealb-editor`.
- Any **shared infrastructure**: `@chordsketch/wasm`,
  `@chordsketch/ui-web`.

## Why

Logic that lives in the playground:

1. **Doesn't reach the other consumers.** The CLI, VS Code
   extension, desktop app, React component package, FFI / NAPI /
   wasm bindings — none of them benefit from a TypeScript helper
   sitting in `packages/playground/src/`. A correctness or
   ergonomics gap in one consumer becomes a gap in all the rest.
2. **Fragments the source of truth.** A second translation /
   normalisation / formatting layer in the playground silently
   competes with the one inside the library. Drift between the
   two is a regression class with no automated tests.
3. **Rots quickly.** The playground evolves on the design-system
   timetable; library logic evolves on the renderer / parser
   timetable. Logic glued into the playground gets surprised by
   library changes that everyone else handles transparently.

## Required practice

Whenever a playground change is about to introduce
business / formatting / parsing / rendering logic:

1. **Stop and locate the right library.** The function probably
   belongs in `chordsketch-chordpro::*`, `chordsketch-ireal::*`,
   `chordsketch-render-*::*`, or `@chordsketch/react`'s
   component surface.
2. **Push the logic there**, expose it via the existing wasm /
   public API, and have the playground call it.
3. **Update the library's tests** (golden / unit) so the new
   behaviour is locked in for every consumer.
4. **Refactor the playground** to be a thin wrapper that
   demonstrates the library API rather than supplements it.

If the library cannot host the change without a substantial
refactor, the right answer is still to do that refactor — not
to grow a parallel implementation in the playground.

## Worked example

The iReal Pro parser (`chordsketch-ireal`) emits chord qualities
the structured `ChordQuality` enum can't model as
`Custom("9b7")` / `Custom("^7")` / `Custom("h7")` etc. The SVG
renderer (`chordsketch-render-ireal::chord_typography`) returned
those Custom strings verbatim, so the rendered chart showed
`B♭^9` instead of `B♭Δ9`.

The wrong fix was to add `translateCustomQuality()` in the
playground React layer. The right fix — and the one the rule
prescribes — was to teach
`chord_typography::quality_extension` to translate the iReal
Pro URL shorthand (`^→Δ`, `h→ø`, `o→°`, `-→−`, `b→♭`, `#→♯`)
inside the renderer crate. After that, every consumer of
`renderIrealSvg` (CLI, VS Code preview, desktop, the
playground) renders the chord correctly without anyone
duplicating the translation table.

## When the rule does not apply

The playground may add **chrome** that is genuinely playground-
specific without library changes:

- Sample picker UI, sample data lists.
- Toolbar layout, status footer, visual styling that is part of
  the playground's UI shell rather than the library output.
- Dev tooling such as `react-grab` integration.

These are consumer-side concerns and stay in the playground. The
boundary is straightforward: anything that *could* belong to the
library belongs to the library; anything purely about the
playground's own framing stays in the playground.
