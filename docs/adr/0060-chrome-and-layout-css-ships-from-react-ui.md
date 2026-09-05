# 0060. Chrome and layout CSS ships from `@chordsketch/react-ui`, generated from the design-system reference

- **Status**: Accepted
- **Date**: 2026-09-06

## Context

`design-system/DESIGN.md` defines two families of canonical classes:

- **Primitives** — `.btn`, `.field` / `.input` / `.select` / …, `.song-card`,
  `.badge` / `.pill`. §6 tabulates them, `preview/components-*.html` renders
  them, and they ship as CSS from `@chordsketch/react-ui/styles.css`
  alongside their React bindings (ADR-0029 §6).
- **Chrome and layout** — the app-shell vocabulary `.topnav` (with its
  `.brand` / `.crumbs` / `.save-state` / `.nav-links` / `.right` / `.actions`
  parts), `.sidenav`, the `.pane` / `.pane-head` / `.pane-body` split-pane
  frame, and the `.stack` vertical-flow primitive with its `--stack-gap`
  modifiers. §4.1 specifies `.stack` in prose *and CSS*; §9 states outright
  that the class names in `ui_kits/web/editor.html` "are the canonical chrome
  vocabulary".

Both families are canonical. **Only the first one is distributed.** The
chrome and layout rules exist solely as `<style>` blocks inside the
reference HTML under `design-system/`, which is not a published artefact —
it is a set of static full-screen samples and component previews. There is
no npm package, and no file, a consumer can install or import to obtain
them.

The consequence is that a consumer building an app shell around the
editors re-derives the chrome by hand: copying the rules out of the sample
HTML into its own stylesheet, translating the token names as it goes. That
copy is a fix-propagation defect the moment it exists — an upstream value
change (a nav height, a pane padding, an elevation) lands in `design-system/`
and the consumer's copy silently keeps the old number. This is the same
defect class ADR-0038 removed for token *values* and
`.claude/rules/fix-propagation.md` fights between sister sites, left open
one layer up at the *rule* level.

The reference HTML is also not internally uniform, which any distribution
mechanism has to answer for. `.topnav` is 56px in `ui_kits/web/editor.html`,
`ui_kits/web/library.html`, `ui_kits/web/viewer.html` and
`preview/components-navigation.html`, but 52px in
`ui_kits/web/editor-chord-footer.html`, whose panes are also padded tighter —
that file is a deliberately denser variant of the editor, not a competing
definition. §9 already resolves this by naming `ui_kits/web/editor.html` the
canonical chrome source; the resolution has never been mechanised.

Two constraints bound the answer:

1. **`@chordsketch/react-ui`'s stylesheet scopes its `--cs-*` token block to
   an explicit selector list**, deliberately, so the package leaks no
   variables into a host's `:root` (ADR-0038 constraint 2). Any class added
   to that stylesheet must join that list or its `var(--cs-*)` references
   dangle.
2. **The design system is versioned** (`DESIGN.md` §11): adding a canonical
   class or shipping one from a package is MINOR, removing or renaming one is
   MAJOR. Whatever ships becomes a contract.

## Decision

1. **The chrome and layout classes ship as CSS from the existing
   `@chordsketch/react-ui/styles.css`.** No new package is created. The
   scope is exactly the vocabulary above: `.topnav` and its parts,
   `.sidenav`, `.pane` / `.pane-head` / `.pane-body`, and `.stack` with its
   `--stack-gap` modifiers.

2. **No React binding is added.** Chrome and layout stay CSS-only: a
   consumer writes `<header class="topnav">` itself. `DESIGN.md` §6's
   "React binding" column gains a third state — *CSS only* — distinct from
   both "ships a primitive" and "reference only". A binding can follow later
   under ADR-0029 §5's existing order (`DESIGN.md` + `preview/` first, React
   second) if a consumer needs one.

3. **The rules are generated, not transcribed.** `scripts/build-chrome-css.mjs`
   reads the canonical reference HTML, selects the in-scope rules, rewrites
   every custom property into the `--cs-*` namespace, and splices the result
   into a `/* @generated:chrome:start */` … `/* @generated:chrome:end */`
   region of `packages/react-ui/src/styles.css`. The output is committed;
   `tokens-sync.yml` regenerates and asserts a zero diff, exactly as it
   already does for the token blocks.

4. **Each family names exactly one canonical source file** in the
   generator, making §9's prose resolution mechanical:

   | Family | Canonical source |
   |---|---|
   | `.topnav` (base, brand, crumbs, save-state, actions) | `design-system/ui_kits/web/editor.html` |
   | `.topnav .nav-links`, `.topnav .right` | `design-system/preview/components-navigation.html` |
   | `.sidenav` | `design-system/preview/components-navigation.html` |
   | `.pane`, `.pane-head`, `.pane-body` | `design-system/ui_kits/web/editor.html` |
   | `.stack`, `.stack-*` | `design-system/preview/layout-stack.html` |

   The generator asserts that the two files contributing `.topnav` agree on
   the base rule, that every family matches at least one rule, and that no
   selector is emitted twice — so a rename, a deletion, or a newly
   introduced disagreement fails loudly instead of emitting a plausible but
   wrong stylesheet. `ui_kits/web/editor-chord-footer.html` is not a source.

