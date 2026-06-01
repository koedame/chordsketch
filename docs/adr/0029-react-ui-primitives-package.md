# 0029. Design-system React primitives live in a wasm-free `@chordsketch/react-ui` package; `@chordsketch/react` does not re-export them

- **Status**: Accepted
- **Date**: 2026-06-02

## Context

The design system's source of truth is framework-agnostic: the design
tokens (`design-system/tokens.css`), the canonical class vocabulary
(`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-sm`, ...), and the prose
spec in `design-system/DESIGN.md`, with static reference renders under
`design-system/preview/*.html`. Non-React consumers (CLI, FFI bindings,
GitHub Action, and the Kotlin/Swift packages) bind to that layer through
plain markup or their own host idioms.

React consumers have no published binding of the design-system
*primitives* (buttons, and the cards / badges / form controls that
`DESIGN.md §6` and `preview/components-*.html` already specify). The
React surface that exists today — `@chordsketch/react` — is
domain-specific: ADR-0017 / ADR-0020 / ADR-0022 established it as the
ChordPro and iReal Pro editor/preview/atom tiers, every component powered
by `@chordsketch/wasm` (`@chordsketch/wasm-export` is an optional peer).
It exports a single `.` barrel and carries the wasm coupling by design.

Because there is no React binding for the primitives, every React host
re-derives the canonical class usage by hand:

- The playground writes `className="btn btn-ghost btn-sm"` and
  `className="btn btn-secondary btn-sm"` directly in JSX at multiple
  sites in `packages/playground/src/chordpro/main.tsx` and
  `packages/playground/src/irealpro/main.tsx`.
- The Tauri desktop frontend (`chordsketch-desktop-frontend`, React 18)
  composes its app chrome the same way.
- External integrators who consume `@chordsketch/react` for the editors
  have to reproduce the class vocabulary themselves to match the design
  system around those editors.

So the same canonical-class-in-JSX pattern is duplicated across the
project's own React hosts, with no supported binding for outside
integrators. This raises the question of where React design-system
primitives should live. Two structural constraints bound the answer:

1. **Primitives must not carry a wasm dependency.** A consumer that
   wants a `<Button>` should not pull the `@chordsketch/wasm*` graph or
   inherit its optional peer expectation. The primitives are pure
   class-composition over tokens; wasm is irrelevant to them.
2. **ADR-0022 retired `@chordsketch/ui-web` and rejected reintroducing a
   private intermediate package *between* the React surface and its
   consumers.** Any new package must not reopen that decision: it has to
   be a sibling design-system layer that hosts depend on only when they
   actually use a primitive, not an intermediary that the domain surface
   or its consumers must route through.

`@chordsketch/react` is pre-1.0 (currently `0.3.0`), so the package
boundary can still be set without semver cost. This is the window to fix
it for v1.0 rather than after.

## Decision

1. **Create `@chordsketch/react-ui`** — a new published, `@chordsketch`-
   scoped package (the scope criterion in ADR-0008 §6: an SDK surface for
   applications consuming ChordSketch as a library). It holds the React
   binding of the design-system primitives. Each primitive is a thin
   composition over the canonical class vocabulary defined in
   `design-system/DESIGN.md` / `tokens.css`; it adds no styling of its
   own and no domain behaviour. `<Button>` is the first primitive;
   cards, badges, and form controls follow as they are needed.

2. **`@chordsketch/react-ui` carries zero wasm dependency.** Its
   `package.json` must not depend on (or peer-depend on)
   `@chordsketch/wasm` or `@chordsketch/wasm-export`. This is a
   structural invariant of the package manifest, not a lint rule over a
   source directory — see Rationale. A harness test asserts the resolved
   dependency closure of `@chordsketch/react-ui` contains no
   `@chordsketch/wasm*` entry, so a future edit that reintroduces the
   coupling fails loudly.

