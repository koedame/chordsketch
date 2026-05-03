# Playground Smoke Discipline

Origin: #2397, where `mountChordSketchUi` shipped a wasm-init race
that no in-process suite caught — three test layers (ui-web,
ui-irealb-editor, playground) each green, each blind to the
integration.

`@chordsketch/ui-web`'s `mountChordSketchUi` integrates several
otherwise-independent layers (renderer wasm bundle, editor adapter
factory, format-toggle host wiring) at runtime. Each layer carries
its own unit-test suite that **deliberately stubs the boundaries** to
the others — it is faster to test, and it lets a package's tests run
without a built sibling. The cost is that no in-process suite ever
observes the actual integration: the only thing that proves the
playground mounts is loading the page in a real browser.

## Rule

Any PR that

- adds a new `EditorFactory` invocation site in the playground or the
  desktop app,
- adds a new format-toggle entry to the playground (currently
  ChordPro / iRealb),
- changes `mountChordSketchUi`'s mount sequence (init order, factory
  signature, error-recovery path),
- changes `Renderers.init` semantics, or
- changes the wasm bundle's exported surface in a way that the
  playground or desktop adapters consume

MUST extend the Playwright smoke suite at
`packages/playground/tests-e2e/` so the new path is exercised end to
end. Adding the spec is the only way to prove the integration
actually works in the deployed bundle.

## What the smoke suite covers today

- `tests-e2e/format-toggle.spec.ts`: default ChordPro mount,
  ChordPro -> iRealb runtime swap, iRealb -> ChordPro runtime swap.
- `tests-e2e/irealb-deep-link.spec.ts`: `?#format=irealb` cold load
  mounts the bar-grid editor, no `__wbindgen_free` errors land on the
  console (the pre-#2397 failure surface), clicking a bar opens the
  popover dialog.

## Where it runs

- `.github/workflows/playground-smoke.yml` runs on every PR and on
  push to `main`. No `paths:` filter (per
  `.claude/rules/ci-parallelization.md` §6 and the project's
  guarantee-style-checks discipline).
- Branch protection SHOULD require the workflow's `smoke` job to
  pass before merge. (Maintainer config: this rule documents the
  expectation, the PR that introduces a new path must not assume
  branch protection is unconfigured.)
- `.github/workflows/deploy-playground.yml` is intentionally NOT
  modified — it remains scoped to `paths:` so unrelated PRs don't
  trigger a Pages artifact upload they will discard. The smoke
  workflow is the gate; the deploy workflow runs after smoke is
  green on `main`.

## Authoring guidance

- Assert structural anchors (DOM selectors, `role=`), not visual
  details. Pixel snapshots are out of scope (see #1983 for the
  related decision in render-pdf).
- Drive the production build (`vite preview` of `dist/`) rather
  than the dev server. The deployed bundle is what users see; the
  dev server's `fs.allow` and HMR machinery don't ship to
  production.
- Include at least one assertion per format that would fail if the
  adapter silently degraded to "no editor mounted." The pre-#2397
  failure was that `?#format=irealb` rendered the SVG preview just
  fine, so a smoke that only checked "the page didn't error" would
  have shipped a green CI on the broken state.
- Capture pageerror / console.error in deep-link specs and assert
  the message list is empty for known-bad strings (e.g.
  `__wbindgen_free`). This is cheap and catches the silent-mount
  failure mode that motivated the rule.

## Why a separate rule

The renderer-parity discipline in
`.claude/rules/renderer-parity.md` covers ChordPro -> {text, html,
pdf} parity. The integration boundary this rule covers is different:
it is about the playground / desktop **host** wiring multiple wasm-
backed layers together, not about parity between renderer
implementations. The two rules are siblings, not nested.
