# 0069. crates.io and npm publish from CI with trusted publishing

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

ADR-0068 made the release one script, `scripts/release.py X.Y.Z`. It
pushes the tags, waits for every CI-published channel to converge, and
then publishes crates.io and npm **from the maintainer's machine**, as
ADR-0008 requires. Those two registries were the only part of a release
that still needed the maintainer at a terminal: a crates.io token in
`~/.cargo/credentials.toml`, an `npm login` session, and a one-time
password for each npm package. For 0.6.0 that was 10 crates and 9 npm
packages in one sitting, plus the framework packages
(`@chordsketch/react`, `react-ui`, `vue`, `svelte`, `chordpro-lite`) on
their own cadence.

ADR-0008 kept npm local for two reasons that no longer hold:

1. **CI could not publish reliably.** The CI path authenticated with a
   granular access token (`NPM_TOKEN`), which returned `404 PUT` on
   new packages and, intermittently, on existing ones.
2. **The only CI alternative bypassed 2FA.** An automation token would
   have removed the one-time password that guards every publish.

Both registries have since shipped trusted publishing: the CI job
proves its identity with a GitHub OIDC token, and the registry hands it
a credential scoped to that one job. There is no stored secret to leak,
expire or lose permissions. Meanwhile npm's own policy moved away from
the model ADR-0008 was written against.

### npm, as of 2026-09

- Classic tokens were permanently revoked on 2025-12-09. `npm login`
  now yields a two-hour session, and publishing with it enforces 2FA.
  Granular write tokens live at most 90 days. npm recommends trusted
  publishing for CI.
  ([changelog](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/))