3. **`@chordsketch/react` stays domain-only and does NOT re-export
   `@chordsketch/react-ui`.** Consumers import primitives from
   `@chordsketch/react-ui` and the ChordPro/iReal surface from
   `@chordsketch/react` — two explicit import sources, no umbrella.

4. **When a domain component composes a primitive** (e.g. a preview
   toolbar that uses `<Button>`), `@chordsketch/react` declares
   `@chordsketch/react-ui` as a **`peerDependency`**, never a regular
   `dependency`. The consumer resolves a single `@chordsketch/react-ui`
   instance; no duplicate copy, version skew, broken React context, or
   double CSS injection can arise from the composition.

5. **The framework-agnostic layer is unchanged.**
   `design-system/tokens.css`, the canonical classes, and `DESIGN.md`
   remain the source of truth; `design-system/preview/*.html` remain the
   framework-agnostic visual spec for non-React consumers.
   `@chordsketch/react-ui` is the React *binding* of that layer, not a
   redefinition of it. New primitives still land in `DESIGN.md` +
   `preview/` first, then get a React binding — the existing
   design-system flow is the gate.

6. **CSS ownership is single-sourced.** Component CSS for the primitives
   ships from `@chordsketch/react-ui` (`@chordsketch/react-ui/styles.css`)
   and must not duplicate canonical class definitions that already ship
   from the token/design-system layer. Tokens come from the design-system
   token layer; the package's stylesheet adds only what its own
   components need.

7. **The project's own React hosts migrate.** The hand-written
   canonical-class JSX in the playground and the desktop frontend is
   replaced with `@chordsketch/react-ui` primitives in the same window.

## Rationale

