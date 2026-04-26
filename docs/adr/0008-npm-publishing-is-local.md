# 0008. npm publishing is a maintainer-local manual operation

- **Status**: Accepted
- **Date**: 2026-04-26

## Context

Three workflows in this repository carry `npm publish` steps for
ChordSketch's npm-distributed packages:

- `npm-publish.yml` — `@chordsketch/wasm`
- `npm-publish-tree-sitter.yml` — `tree-sitter-chordpro`
- `napi.yml` — `@chordsketch/node` (meta package + 5 platform
  packages produced by `napi-rs`)

`react.yml` carries a header comment stating that
`@chordsketch/react`'s first publish would be manual but that
"automated publish will be added in a follow-up once the package
namespace exists on npm". This ADR retires that "follow-up" plan.

The CI publish path uses a single repo secret, `NPM_TOKEN`, holding
a granular access token issued to the maintainer's `unchidev` npm
account. The token is configured for `@chordsketch` scope read+write
and `chordsketch` org read+write.

The CI npm publish path has been intermittently broken since the
first `@chordsketch/wasm` publish in early 2026, in two distinct
failure modes:

1. **404 on first publish of a new package.** Every brand-new
   `@chordsketch/*` package name returns
   `404 Not Found PUT https://registry.npmjs.org/@chordsketch%2fwasm`
   from CI even with the token's stated scope. Manual local
   `npm publish` from `unchidev`'s machine succeeds. The exact
   mechanism is unclear — possibly granular tokens silently lack a
   "create new package in org scope" permission that does not
   surface in the npm UI. The previous workaround was "manual first
   publish, then CI takes over for version bumps."

2. **404 on existing-package version bumps.** Observed 2026-04-26
   during the `@chordsketch/wasm@0.3.0` recovery: CI `npm publish`
   (workflow run 24951333137) returned the same 404 PUT against an
   existing package that previously published five times via CI.
   Manual local `npm publish` immediately afterward succeeded with
   no other change. Re-attempting via CI would have only restored
   confidence that the token was working *that minute*, not
   addressed the recurrence.

The previous "manual first / CI subsequent" policy is invalidated
by failure mode #2: existing-package publishes are no longer
reliable through CI either, and the "reliable in CI" assumption was
always conditional on a token-state that the maintainer cannot
directly observe.

## Decision

1. **All `npm publish` steps are removed from CI.** Every npm
   publish for every ChordSketch-distributed package runs manually
   from the maintainer's machine after the corresponding release
   tag has been pushed.

2. **The CI workflows that previously published are reduced to
   build/verify.** They still:
   - Build the artefacts (`wasm-pack build`, `napi build`,
     `tree-sitter generate`, etc.) on every release tag and on PR
     touches.
   - Verify the package's `package.json` `version` matches the tag.
   - Pack the tarball with `npm pack --dry-run` to surface size /
     filename regressions early.
   - Upload artefacts to the GitHub Release (only for `napi.yml`,
     where the platform `.node` files cannot be reproduced on a
     single maintainer machine — see Decision step 4).

   They do NOT:
   - Run `npm publish` in any form.
   - Reference `secrets.NPM_TOKEN` in any step that runs after the
     workflow YAML changes land. The secret value stays provisioned
     until a separate cleanup PR removes it (Decision step 5).

3. **Manual publish flow per package**, documented in
   `docs/releasing.md`:

   - `@chordsketch/wasm`: `cd packages/npm && npm run build &&
     npm whoami && npm publish && npm view @chordsketch/wasm
     version`. The `npm run build` script in `packages/npm/`
     runs the `wasm-pack` calls that produce the dual-package
     `web/` (ESM) and `node/` (CommonJS) layouts.
   - `tree-sitter-chordpro`: equivalent flow under
     `packages/tree-sitter-chordpro/` with `npm publish --access
     public`.
   - Future `@chordsketch/react`: same pattern under
     `packages/react/`.