- Trusted publishing needs npm CLI ≥ 11.5.1 and Node ≥ 22.14.0, and runs
  on GitHub-hosted runners only. A trusted publisher names a repository,
  a workflow **filename** and an optional environment, and the registry
  currently accepts one per package. ([docs](https://docs.npmjs.com/trusted-publishers),
  [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/))
- `npm publish` asks GitHub for an OIDC token with the audience
  `npm:registry.npmjs.org` and exchanges it at
  `/-/npm/v1/oidc/token/exchange/package/<name>` before uploading
  (`lib/utils/oidc.js` in `npm/cli`). The exchange succeeds only when the
  package's trusted publisher matches the job.
- When the workflow is reusable, npm matches the **calling** workflow's
  filename, and both workflows need `id-token: write`.
- Publishing through it from a public repository emits a provenance
  attestation automatically. Every published package's `repository.url`
  is already `git+https://github.com/koedame/chordsketch.git`, which
  provenance requires.
- The package must already exist. Neither the web settings nor
  `npm trust github` (npm ≥ 11.15.0, which configures trusted publishers
  from the CLI and requires `--allow-publish`) accepts a name that has
  never been published, and first publish over OIDC is an open request
  ([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
- The package setting "Require two-factor authentication and disallow
  tokens" leaves trusted publishing working, and still lets a logged-in
  maintainer publish with a one-time password.

### crates.io, as of 2026-09

Read from the registry's source (`rust-lang/crates.io`,
`src/controllers/trustpub/` and `src/controllers/krate/publish.rs`) as
well as its [documentation](https://crates.io/docs/trusted-publishing):

- The job exchanges its OIDC token (`rust-lang/crates-io-auth-action`)
  for a token that **expires after 30 minutes** and is revoked when the
  job ends.
- One exchange yields one token valid for **every crate** whose
  configuration matches the repository, the workflow filename and the
  environment. A workspace needs one exchange, not ten.
- The filename is taken from `workflow_ref`, which for a reusable
  workflow is the caller's — the same rule as npm.
- Publishing a crate that does not exist yet with such a token is
  refused: "Trusted Publishing tokens do not support creating new
  crates. Publish the crate manually, first".
- `pull_request_target` and `workflow_run` events are refused.
  `workflow_dispatch` and `push` are accepted.
- A crate accepts up to 5 GitHub configurations. Configurations can be
  created through the API (`POST /api/v1/trusted_publishing/github_configs`)
  with a token carrying the `trusted-publishing` scope, so ten crates
  do not mean ten trips through the web UI.
- An owner can set a crate to "Trusted Publishing only", which rejects
  API-token publishes of new versions. It does not affect creating a new
  crate.

### Where each package stands

Registry state checked anonymously on 2026-09-15, after 0.6.0. Every
crate is owned by the `unchidev` user and every npm package is
maintained by `unchidev`.

| Registry | Package | Newest published | Can move |
|---|---|---|---|
| crates.io | `chordsketch-chordpro` | 0.6.0 | yes |
| crates.io | `chordsketch-render-text` | 0.6.0 | yes |
| crates.io | `chordsketch-render-html` | 0.6.0 | yes |
| crates.io | `chordsketch-render-pdf` | 0.6.0 | yes |
| crates.io | `chordsketch-ireal` | 0.6.0 | yes |
| crates.io | `chordsketch-render-ireal` | 0.6.0 | yes |
| crates.io | `chordsketch-convert` | 0.6.0 | yes |
| crates.io | `chordsketch-convert-musicxml` | 0.6.0 | yes |
| crates.io | `chordsketch-mcp` | 0.6.0 (first published by hand in the 0.6.0 release) | yes |
| crates.io | `chordsketch` | 0.6.0 | yes |
| npm | `@chordsketch/wasm` | 0.6.0 | yes |
| npm | `@chordsketch/wasm-export` | 0.6.0 | yes |
| npm | `tree-sitter-chordpro` | 0.6.0 | yes |
| npm | `@chordsketch/node` | 0.6.0 | yes |
| npm | `@chordsketch/node-linux-x64-gnu` | 0.6.0 | yes |
| npm | `@chordsketch/node-linux-arm64-gnu` | 0.6.0 | yes |
| npm | `@chordsketch/node-darwin-x64` | 0.6.0 | yes |
| npm | `@chordsketch/node-darwin-arm64` | 0.6.0 | yes |
| npm | `@chordsketch/node-win32-x64-msvc` | 0.6.0 | yes |
| npm | `@chordsketch/react` | 0.4.0 | yes |
| npm | `@chordsketch/react-ui` | 0.1.0 | yes |
| npm | `@chordsketch/vue` | 0.1.0 | yes |
| npm | `@chordsketch/svelte` | 0.1.0 | yes |
| npm | `@chordsketch/chordpro-lite` | 0.1.0 | yes |

All 24 packages exist, so all of them can publish from CI once their
trusted publishers are registered. Only packages added later need one
publish by hand.

The repository already publishes this way elsewhere: `python.yml`
(PyPI) and `ruby.yml` (RubyGems) authenticate with OIDC.

## Decision

1. **crates.io and npm publish from one workflow,
   `.github/workflows/publish-registries.yml`.** Its only trigger is
   `workflow_dispatch`, with these inputs:
   - `ref` — the tag or commit to publish from, or empty for `main`
   - `set` — `workspace` (the crates and npm packages whose channel in
     `ci/release-channels.toml` carries the tag's version) or one
     framework package name
   - `mode` — `check` or `publish`

   Every trusted publisher on both registries names this filename. The
   logic lives in `scripts/publish-registries.py`, which reuses the
   pull-request publish checks of `scripts/_publish_checks.py`
   (ADR-0070).
2. **The workflow is never called from another workflow.** Both
   registries match the calling workflow's filename. Calling it from
   `release.yml` would mean registering `release.yml`, which runs on every
   `v*` tag push, before the release script has seen CI converge
   (ADR-0068 Decision 4).
3. **Two environments, `crates-io` and `npm`, gate the publish jobs, and
   both admit only `main`.** The trusted publishers name these
   environments, so a run of the workflow as it exists on any other ref
   cannot mint a token. The workflow is always dispatched from `main`;
   `ref` only selects what it checks out, and the workflow refuses a
   dispatch from anywhere else before building. The `npm` environment
   already exists, but no workflow references it today: its
   `environment:` block was removed from `npm-publish.yml` and
   `npm-publish-tree-sitter.yml` in #1791, because a failed publish left
   a permanent "failure" deployment entry on the Deployments page and
   `NPM_TOKEN` was a repo-level secret the block did not gate. This
   workflow re-attaches it for a different reason — the environment name
   is what a trusted-publisher configuration matches, not a secret
   scope — so the old cosmetic issue applies again: a failed run leaves a
   "failure" deployment entry.
4. **`mode: check` answers everything `mode: publish` will need, for
   every package of the set, without uploading.** `scripts/release.py`'s
   preflight dispatches it for the release commit (the tag, once pushed)
   in parallel with `release-credentials.yml` and requires it to succeed:
   - A package of the set that has never been published fails the run by
     name: it cannot publish from CI (Decision 8).
   - Every crate passes the pull-request checks, including one
     `cargo publish --dry-run` over all of them, and the job exchanges a
     crates.io token once, so a missing or mismatched configuration fails
     here.
   - Every npm package is built, packed and checked as a pull request
     does; the napi tarballs are downloaded from the Release and checked
     when the tag is already out. Then the job's OIDC token is exchanged
     at `/-/npm/v1/oidc/token/exchange/package/<name>` for each package,
     the call `npm publish` makes, so a package without a matching
     trusted publisher fails here, by name.

   The exchanged tokens are never used and expire or are revoked on their
   own. Covering the whole set, not only the unpublished versions, lets a
   check prove the setup between releases. Each problem is written as a
   workflow annotation, which `release.py` reads back so the maintainer
   sees the reason in the terminal.
5. **`mode: publish` replaces the local crates.io and npm publish in
   `release.py`.** The script still waits for every CI channel to
   converge, then dispatches the workflow for the release tag and waits
   for it. The workflow covers only what the registries do not serve yet,
   so a re-dispatch resumes, and the registries stay the only state
   (ADR-0068 Decision 5).
   - **crates.io job:** the pull-request checks and
     `cargo publish --dry-run` over the pending crates first, so the
     build happens outside the token's 30 minutes. Then
     `crates-io-auth-action`, then one `cargo publish` with every pending
     `-p`. No build cache is restored into the job.
   - **npm job:** npm 11 on Node 22, `id-token: write`, no `registry-url`
     and no `NODE_AUTH_TOKEN`. Every pending tarball passes the checks
     before any is uploaded, and the uploaded tarball is the one checked.
     The napi platform packages come from the GitHub Release assets that
     `napi.yml` already uploads, published before the resolver. The job
     waits until npm serves every package it published, since npm accepts
     an upload before it serves it.
6. **The framework packages use the same workflow.** A dispatch from
   `main` with `set: @chordsketch/react` (or another framework package)
   replaces the local publish steps in `docs/releasing.md`.
7. **After the first CI release publishes cleanly, token publishing is
   closed.** Every crate is set to "Trusted Publishing only" and every
   npm package to "Require two-factor authentication and disallow
   tokens", and the unused `NPM_TOKEN` secret is deleted. The maintainer's
   local path stays open only where it is still needed: publishing a new
   package for the first time, with a crates.io token scoped to
   `publish-new`, or an `npm login` session and a one-time password.
8. **Adding a package is: publish once by hand, then register its
   trusted publisher.** For npm, run `npm trust github <name> --repo
   koedame/chordsketch --file publish-registries.yml --env npm
   --allow-publish`. For crates.io, add the configuration in the crate's
   settings or through the API. `docs/releasing.md` "Adding a package"
   carries both, and `mode: check` names any package that skipped the
   first step.

## Rationale

ADR-0008's first reason was that CI publishing was unreliable because a
stored token's permissions could not be observed. Trusted publishing
has no stored token. Its failure modes are configuration mismatches,
which the exchange reports by name — and Decision 4 triggers that report
before the tag, not at upload.

ADR-0008's second reason was 2FA. What 2FA protected was "a leaked
credential cannot publish". Trusted publishing keeps that property, and
more strongly, because there is no long-lived credential at all. What
changes is who can publish: anyone who can dispatch
`publish-registries.yml` on `main`, with its environment. Decisions 2, 3
and 7 keep that set to the repository's maintainers. Provenance
attestations make every npm publish traceable to a commit and a workflow
run, which the local path never did.

Keeping the check and publish modes in one workflow is forced by the
registries, not chosen for tidiness. A token exchange succeeds only from
the registered filename and environment, so the only place that can
prove the publish will authenticate is the publish workflow itself.

Admitting only `main` to the environments, rather than `main` and `v*`
tags, costs nothing: the workflow checks out the tag it is given. It
removes a path where a tag cut from an old commit would run an old copy
of the workflow with a token.

The dry run ahead of the crates.io exchange exists because the token
lasts 30 minutes and `cargo publish` verifies every pending crate before
uploading the first. The dry run fills the target directory for the real
run. If a cold verify of all ten crates ever approaches 30 minutes, the
uploads near the end would fail with an expired token. A re-dispatch
would resume from them, but the job should not rely on that.

## Consequences

- A release needs no crates.io token, no npm login and no one-time
  password. `release.py` only needs `gh` with permission to push tags and
  dispatch workflows, so it can run from any machine.
  `crates/napi/scripts/local-publish.sh` is removed.
- One-time setup, by the maintainer (`docs/releasing.md`, "Trusted
  publishing"):
  - GitHub: create the `crates-io` environment, and restrict both
    environments to `main`.
  - npm: with npm ≥ 11.15.0, run `npm trust github` once per package
    (14 packages, account 2FA required).
  - crates.io: create a token with the `trusted-publishing` scope, and
    create the 10 configurations with it.
  Until that is done, the release preflight fails at the check and names
  every package that is not registered, so no tag can be pushed.
- `mode: check` adds one more dispatched workflow to the preflight, on
  top of `release-credentials.yml`. The crates.io check proves that a
  configuration exists for this workflow. It cannot show which crates
  that configuration covers — the exchanged token does not reveal its
  crates, and listing configurations requires an owner's token. A crate
  missing its configuration fails at upload, after the crates it depends
  on. A re-dispatch resumes from it once it is registered.
- A new package still needs the maintainer once (Decision 8). Both
  registries require an existing package before a trusted publisher can
  be attached. Watch for npm/cli#8544 and a crates.io equivalent: if
  either lands, Decision 8 reduces to "register before the first
  release".
- ADR-0008 is superseded. Its Decision 6 (the scoped vs. unscoped package
  names) is unaffected and stays in force.
- ADR-0068 stands, except that the crates.io and npm publish it
  describes as local now runs in this workflow, and its preflight checks
  those registries through `mode: check` instead of a local token, login
  and dry run.

## Alternatives considered

- **Stay local (ADR-0008 as is).** Every release keeps needing the
  maintainer at a terminal for up to 24 publishes. npm's move to
  two-hour sessions makes a long CI wait more likely to outlast the
  login, which `release.py` already had to work around.
- **CI with granular tokens.** npm write tokens now expire within 90
  days, and "bypass 2FA" must be enabled for CI. That combines the
  expiring-secret failure ADR-0068 was written about with the 2FA bypass
  ADR-0008 rejected.
- **Publish from `release.yml` on the tag push.** No dispatch step would
  be needed, but the publish would run before the release script's
  convergence gate. The crates of an abandoned version are permanent
  (ADR-0068 Decision 4).
- **Separate workflows for crates.io and npm.** They would register
  different filenames, but the check-and-publish contract is the same
  for both. Splitting doubles the dispatch and wait logic in `release.py`
  without narrowing who can publish.
- **A `check` that covers only the unpublished versions.** It would build
  less on a resumed release, but between releases it would have nothing
  to exchange a token for, so a trusted-publisher setup could not be
  proven until the next release's preflight.
- **A placeholder `0.0.0` publish to bootstrap new packages from CI.**
  That still needs a token for the placeholder, and it leaves a
  meaningless version on the registry forever.

## References

- ADR-0008 — npm publishing is a maintainer-local manual operation
  (superseded by this ADR; Decision 6 stands)
- ADR-0068 — releases run through one preflighted script
- ADR-0070 — publishability is checked on every pull request
- ADR-0039 — release fan-out is an explicit `workflow_call` graph
- `.github/workflows/publish-registries.yml`,
  `scripts/publish-registries.py`, `scripts/test_publish_registries.py`
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers
- `npm trust`: https://docs.npmjs.com/cli/v11/commands/npm-trust/
- npm classic token revocation (2025-12-09):
  https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
- crates.io trusted publishing: https://crates.io/docs/trusted-publishing
- crates.io enforcement mode and blocked triggers:
  https://blog.rust-lang.org/2026/01/21/crates-io-development-update
- First publish over OIDC (npm): https://github.com/npm/cli/issues/8544
