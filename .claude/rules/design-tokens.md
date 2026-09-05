# Design Tokens

`design-system/tokens.css` is the single authored source of truth for every
design token (color, typography, space, radius, elevation, motion). The
per-package token blocks that paint the React primitives and the iReal Pro
editor are **generated** from it by `scripts/build-tokens.mjs` (ADR-0038), so
they cannot drift from the source.

## Rule

- **Edit tokens only in `design-system/tokens.css`.** To add, change, or remove
  a token, edit that file, then run `node scripts/build-tokens.mjs` and commit
  the regenerated stylesheets in the same PR.
- **Never hand-edit a generated block.** The block between
  `/* @generated:start … */` and `/* @generated:end */` in
  `packages/react/src/styles.css`, `packages/react-ui/src/styles.css`,
  `packages/ui-irealb-editor/src/style.css`, and
  `packages/playground/src/playground.css` is machine-owned. Edit the source
  and regenerate instead.
- Component rules outside the markers are hand-authored exactly as before.
- **The chrome region obeys the same rule with its own generator.**
  `packages/react-ui/src/styles.css` carries a second machine-owned block
  between `/* @generated:chrome:start … */` and `/* @generated:chrome:end */`,
  projected from the design system's reference pages by
  `scripts/build-chrome-css.mjs` (ADR-0060). To change `.topnav` / `.sidenav` /
  `.pane*` / `.stack*`, edit the canonical reference page the generator names
  for that family, run `node scripts/build-chrome-css.mjs`, and commit the
  regenerated stylesheet in the same PR.
- `tokens.css` is also the public contract external consumers import; its bare
  `--crimson-*` / `--ink-*` / `--sp-*` / `--fs-*` / `--r-*` / `--font-*` names
  are not renamed without a breaking change (ADR-0038, constraint 1).

## Enforcement

`.github/workflows/tokens-sync.yml` runs both generators and asserts a zero diff
on every PR that touches `tokens.css`, a design-system reference page a chrome
family is generated from, a generated stylesheet, or either generator — the
same "commit the generated artifact, verify it in CI" idiom as
[`readme-sync.md`](readme-sync.md). A hand-edited generated block, or a source
change without regeneration, fails the check.

## Why

The values used to be hand-mirrored across five stylesheets in two namespaces,
and `DESIGN.md §9`'s mirror list drifted (it named a removed file, mislabelled
one mirror, and omitted another). Generation makes "the copies agree with the
source" an invariant the CI keeps true, the same way
[`fix-propagation.md`](fix-propagation.md) treats sister sites. See
[ADR-0038](../../docs/adr/0038-single-sourced-design-tokens.md).