4. **`@chordsketch/node` (napi-rs) is the special case.** The
   meta package distributes prebuilt `.node` binaries for five
   platforms (linux x64, linux arm64, mac x64, mac arm64,
   windows x64). The maintainer cannot reproducibly build all
   five locally. The flow is:

   1. CI matrix builds the platform artefacts on a release tag,
      uploads them to the GitHub Release.
   2. Maintainer runs `gh release download <tag>` locally to
      fetch the platform tarballs.
   3. Maintainer runs `npm publish --access public` for each
      platform sub-package + the meta package, in order
      (platforms first, meta last so the meta's
      `optionalDependencies` resolve to live versions).

5. **`NPM_TOKEN` is retained as a repo secret** until a follow-up
   cleanup PR removes it. Removing the secret in the same PR as
   the workflow changes risks a half-applied state where one
   workflow YAML still references the secret and the secret is
   gone, producing harder-to-diagnose CI errors. The follow-up PR
   has no other content and is therefore reversible by a single
   revert.

6. **The npm package name asymmetry is intentional and fixed.**
   `tree-sitter-chordpro` stays unscoped; `@chordsketch/wasm`,
   `@chordsketch/node`, and the future `@chordsketch/react` stay
   scoped under `@chordsketch`. The criterion for scope choice is
   "what ecosystem does the consumer come from?":

   - **Scoped under `@chordsketch`**: SDK API surface for
     applications consuming ChordSketch as a library. The consumer
     is a ChordSketch user.
   - **Unscoped (`tree-sitter-*`)**: tree-sitter ecosystem
     citizen. The consumer is a tree-sitter user (Neovim
     `nvim-treesitter`, Helix, Zed, the `tree-sitter` CLI itself,
     other editor plugins) who may not know the project produces
     it. Discovery via `tree-sitter-*` glob is part of how the
     ecosystem locates parsers; eleven major tree-sitter parsers
     sampled on npm 2026-04-26 (`tree-sitter-rust`,
     `tree-sitter-python`, `tree-sitter-typescript`,
     `tree-sitter-ruby`, `tree-sitter-bash`, `tree-sitter-elixir`,
     `tree-sitter-html`, `tree-sitter-css`, `tree-sitter-go`,
     `tree-sitter-c-sharp`, plus the `tree-sitter` CLI) are all
     unscoped.

   This non-uniformity is documented here so future contributors
   do not propose unifying the four packages under one scope as
   a "cleanup" — the asymmetry reflects two different consumer
   ecosystems, not historical accident.

## Rationale

### Why not fix the CI publish path instead?

The 2026-04-26 incident put the question on stronger footing:
the CI publish path failed for a previously-working package
without any visible token, scope, or API change. The failure
mode was identical to the new-package case described in memory
months earlier. The cost-benefit of "make CI publish reliable"
versus "remove CI publish":

- **Make CI reliable.** Requires either a different token type
  (npm "automation" tokens, which exist but require an account
  upgrade and bypass 2FA — a security regression), or a GitHub
  App with delegated publish (significant operational overhead
  for a one-maintainer project). Both are bigger than the
  publishing problem they solve.
- **Remove CI publish.** Single-line change per workflow,
  zero new credential management, manual flow already proven.

The second option is the one the project has been *de facto*
living with — the policy update aligns with reality.

### Why not also remove the build/verify path?

The build path catches actual regressions: a wasm-pack version
bump that breaks the dual-package layout, a `crates/wasm/Cargo.toml`
edit that breaks `--target nodejs`, a `napi-derive` change that
breaks the platform matrix, a tree-sitter grammar change that
breaks `tree-sitter generate`. None of these are caught by `cargo
test` because they live in the npm build chain, not the Rust crate
graph. Keeping the build path on PR runs preserves a fast feedback
loop independently of the publish policy.

### Why a separate secret-cleanup PR?

Reversibility. If a downstream consumer or a forked workflow
still expects `NPM_TOKEN` to exist (e.g. someone copy-pasted the
workflow into a different repo), removing the secret without
first removing the references could surface as an opaque "secret
not found" failure across multiple workflows. Splitting the
change into "remove references" then "remove secret" gives each
step a clean revert path.

