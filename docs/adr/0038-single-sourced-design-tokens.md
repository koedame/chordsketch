# 0038. Design tokens are single-sourced and generated to every consumer stylesheet

- **Status**: Accepted
- **Date**: 2026-06-26

## Context

ADR-0029 §5 names `design-system/tokens.css` the source of truth for the
design system's token values (color, typography, space, radius, elevation,
motion), with the canonical class vocabulary and `DESIGN.md` as the
framework-agnostic layer every consumer binds to.

That "source of truth" is **documentary, not mechanical**. The same token
values are hand-copied into four stylesheets, in two namespaces and two
scopes, with no generator tying them to a single origin:

| File | Namespace | Scope | Shape |
|---|---|---|---|
| `design-system/tokens.css` | bare (`--crimson-*`, `--ink-*`, `--sp-*`, …) | `:root` | 103 tokens, authored |
| `packages/ui-irealb-editor/src/style.css` | bare (`--crimson-*`, …) | `:root` | a 1:1 hand mirror of `tokens.css` (its own header comment says so) |
| `packages/react-ui/src/styles.css` | `--cs-*` | the component-class selector list (not `:root`, to avoid leaking vars into a host) | the token block, **raw values re-declared** |
| `packages/react/src/styles.css` | `--cs-*` | component-class selector list | the token block, raw values re-declared |

The `--cs-*` copies do not reference the bare tokens; they restate the
hex/px values independently. `DESIGN.md §9` already instructs authors to
mirror new tokens by hand to a list of these files — and that list has
**already drifted**:

- it names `packages/ui-web/src/style.css`, which was removed with the
  `@chordsketch/ui-web` package in ADR-0022;
- it describes `packages/ui-irealb-editor/src/style.css` as a `--cs-*`
  mirror, but that file uses the bare namespace, not `--cs-*`;
- it omits `packages/react-ui/src/styles.css`, the primary `--cs-*` mirror
  added in ADR-0029.

A documentary source of truth maintained by hand mirroring is exactly the
fix-propagation defect class the project fights everywhere else
(`.claude/rules/fix-propagation.md`): a value edited in one sibling, the
others overlooked. The `§9` drift is that class, already realised.

Two constraints bound any fix:

1. **The bare `:root` token names in `tokens.css` are a public contract.**
   External consumers of the published design-system layer import `tokens.css`
   verbatim and reference `--crimson-*` / `--ink-*` / `--sp-*` / `--fs-*` /
   `--r-*` / `--font-*` directly. Renaming, restructuring, or reformatting
   that file is a change to that contract and is out of scope here.
2. **The `--cs-*` namespace and its selector-scoping are deliberate.**
   `react` / `react-ui` scope their tokens to the component-class selector
   list precisely so a host application's `:root` is not polluted and the
   package imposes no global-variable requirement on its consumers. This
   isolation must be preserved.

The project also prefers invariants enforced by construction over vigilance
(ADR-0029 Rationale) and keeps dependencies minimal (`chordsketch-chordpro`
is zero-dep; other deps are justified per PR).

## Decision

1. **`design-system/tokens.css` remains the single authored source of
   truth**, unchanged. Its `:root` bare-name declarations — color,
   typography, space, radius, elevation, motion (including the
   `prefers-reduced-motion` overrides), container max-widths, and the focus
   ring — stay exactly as authored. It is the public contract external
   consumers import; it is not reformatted, moved, or demoted to a generated
   artifact.

2. **A bespoke, zero-dependency generator (`scripts/build-tokens.mjs`) parses
   `tokens.css` and writes the derived token blocks** that are hand-mirrored
   today, each between `/* @generated tokens:start */` and
   `/* @generated tokens:end */` markers, leaving every hand-authored
   component rule outside the markers untouched:
   - `packages/react-ui/src/styles.css` and `packages/react/src/styles.css` —
     the `--cs-*`-prefixed block, scoped to that file's existing
     component-class selector list (so the package still leaks no vars into a
     host `:root`);
   - `packages/ui-irealb-editor/src/style.css` — the bare-name `:root` block
     (a 1:1 projection of `tokens.css`).
   The generator is a pure projection of `tokens.css`: it applies the `--cs-`
   prefix and the selector wrapper for the package blocks and reproduces the
   bare names for the iReal block. Every value is computed from `tokens.css`,
   so the derived copies cannot diverge from it.

3. **Generated outputs are committed**, so the static `design-system/`
   reference and the packages still build with no extra consumer step
   (ADR-0011 posture preserved); running the generator is a contributor
   action.

4. **CI regenerates and asserts a zero diff**, mirroring the existing
   `readme-sync.yml` / `.github/snapshots/` idiom. A hand-edit inside a
   generated block, or a `tokens.css` change without regenerating the derived
   copies, fails loudly — turning the `DESIGN.md §9` hand-mirror instruction
   into a machine-enforced invariant.

5. **Namespaces and scopes are preserved, not unified.** The bare `:root`
   source and the `--cs-*` selector-scoped projection coexist by design;
   there is no consumer-facing variable name change and no rename.

6. **The generator is bespoke and dependency-free, and the source stays
   CSS.** `tokens.css` (CSS custom properties) is already a machine-readable,
   directly-usable token source; parsing it needs no library and adds no
   second representation to keep in sync.

