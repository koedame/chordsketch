# 0027. Inline / hover chord diagrams use a dedicated compact layout

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

ChordSketch renders chord names above the lyrics (the `[C]word` inline-chord
syntax) and, separately, an end-of-song grid of full-size chord diagrams that
the `{diagrams}` directive turns on. Users reading a sheet to learn the shapes
have to look away from the lyric line, down to the grid, and back.

Two new ways to surface the diagrams next to the chords they belong to were
requested:

- each chord name above a lyric is **replaced** by its diagram; and
- the chord name stays as text and the diagram appears on **hover / focus**.

Both place a diagram where a single chord name used to sit. The existing
diagram SVG is laid out for the end-of-song grid: at the ~120×160 px it
renders, dropping one above every chord would blow up line height and crowd
the page. Simply shrinking that SVG with a CSS `transform: scale()` is not
acceptable either — scaling shrinks the chord-name title and the
finger / open / muted glyphs together with the geometry, and below roughly
0.7× the text stops being legible, which defeats the point (the diagram has to
be readable at a glance, inline, mid-lyric).

The standard ChordPro `{diagrams}` directive only defines visibility
(`on` / `off`), an instrument (`guitar` / `ukulele` / `piano`), and a section
position (`top` / `bottom` / …). There is no spec value for "show the diagrams
inline with the chords." So surfacing this needs a chordsketch-only extension,
and a way to render a physically smaller diagram that stays legible.

## Decision

1. Add two **chordsketch-only values** to the existing `{diagrams}` directive:
   `inline` and `hover`. They are a new orthogonal *mode* facet of the
   directive value, resolved at render time alongside the existing
   visibility / instrument / position facets — last-wins per facet — so
   `{diagrams: inline}` and `{diagrams: guitar}` each apply to their own
   facet and compose. The default mode stays `section` (the end-of-song grid),
   so existing songs render unchanged. `inline` / `hover` imply visible.

2. Add a dedicated **compact diagram layout** (`DiagramSize::Compact`) to the
   chord-diagram generator, rather than CSS-scaling the regular SVG. The
   compact layout shrinks the grid *geometry* substantially (≈0.55×) while
   holding the glyph fonts near a legibility floor (chord-name title ≥ 11 px,
   finger numbers ≥ 7 px) and keeping stroke widths and dot radii
   proportionally large. The chord-name title is always rendered, so even in
   `inline` mode — where the diagram replaces the text name — the name is
   never lost.

Both the value space and the compact layout live in the foundation crate
(`chordsketch-chordpro::chord_diagram`) and are exposed through the existing
wasm chord-diagram surface, so every consumer reads one source of truth.

## Rationale

- **A value, not a new directive.** `inline` / `hover` ride on `{diagrams}` as
  plain values, so no new `DirectiveKind`, no AST/JSON schema change, and no
  new syntax — the parser already preserves the value and the renderers resolve
  it. This mirrors how `guitar` / `top` are handled today and keeps the
  round-trip and the directive catalog trivial.
- **A separate layout, not a CSS scale.** The whole requirement is "smaller but
  still legible." Only a re-laid-out variant can shrink geometry on a different
  curve from text; a `transform: scale()` cannot. Authoring it in Rust (not in
  a React/CSS layer) keeps it on the same generator every renderer uses, so the
  compact diagram cannot drift from the regular one
  (`.claude/rules/playground-is-a-sample.md`).
- **A `DiagramSize` knob mirrors the `Orientation` precedent.** ADR-0026 added
  orientation as a `#[non_exhaustive]` enum plus a `render_svg_with_*` entry
  point and a string resolver shared across renderers and bindings. `DiagramSize`
  follows the same shape (`render_svg_with_options`, `resolve_diagrams_mode`,
  `try_parse_diagrams_mode`), so the two knobs compose (compact × horizontal)
  and the codebase has one consistent pattern for diagram render options.
- **Mode as an orthogonal facet** keeps the lenient, last-wins `{diagrams}`
  parsing the renderers already implement: a non-mode value (instrument /
  position) returns `None` from the mode resolver and is left to the other
  facets, so adding the facet cannot regress existing `{diagrams}` lines.

## Consequences

- `inline` / `hover` are non-standard: a `.cho` file using them renders the grid
  (the default mode) under any other ChordPro implementation, not inline. This
  is the accepted cost of a useful extension; the file still parses and renders
  everywhere because the value is just ignored as an unknown mode elsewhere.
- The compact constants (cell sizes, font floors) are tuned by eye against the
  inline rendering, not derived from a formula. They are pinned by unit tests
  (compact carries its marker class, stays smaller than regular on both axes,
  and keeps the 11 px / 7 px font floors) so a later tweak that scales the text
  below the floor fails CI.
- A new render option threads through the wasm chord-diagram surface. The napi /
  ffi bindings expose the same chord-diagram functions and will gain the compact
  variant as a fix-propagation follow-up (`.claude/rules/fix-propagation.md`
  §Bindings); web (wasm) is the only surface that needs it now.
- Per [ADR-0017](0017-react-renders-from-ast.md) /
  `.claude/rules/renderer-parity.md`, the actual inline/hover *placement* is
  being implemented on the React JSX walker first; the three Rust renderers
  (text / HTML / PDF) are owed the same `resolve_diagrams_mode` +
  compact-diagram handling as tracked follow-up (PDF/print has no hover, so
  `hover` degrades to `inline` or `section` there — to be documented when those
  renderers land it).

## Alternatives considered

- **CSS `transform: scale()` on the regular SVG.** Rejected: shrinks text into
  illegibility along with the geometry, which is exactly the failure the user
  called out. A separate layout is the only way to keep the title and glyphs
  readable at inline size.
- **A new directive (e.g. `{inline_diagrams}`).** Rejected: a new directive
  needs a new `DirectiveKind`, AST/JSON serialisation, catalog entry, and parser
  arm, for no gain over a value on the directive that already controls diagrams.
- **A TypeScript/React-only compact renderer.** Rejected: a second diagram
  implementation would drift from the Rust generator the other renderers use,
  violating `playground-is-a-sample.md`; and it could never reach the Rust
  renderers that owe parity.
- **Encode the mode in the AST (a `DiagramsMode` field on the directive).**
  Rejected: the value already lives on `Directive::value`; resolving the mode at
  render time (like instrument / position / orientation) avoids an AST change and
  keeps round-trip output byte-identical.

## References

- [ADR-0026](0026-horizontal-chord-diagram-default-string-order.md) — the
  `Orientation` knob this mirrors
- [ADR-0017](0017-react-renders-from-ast.md) — React JSX walker as a renderer
  sister site
- `.claude/rules/renderer-parity.md` — four-renderer parity obligation
- `.claude/rules/playground-is-a-sample.md` — why the layout lives in the library
- `.claude/rules/fix-propagation.md` — the binding sister-group follow-up
- `crates/chordpro/src/chord_diagram.rs` — `DiagramSize`, `render_svg_with_options`,
  `render_keyboard_svg_with_size`, `DiagramsMode`, `resolve_diagrams_mode`
- `docs/adr/README.md` — ADR index