### Why not also remove the `release: [published]` trigger from these workflows?

A separate ADR (the next sequential ADR after this one) addresses
the broader problem that `release: [published]` events fired by
`GITHUB_TOKEN` do not cascade to other workflows. After this ADR,
the build/verify jobs in `npm-publish.yml`,
`npm-publish-tree-sitter.yml`, and `napi.yml` still want to run on
release tags to confirm the build-from-tag still works. They retain
the `release: [published]` trigger, which becomes useful again once
the cascade-credential ADR's PAT swap lands.

## Consequences

**Accepted:**

- Every release requires the maintainer to run `npm publish`
  commands locally per package. With `@chordsketch/wasm`,
  `@chordsketch/node` (5 platforms + meta), and
  `tree-sitter-chordpro`, that is 8 publishes per release for
  the current package set. Mitigation: the publish steps for
  napi platforms are scripted; the scripted flow takes minutes
  including OTP prompts.
- A future maintainer (if the project gains one) needs the
  `unchidev` npm account credentials or their own publish rights
  on the `chordsketch` npm org. Mitigation: npm org membership
  management is a maintainer onboarding step, documented in
  `docs/releasing.md`.
- `readme-smoke.yml` runs daily and tests `npm install` of the
  latest published version. If the maintainer forgets to run
  `npm publish` after a release, smoke goes red the same day.
  Net positive — the existing daily smoke check now serves as
  a "did you publish?" reminder.

**Gained:**

- The `NPM_TOKEN` secret leaves the threat surface (after the
  cleanup PR). A leaked CI secret no longer enables npm publish.
- 2FA OTP becomes a hard gate on every publish. An attacker who
  compromises the maintainer's GitHub account does not thereby
  gain npm publish capability.
- The maintainer sees the exact tarball contents and shasum
  printed by `npm publish` before confirming the OTP. Visible
  inspection point that CI does not provide.
- The intermittent CI publish failures stop happening.

**Mitigations:**

- `docs/releasing.md` carries the full publish checklist so
  forgetting steps is harder.
- A future "missed publish detector" can be added that compares
  the GitHub Release's tag with `npm view <pkg> version` and
  pages the maintainer if they diverge for over a day. Out of
  scope for the closing PR; tracked as a follow-up under #2274.

## Alternatives considered

1. **Switch to npm automation tokens.** Rejected — automation
   tokens bypass 2FA on the maintainer's account, which is the
   exact protection the manual flow preserves. The cure is
   worse than the disease.

2. **Switch to a GitHub App with npm integration.** Rejected
   for the same reasons as in the cascade-credential ADR's
   rationale: setup overhead exceeds benefit at the project's
   current maintainer count.

3. **Keep CI publish for existing-package version bumps,
   manual only for new packages.** Rejected — this was the
   prior policy and the 2026-04-26 incident demonstrated it
   does not match observed reliability. The policy needs to
   match what actually works, not what the granular-token
   permission model says should work.

4. **Drop the npm distribution entirely.** Rejected — npm
   reach is the project's primary surface for browser/wasm
   integrations. The CLI/binary distributions cannot replace
   it.

5. **Move `tree-sitter-chordpro` under `@chordsketch` scope
   for naming uniformity.** Rejected — see Decision step 6.
   Tree-sitter ecosystem convention is unscoped; uniformity
   would cost discoverability.

## References

- Issue #2274 — this ADR's tracking issue.
- `.github/workflows/npm-publish.yml`,
  `.github/workflows/npm-publish-tree-sitter.yml`,
  `.github/workflows/napi.yml`,
  `.github/workflows/react.yml` — the four workflow files in
  scope.
- `docs/releasing.md` — the user-facing publish checklist
  updated by this PR.
- The next ADR after this one — release event cascading via a
  non-`GITHUB_TOKEN` credential. Independent decision but
  closely related; both touch the release pipeline.
