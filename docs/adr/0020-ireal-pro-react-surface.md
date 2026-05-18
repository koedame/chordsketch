# 0020. iReal Pro React surface is native React, not a wrapper

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

[#2473](https://github.com/koedame/chordsketch/issues/2473) calls for an
iReal Pro embedding surface in `@chordsketch/react` analogous to the
ChordPro surface (`<ChordSheet>` / `<ChordEditor>` / `<Playground>`).
The issue identifies two candidate implementation strategies:

- **(a) Thin React wrapper around `@chordsketch/ui-irealb-editor`.**
  The existing 2.8 KLOC framework-agnostic DOM editor that powers the
  playground (`/irealpro/`) and the desktop app. A wrapper would mount
  this editor's `createIrealbEditor()` factory inside a `useEffect`
  and bridge React props ↔ the `EditorAdapter` contract.
- **(b) Re-implement in idiomatic React.** Build first-class React
  components that consume the wasm bridge (`parseIrealb` /
  `serializeIrealb` / `renderIrealSvg`) directly. `ui-irealb-editor`
  stays the source of truth for the playground and the desktop app
  until they migrate.

The repository has no monorepo workspace protocol set up — each
package builds independently and resolves runtime dependencies
through standard npm semver. `@chordsketch/ui-irealb-editor` is
marked `"private": true` and is not published to npm; this is
deliberate per the architecture footnote in `CLAUDE.md` (and the
non-goal section of #2473 itself: "Publishing `@chordsketch/ui-web`
or `@chordsketch/ui-irealb-editor`. They remain private internal
packages.").

A thin wrapper (a) would therefore need one of:

1. Vendor `ui-irealb-editor`'s source into `@chordsketch/react/src/`
   and keep the two copies in lockstep per
   [`.claude/rules/fix-propagation.md`](../../.claude/rules/fix-propagation.md).
2. Configure tsup / esbuild to alias `@chordsketch/ui-irealb-editor`
   at build time and bundle the source into `dist/`, then declare a
   build-time dependency that does not surface to npm consumers.

Option (1) doubles the surface that fix-propagation audits must cover.
Option (2) makes the published bundle structurally opaque about which
slice of `ui-irealb-editor` it captured.

## Decision

Build a **native React** iReal Pro surface in `@chordsketch/react`
(option (b)), but with a deliberately narrow initial feature set: a
header form covering every field the AST exposes (title / composer /
style / key root + accidental + mode / time numerator + denominator /
tempo / transpose), a chord-bar grid that lists each section's bars
with their chord names, an SVG preview powered by `renderIrealSvg`, a
URL textarea that surfaces and round-trips the underlying `irealb://`
URL, and a transpose control. Full popover-based bar editing,
structural section/bar add/move/delete, keyboard navigation, and
ARIA grid semantics — all features that `@chordsketch/ui-irealb-editor`
already provides — are deferred to a follow-up issue.

The playground (`/irealpro/`) and the desktop app continue to consume
`@chordsketch/ui-irealb-editor` directly; no migration is required as
part of this ADR. When the new React surface reaches feature parity,
the playground and desktop will migrate as a separate decision (a
future ADR will record the deprecation).

## Rationale

- **No npm-publish architecture changes required.** Approach (b)
  does not need monorepo workspace protocols, build-time bundling
  tricks, or duplicated source under a sister-site fix-propagation
  contract.
- **Idiomatic React composability.** A native implementation can
  use React state, refs, and contexts, which means hosts get the
  ordinary React composition story (controlled props, `useMemo` /
  `useCallback` ergonomics, suspense, error boundaries) instead of
  fighting an imperative `EditorAdapter` shape from inside
  `useEffect`.
- **Narrow MVP buys time for the harder UX decisions.** The
  popover-based bar editor in `ui-irealb-editor` represents a
  significant amount of accessibility work
  ([#2364](https://github.com/koedame/chordsketch/issues/2364) +
  [#2368](https://github.com/koedame/chordsketch/issues/2368)) that
  was designed against the DOM API contract. Re-implementing it in
  React idiomatically takes design time; shipping the narrow MVP
  first lets `@chordsketch/react@0.1.0` go out the door with an
  honest "edit the header + view the bars + see the chart" surface
  that real users can build against, while the deeper editing
  ergonomics evolve in a follow-up.
- **The two surfaces solve different problems anyway.** The
  playground / desktop targets a power-user editing experience.
  `@chordsketch/react`'s initial target is *embedding* — read-only
  charts in apps, lightweight metadata edits in a CMS, simple
  preview gates in a song library. Approach (b) MVP matches that
  target directly.

## Consequences

Positive:
- `@chordsketch/react` can publish to npm at `0.1.0` without
  bundling private workspace source and without a sister-site
  fix-propagation obligation against `ui-irealb-editor`.
- The new components live next to the existing ChordPro components
  in the same package, sharing the same testing infrastructure
  (vitest + @testing-library/react), styles entry point
  (`styles.css`), and dual ESM/CJS build pipeline (tsup).
- Future React-side improvements (controlled-prop ergonomics,
  React-Concurrent-friendly state, server-component compatibility)
  land directly in the public surface, not through a wrapper layer.

Negative / accepted trade-offs:
- **MVP feature gap** vs. `ui-irealb-editor`. v0.1.0 ships the
  header form + read-only bar grid + URL textarea + SVG preview.
  Full popover-based bar editing, structural section/bar
  add/move/delete, and grid keyboard navigation are not yet
  available in `@chordsketch/react`; consumers who need them today
  still need the playground or `ui-irealb-editor` directly.
- **Two iReal Pro editor codebases until parity + migration.**
  Bugs in iReal Pro parsing flow into both editors through the
  shared wasm bridge, so parser fixes propagate automatically.
  Bugs *specific to the editor surface* (UI affordances, focus
  management, ARIA wiring) must be fixed twice during the parity
  window. Mitigation: the React surface starts narrow on purpose,
  so the doubled surface area is small at v0.1.0.
- **Future deprecation cost.** When parity is reached and the
  playground / desktop migrate to the React components, an ADR
  will retire `ui-irealb-editor`. That deprecation moves
  ~2.8 KLOC into the React package and removes a workspace
  package; both are cost the issue's "(b) deprecate
  `ui-irealb-editor` for new consumers" path already
  acknowledged.

## Alternatives considered

- **(a)-vendor (copy `ui-irealb-editor`'s source into
  `@chordsketch/react/src/internal/`).** Rejected because the
  fix-propagation rule
  ([`.claude/rules/fix-propagation.md`](../../.claude/rules/fix-propagation.md))
  promotes any divergence between the two copies to a Medium-or-higher
  defect. Two ~2.8 KLOC editor sources living in the same repository
  with a "keep in sync" contract is structurally worse than two
  independent implementations that share an AST.
- **(a)-bundle (tsup esbuild alias + workspace dependency).**
  Rejected because the resulting published bundle is opaque about
  which slice of `ui-irealb-editor` it captured; npm consumers
  reading the source map land in a private package the registry
  cannot resolve, and a security audit of the published bundle has
  no public corresponding source to diff against.
- **Publish `@chordsketch/ui-irealb-editor`.** Rejected by the
  issue's non-goal section explicitly: "Publishing
  `@chordsketch/ui-web` or `@chordsketch/ui-irealb-editor`. They
  remain private internal packages." Reversing that decision
  warrants its own ADR.

## References

- [#2473](https://github.com/koedame/chordsketch/issues/2473) —
  umbrella tracking issue for the embeddable React surface.
- [ADR-0017](0017-react-renders-from-ast.md) — the React surface
  consumes AST + JSX walker, not pre-rendered HTML. The iReal Pro
  components inherit the same direction (parse via wasm → AST →
  React JSX for the editor; SVG via `renderIrealSvg` for the
  preview).
- [`packages/ui-irealb-editor/src/index.ts`](../../packages/ui-irealb-editor/src/index.ts) —
  reference implementation of the full editor surface; consult
  when growing the React surface toward parity.
- **Watch signals**: when the playground + desktop are ready to
  migrate to `@chordsketch/react`'s iReal components (full parity
  + acceptable bundle size), open a supersession ADR retiring
  `ui-irealb-editor`.