- **A wasm-free primitive layer becomes a checkable invariant, not a
  convention.** The decisive reason to make this a separate package
  rather than a subpath export inside `@chordsketch/react`. With a
  package boundary, "primitives carry no wasm" is a property of
  `@chordsketch/react-ui`'s manifest that a test can assert and a
  reviewer can read at a glance. With subpath exports inside the existing
  package, the same guarantee would survive only as discipline ("do not
  import the wasm modules from the primitives directory"), one stray
  import away from silent violation. The project already prefers
  invariants enforced by construction over invariants enforced by
  vigilance.
- **Independent semver.** The design-system primitives stabilise at a
  different cadence than the ChordPro/iReal feature surface. A single
  package couples their major bumps: a breaking change in the editor API
  would force a major on consumers that use only `<Button>`, and vice
  versa.
- **An honest consumer/scope story (ADR-0008 §6).** A consumer that wants
  only the React design-system primitives installs a small package with
  no wasm in its graph; a consumer that wants the editors installs
  `@chordsketch/react`. Both are `@chordsketch`-scoped SDK surfaces, as
  ADR-0008 §6 prescribes for library consumers.
- **Not re-exporting eliminates the dual-instance failure class.**
  Re-exporting `@chordsketch/react-ui` from `@chordsketch/react` through a
  regular `dependency` would let a consumer that *also* depends on
  `@chordsketch/react-ui` directly resolve two copies at different
  versions — breaking any primitive that relies on React context or a
  module-level singleton, and double-injecting the primitives' CSS. Plan
  A (no re-export; peer-dep when composed) removes the failure mode
  entirely. The only cost is two import sources, which consumers already
  manage across the existing `@chordsketch/*` packages.
- **This does not reopen ADR-0022.** `@chordsketch/ui-web` was a
  vanilla-TS package that masqueraded as framework-agnostic and sat
  *between* the React surface and its hosts; ADR-0022 retired it because
  the only remaining consumer was itself React-capable. `@chordsketch/
  react-ui` is the opposite shape: a genuine React package that is a
  *sibling* design-system layer, depended on directly and only when a
  primitive is used. It is not an intermediary the domain surface routes
  through.

## Consequences

**Positive**

- One canonical React binding of the design-system primitives. The
  project's React hosts stop duplicating canonical-class JSX, and outside
  integrators get a supported way to use the design system in React
  around the editors.
- "Primitives are wasm-free" is guaranteed by the package boundary and a
  harness test, not by reviewer attention.
- Primitives and the editor surface version independently.

**Negative + mitigation**

- **A new package adds release surface.** Per ADR-0008, every package
  publishes manually from the maintainer's machine; `@chordsketch/
  react-ui` adds one more publish to `docs/releasing.md`, a build/verify
  workflow mirroring `react.yml`, and its own CHANGELOG entry. Mitigation:
  the package is small and follows the established `react.yml` pattern;
  no new credential or automation is introduced.
- **Two import sources instead of one.** Consumers import primitives and
  editors from different package names. Mitigation: documented in both
  READMEs; this matches how the `@chordsketch/*` packages are already
  consumed, and it is the price of avoiding the dual-instance bug an
  umbrella re-export would introduce.
- **Migration churn in the playground and desktop frontend.** Mitigation:
  taken now while pre-1.0; scoped to swapping hand-written class JSX for
  primitives; kept reviewable per the contribution flow.
- **Name proximity to the retired `@chordsketch/ui-web`.** A reader might
  assume `react-ui` is "ui-web for React." Mitigation: this ADR and the
  package README state explicitly that `@chordsketch/react-ui` is the
  React binding of the design-system primitives, distinct from the
  retired vanilla-TS `ui-web`; the naming trade-off is recorded under
  Alternatives.

## Alternatives considered

1. **Subpath exports inside a single `@chordsketch/react`** (`.` =
   primitives, `./chordpro` / `./irealb` = domain). Rejected: the
   wasm-free guarantee stays a discipline over a source seam rather than
   a property of a manifest; primitives and editor surface stay coupled
   for semver; and primitive-only consumers still install a package whose
   tarball carries the domain + wasm code, relying on bundler
   tree-shaking through a barrel to drop it.
2. **`@chordsketch/react` re-exports `@chordsketch/react-ui` as a regular
   dependency** (a convenience umbrella). Rejected: the dual-instance
   footgun described in Rationale. If an umbrella is ever wanted, it
   should be expressed through a `peerDependency` or a dedicated
   meta-package — deferred until a concrete need exists, which at 0.x it
   does not.
3. **Keep primitives unpublished; each consumer wraps the canonical
   classes itself** (status quo). Rejected: it is exactly the duplication
   this ADR removes, and it leaves external integrators with no supported
   primitive binding. The design system is a first-class, documented,
   public product, not an internal detail.
4. **Name the package `@chordsketch/ui` or
   `@chordsketch/react-primitives`.** `@chordsketch/ui` is
   framework-ambiguous and collides conceptually with the retired
   `ui-web`; `@chordsketch/react-primitives` is clearer but verbose.
   `@chordsketch/react-ui` was chosen as the React-scoped design-system
   primitive binding. Open to revision in the implementing PR.

## References

- ADR-0008 §6 — `@chordsketch`-scope criterion ("the consumer is a
  ChordSketch user") and the manual, per-package publish flow that a new
  package inherits.
- ADR-0017 / ADR-0020 / ADR-0022 — established `@chordsketch/react` as
  the domain (ChordPro / iReal) React surface and its tier taxonomy, and
  retired `@chordsketch/ui-web`. This ADR adds a sibling primitive layer
  without reopening the ui-web decision.
- ADR-0028 — precedent for naming a single source of truth and binding
  every consumer to it.
- `design-system/DESIGN.md`, `design-system/tokens.css`,
  `design-system/preview/components-*.html` — the framework-agnostic
  layer that `@chordsketch/react-ui` binds.
- `packages/playground/src/chordpro/main.tsx`,
  `packages/playground/src/irealpro/main.tsx` — hand-written
  canonical-class JSX to migrate onto the primitives.
- `docs/releasing.md`, `.github/workflows/react.yml` — the publish
  checklist and build/verify workflow pattern the new package mirrors.
- Tracking issue: #TBD (assigned when the issue is filed; the branch and
  PR follow the `issue-{number}-{short-description}` convention).