7. **`DESIGN.md §9` is rewritten** to name `tokens.css` as the source and the
   generator as the mechanism that fans it out, replacing the stale
   hand-mirror file list.

8. **Single light theme only.** No theme / multi-context resolver layer is
   introduced; the generator emits one theme.

## Rationale

- **Mechanical single-sourcing eliminates the token fix-propagation defect
  class.** Once the derived blocks are generated from `tokens.css` and guarded
  by a CI diff, they cannot disagree with it. The `§9` drift documented above
  is the proof that hand mirroring does not hold.
- **Keeping `tokens.css` as the source preserves the public contract file
  exactly.** External consumers that copy it verbatim see no change, and there
  is no second representation (a JSON file) that could itself drift from the
  CSS or force a reformat of the contract file.
- **It reuses an idiom the repo already runs.** "Commit the generated
  artifact, verify regeneration in CI" is exactly `readme-sync.yml` +
  `.github/snapshots/readme-commands.txt`; contributors already understand the
  pattern.
- **A bespoke zero-dependency generator over a CSS source fits the project's
  posture.** Nothing new to install, nothing redundant to maintain.
- **Marker injection keeps churn minimal.** The deliberate selector-scoping
  wrapper and the single-file package CSS structure stay exactly as they are;
  only the delimited token block becomes machine-owned.
- **Where a derived copy has already drifted from `tokens.css`, the first
  regeneration reconciles it to the source** — the generation is the fix, not
  a freeze of the divergence.

## Consequences

**Positive**

- Token drift across the copies becomes structurally impossible; the derived
  blocks are projections of `tokens.css`.
- `tokens.css` and its public bare-name contract are untouched, so no external
  consumer of the token layer needs any change.
- `DESIGN.md §9`'s hand-mirror burden is removed: the workflow becomes "edit
  `tokens.css`, run the generator," and CI enforces it.

**Negative + mitigation**

- **`design-system/` + the packages gain a generation step** where the
  derived copies were authored by hand. *Mitigation*: outputs are committed,
  so there is no consumer build step; the generator is one dependency-free
  script.
- **`react` / `react-ui` `src/styles.css` become part-generated (token block)
  and part-authored (component rules).** *Mitigation*: the `@generated`
  markers plus the CI diff make the boundary explicit and safe; component
  rules remain hand-authored outside the markers.
- **The first regeneration may change a derived copy if it had drifted from
  `tokens.css`.** *Mitigation*: that change is the fix; the diff is reviewed
  token-by-token, then pinned by the CI guard thereafter.
- **A new script to learn.** *Mitigation*: documented in the rewritten
  `DESIGN.md §9` and a companion `.claude/rules/` entry.

## Alternatives considered

1. **A separate DTCG-JSON source (`design-system/tokens.json`) with
   `tokens.css` itself generated from it (via Style Dictionary or a bespoke
   script).** Rejected: it adds a second representation to keep in sync and
   would reformat `tokens.css` — the file external consumers copy verbatim —
   for no functional gain. The DTCG format's value is multi-platform / design-
   tool interoperability, which is unused here: the output is CSS only, and
   the Rust renderers compute their own values rather than consuming these
   tokens. `tokens.css`'s structure can be exported to DTCG later if a
   design-tool token sync is ever introduced; that door stays open.
2. **Use Style Dictionary as the generator.** Rejected (folds into 1): its
   multi-platform output is unused, and it adds a dependency tree against the
   minimal-dependency posture. A ~CSS-parse-and-emit script needs no library.
3. **Unify everything onto one namespace and scope.** Rejected: it would
   either break the public bare-name contract (external consumers reference
   `--crimson-*` directly) or drop the packages' host-isolation. High blast
   radius, no benefit once generation removes the drift.
4. **Make the `--cs-*` copies alias the bare tokens
   (`--cs-crimson-500: var(--crimson-500)`) instead of restating values.**
   Rejected: the `--cs-*` block is selector-scoped exactly so a component works
   without the host providing bare `:root` tokens; aliasing would reintroduce
   that global-`:root` dependency on every consumer. Generation single-sources
   without imposing it.

## References

- `design-system/tokens.css`, `design-system/DESIGN.md` §9,
  `packages/react/src/styles.css`, `packages/react-ui/src/styles.css`,
  `packages/ui-irealb-editor/src/style.css` — the source and the derived
  copies this ADR single-sources.
- ADR-0029 §5–6 — names `tokens.css` the source of truth and single-sources
  component CSS; this ADR makes that mechanical.
- ADR-0011 — static design-system / inline-styles posture, preserved by
  committing the generated outputs.
- ADR-0022 — retired `@chordsketch/ui-web`, a `§9` mirror target this ADR
  removes.
- `.claude/rules/fix-propagation.md` — the defect class eliminated for tokens.
- `.github/workflows/readme-sync.yml`,
  `.github/snapshots/readme-commands.txt`, `.claude/rules/readme-sync.md` — the
  generated-and-committed + CI-diff idiom reused here.
- Tracking issue: #2729 (the implementing PR follows the
  `issue-{number}-{short-description}` branch convention).
