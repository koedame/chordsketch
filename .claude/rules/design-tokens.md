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
  `packages/react/src/styles.css`, `packages/react-ui/src/styles.css`, and
  `packages/ui-irealb-editor/src/style.css` is machine-owned. Edit the source
  and regenerate instead.
- Component rules outside the markers are hand-authored exactly as before.
- `tokens.css` is also the public contract external consumers import; its bare
  `--crimson-*` / `--ink-*` / `--sp-*` / `--fs-*` / `--r-*` / `--font-*` names
  are not renamed without a breaking change (ADR-0038, constraint 1).

## Enforcement

`.github/workflows/tokens-sync.yml` regenerates and asserts a zero diff on every
PR that touches `tokens.css`, a generated stylesheet, or the generator — the
same "commit the generated artifact, verify it in CI" idiom as
[`readme-sync.md`](readme-sync.md). A hand-edited generated block, or a
`tokens.css` change without regeneration, fails the check.

## Why

The values used to be hand-mirrored across four stylesheets in two namespaces,
and `DESIGN.md §9`'s mirror list drifted (it named a removed file, mislabelled
one mirror, and omitted another). Generation makes "the copies agree with the
source" an invariant the CI keeps true, the same way
[`fix-propagation.md`](fix-propagation.md) treats sister sites. See
[ADR-0038](../../docs/adr/0038-single-sourced-design-tokens.md).