5. **`--stack-gap` is projected as `--cs-stack-gap`** in the package, like
   every other custom property in that stylesheet and for the same reason
   (a host's own `--stack-gap` must not reach into the primitive). The bare
   `--stack-gap` name in `DESIGN.md` §4.1 is unchanged for consumers of the
   framework-agnostic layer.

## Rationale

- **A second package would split the answer to "where does canonical CSS
  come from".** ADR-0029 §6 made `@chordsketch/react-ui/styles.css` the one
  place component CSS ships from. Today every consumer that wants the chrome
  also wants the buttons and form controls it contains, so a separate
  CSS-only package would buy a cleaner name at the cost of two stylesheets
  to load, two version numbers to keep compatible, and a second manual
  publish in `docs/releasing.md` (ADR-0008) — for zero consumer benefit.
- **The reversal is cheap in one direction only.** If a genuinely
  React-averse consumer appears, extracting the generated region into a
  CSS-only package later is a mechanical move of a machine-owned block, and
  `react-ui` can then consume it. Creating the package now, and discovering
  nobody wanted it separately, means an unpublishable name and a release
  surface that cannot be withdrawn.
- **Generation is what makes this worth doing at all.** The problem being
  solved is silent drift between a definition and its copies. Shipping a
  hand-transcribed copy would move the drift from the consumer's stylesheet
  into this repository's, which is an improvement in reach and none at all
  in correctness. ADR-0038 established both the mechanism (project the
  source, commit the output, gate on a zero diff) and the precedent that
  this repository prefers invariants enforced by construction.
- **Naming one source per family is the smallest honest resolution of the
  sample-to-sample divergence.** §9 already picked `editor.html`; the
  generator now enforces that pick, and the cross-file agreement assertion
  means the union taken for `.topnav` cannot quietly become a conflict.
- **CSS-only is the honest shape for this vocabulary.** These classes carry
  no behaviour and no state; a `<TopNav>` component would be a `<header>`
  with a `className`. §6 already records categories that are specified
  without a binding, so "shipped but unbound" is a state the document can
  express without inventing a taxonomy.

## Consequences

**Positive**

- The chrome and layout vocabulary becomes installable. A consumer imports
  one stylesheet and gets the same app shell the reference samples show,
  with no hand-copied rules to re-sync.
- Drift between `design-system/` and the shipped CSS becomes structurally
  impossible: the shipped rules are a projection of the reference, and CI
  fails on any hand edit or un-regenerated source change.
- §9's "canonical chrome vocabulary" claim acquires a mechanism. The
  divergent sample is now explicitly not a source, rather than implicitly
  one.

**Negative + mitigation**

- **`@chordsketch/react-ui` now ships CSS for classes it exposes no
  component for.** *Mitigation*: the package is the design system's React
  binding, and app chrome is what its README already says the package is
  for; §6's CSS-only state and the package README both name the gap
  explicitly, so no reader concludes a `<TopNav>` is missing by oversight.
- **A non-React consumer that wants only the chrome installs a package with
  React peer dependencies.** *Mitigation*: accepted for now — no such
  consumer exists, and the extraction path above is open if one appears.
  This is the trade the alternative below would reverse.
- **A second generator to learn and a second generated region in one
  file.** *Mitigation*: it is the same idiom, the same marker convention and
  the same CI job as ADR-0038's; both regions are delimited and documented in
  `.claude/rules/design-tokens.md`.
- **The primitives remain hand-transcribed while the chrome is generated.**
  *Mitigation*: deliberate, not overlooked. Extending the generator over the
  primitives is a larger change against rules that have already been edited
  away from their source (loading states, `:disabled` handling, the
  namespaced keyframe) and is left to its own decision.

## Alternatives considered

1. **A CSS-only package (`@chordsketch/design-system-css`) that
   `@chordsketch/react-ui` also consumes.** The cleanest responsibility
   split, and the right answer the day a non-React consumer needs the
   chrome. Rejected for now: it adds a package, a build/verify workflow, a
   CHANGELOG, a `docs/releasing.md` step and a manual publish (ADR-0008),
   plus a compatibility range between two packages that always ship
   together — all of it serving a consumer that does not exist yet, and all
   of it hard to withdraw. The extraction stays available precisely because
   the rules land in a machine-owned region.
2. **Hand-transcribe the chrome rules into `react-ui/src/styles.css`**, the
   way the primitives were transcribed. Rejected: it distributes the
   vocabulary but leaves the copy free to drift from `design-system/`, which
   is the defect the change exists to remove.
3. **Publish `design-system/` itself as a package** (the reference HTML plus
   a chrome stylesheet extracted from it). Rejected: the reference files are
   full-page samples carrying page scaffolding, demo-only visual aids and
   sample content; making them a distributable would either publish that
   noise or require exactly the extraction step this ADR already performs,
   with an additional package on top.
4. **Add React bindings (`<TopNav>`, `<Pane>`, `<Stack>`) and ship the CSS
   with them.** Rejected as scope: bindings for behaviourless containers
   are `<div className>` wrappers, and ADR-0029 §5 asks that a binding
   follow a consumer's need rather than precede it. Nothing prevents adding
   them later; the CSS is the part that is missing today.
5. **Do nothing and let consumers keep copying.** Rejected: it is the
   status quo whose failure mode — a shared vocabulary that silently stops
   being shared — motivated this decision.

## References

- ADR-0029 §5–6 — `@chordsketch/react-ui` as the React binding of the design
  system, and single-sourced component CSS ownership.
- ADR-0038 — single-sourced design tokens; the generator + committed output +
  CI zero-diff idiom this ADR reuses, and the `--cs-*` scoping constraint.
- ADR-0008 §6 — `@chordsketch`-scope criterion and the manual per-package
  publish flow a new package would inherit.
- `design-system/DESIGN.md` §4.1 (`.stack`), §6 (component table and its
  React-binding column), §9 (canonical chrome vocabulary and the file
  inventory), §11 (versioning).
- `.claude/rules/fix-propagation.md`, `.claude/rules/design-tokens.md` — the
  defect class and the generated-block rule extended here.
