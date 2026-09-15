# Versioning and Release Process

## Versioning Policy

All fourteen Rust crates in the workspace share the same version number and are
bumped in lockstep. This project follows [Semantic Versioning](https://semver.org/):

- **Major** (1.0.0) — breaking API changes
- **Minor** (0.2.0) — new features, backward compatible
- **Patch** (0.1.1) — bug fixes, backward compatible

### Pre-1.0: breaking changes are expected

The workspace is below `1.0.0` and is still a **validation phase** — the
formats, the public API surface, and the toolchain floor are all being
proven against real ChordPro / iReal Pro material rather than held stable
for downstream consumers.

Until `1.0.0` ships, **any release may break compatibility**, and the
project does not carry deprecation cycles or compatibility shims across
the break. Concretely, a `0.x` bump — minor *or* patch — is allowed to:

- rename, re-scope, or remove a public item in any crate (the
  `chordsketch-core` → `chordsketch-chordpro` rename in
  [v0.3.0](migration/v0.3.md) is the pattern);
- change rendered output, CLI flags, config keys, or directive
  semantics;
- change the wire shape of the WASM / NAPI / FFI bindings;
- **raise the minimum supported Rust version** (see
  [ADR-0044](adr/0044-pre-1.0-breaking-changes-are-expected.md)) — an MSRV
  raise is not treated as breaking here and does not wait for `1.0.0`.

Breaking changes are still *documented*: the CHANGELOG entry names them,
and a rename or migration large enough to need steps gets a guide under
[`docs/migration/`](migration/). What pre-1.0 buys is the freedom to make
the change at all, not the freedom to make it silently.

From `1.0.0` onward the normal Semantic Versioning contract above applies
and breaking changes wait for a major bump.

The npm package `@chordsketch/wasm` *usually* tracks the workspace version,
but is allowed to be **skewed by patch versions** when a packaging-only fix is
shipped (the WASM library code itself is unchanged but the npm wrapper needs
a bump). For example, after the dual-package fix the npm package was at
`0.1.1` while all crates remained at `0.1.0`. The wasm `version()` function
returns the **Rust crate version** (`"0.1.0"`), not the npm wrapper version,
because it is compiled into the `.wasm` binary. This skew is acceptable and
re-syncs at the next workspace-wide release.

The npm packages built on the engine — `@chordsketch/react-ui`,
`@chordsketch/react`, `@chordsketch/vue`, `@chordsketch/svelte` and
`@chordsketch/chordpro-lite` — carry the workspace version as well and publish
with every release
([ADR-0073](adr/0073-packages-built-on-the-engine-release-with-it.md)).

## Release Checklist

### Running the release

Steps 1-3 (the `Release vX.Y.Z` commit) land on `main` through a PR as
before. Everything after that — tagging, waiting for the CI publishes,
crates.io, npm and the channel rollup — is one command, run from the
maintainer's machine
([ADR-0068](adr/0068-releases-run-through-one-preflighted-script.md)).
Nothing is built or published on that machine: crates.io and npm publish
from CI too, through trusted publishing
([ADR-0069](adr/0069-crates-io-and-npm-publish-from-ci-with-trusted-publishing.md)).

```bash
git switch main && git pull --ff-only   # any up-to-date checkout of main
scripts/release.py X.Y.Z --check        # preflight only; publishes nothing
scripts/release.py X.Y.Z                # preflight, confirm, then release
```

It reads the release from a temporary worktree of the release commit —
the commit the tags point at once they exist, the tip of `origin/main`
before — so the local branch and any uncommitted changes play no part,
and a release that was tagged before the script existed can be finished
with it.

The script pushes no tag until every precondition it can check without
publishing holds, and reports every failing one at once:

- the release commit is at version `X.Y.Z`, with a dated CHANGELOG heading
  and a passing `check-version-consistency.py`;
- `ci.yml` and `publishable.yml` passed on the commit;
- no registry already serves `X.Y.Z`;
- every CI publish credential is accepted by its service —
  `.github/workflows/release-credentials.yml`, which the script dispatches,
  asks Docker Hub, the Marketplace, Open VSX, the Central Portal, CocoaPods
  trunk, GitHub, AUR and the Snap Store with read-only calls;
- `.github/workflows/publish-registries.yml` passes in `check` mode for
  the release commit, which the script dispatches alongside
  `release-credentials.yml`. It runs, on a runner, what the publish will
  run: every pending crate and npm package passes the checks every pull
  request's required `Publishable` check runs
  ([`docs/publishing-requirements.md`](publishing-requirements.md),
  [ADR-0070](adr/0070-publishability-is-checked-on-every-pull-request.md))
  — `cargo publish --dry-run` for every pending crate together, every
  `.crate` within crates.io's 10 MiB upload limit, every pending npm
  package built, packed and passing `npm publish --dry-run` with no
  warning, nothing in any package that must not be published, and, once
  the tag is out, the napi tarballs on the Release; no pending package is
  new to its registry; and crates.io and npm each hand that workflow a
  token, which they only do when the package's trusted publisher names it
  (see [Trusted publishing](#trusted-publishing)).

A failed check is reported in the terminal with the errors its jobs
annotated, so the run page only needs opening for the full log.

It then pushes `vX.Y.Z` and `desktop-vX.Y.Z`, waits for the tag runs,
dispatches `publish-registries.yml` in `publish` mode only if every
CI-published channel serves the version, waits for it, and dispatches
`release-verify.yml`. crates.io and npm go last because their versions
are permanent: a release abandoned over a CI channel leaves nothing on
them.

What the maintainer's machine needs: `git`, Python 3.11+, and `gh` logged
in with push access to the repository (which is also what dispatching
the workflows needs). No registry login, token or one-time password.

Re-running the script with the same version is always safe. It asks the
registries what is already published, so an interrupted release resumes
from what is missing, and a finished one is refused. It does not re-run a
CI channel that failed after the tag: it names the channel and stops
before crates.io and npm; re-run that channel (step 7), then re-run the
script; `publish-registries.yml` likewise skips whatever the registries
already serve. winget and MacPorts remain manual (Post-Release).

### Pre-release sanity

`scripts/release.py` runs checks 1-4 below as part of its preflight, and
checks each credential against its service rather than for presence. Check
5 is a documentation review and stays manual: do it before the bump in
Step 1. The commands below are the manual equivalents.

Before starting the bump in Step 1, verify the release-time infrastructure
is healthy. Any gap here would silently break a channel and be discovered
at post-release verification rather than before the tag is cut.

1. **Every expected secret exists.** Cross-reference
   `ci/release-channels.toml`'s `required_secrets` against the repo secret
   list:
   ```bash
   gh secret list -R koedame/chordsketch
   ```
   Every secret listed in `required_secrets` (any field) must appear.
2. **Every referenced environment exists.** The silent VS Code Marketplace
   skip happened because the `vscode-marketplace` environment was never
   created. Guard against a recurrence:
   ```bash
   gh api repos/koedame/chordsketch/environments --jq '.environments[].name'
   ```
   Every `environment:` name used in a publish job (`docker-hub`,
   `vscode-marketplace`, `pypi`, `rubygems`, `maven-central`, `crates-io`,
   `npm`) must appear in the output.
3. **`ci.yml` and `readme-smoke.yml` are green on the target commit.** The
   release workflow builds from that commit, so a red CI is a release
   blocker:
   ```bash
   gh run list --branch main --workflow ci.yml -R koedame/chordsketch --limit 1
   gh run list --branch main --workflow readme-smoke.yml -R koedame/chordsketch --limit 1
   ```
4. **The version-consistency check is green.** This catches any manifest
   that has drifted from the canonical workspace version without an
   explicit allowlist entry:
   ```bash
   python3 scripts/check-version-consistency.py
   ```
5. **Release-time documentation sync.** Run the §§1–6 cross-reference
   checks in [`.claude/rules/release-doc-sync.md`](../.claude/rules/release-doc-sync.md)
   against the release-cut commit. This catches CHANGELOG /
   `docs/releasing.md` / `CLAUDE.md` / `README.md` / binding-README /
   release-process-ADR drift before the version-bump commit lands. The
   rule's §Why documents the v0.3.0 → next-release window failure that
   motivated it.

### Checklist

1. **Update version** in every versioned manifest:

   Workspace Cargo.toml files (all fourteen crates):
   - `crates/chordpro/Cargo.toml`
   - `crates/ireal/Cargo.toml`
   - `crates/render-text/Cargo.toml`
   - `crates/render-html/Cargo.toml`
   - `crates/render-pdf/Cargo.toml`
   - `crates/render-ireal/Cargo.toml`
   - `crates/convert/Cargo.toml`
   - `crates/convert-musicxml/Cargo.toml`
   - `crates/cli/Cargo.toml`
   - `crates/wasm/Cargo.toml`
   - `crates/ffi/Cargo.toml`
   - `crates/napi/Cargo.toml`
   - `crates/lsp/Cargo.toml`
   - `crates/mcp/Cargo.toml`
   - Update inter-crate dependency `version = ` fields to match.

   Non-Rust manifests:
   - `packages/npm/package.json` (unless an allowlisted patch skew applies
     — see `ci/version-skew-allowlist.toml`)
   - `packages/vscode-extension/package.json` (once the first Marketplace
     publish has succeeded and its allowlist entry has been retired)
   - `crates/napi/package.json` — both the main package and the per-platform
     manifests under `crates/napi/npm/<triple>/package.json`
   - `packages/tree-sitter-chordpro/package.json`
   - `packages/{react-ui,react,vue,svelte,chordpro-lite}/package.json` —
     the packages built on the engine publish with every release
     ([ADR-0073](adr/0073-packages-built-on-the-engine-release-with-it.md))
   - `packages/claude-code-plugin/.claude-plugin/plugin.json` and the
     matching entry in `.claude-plugin/marketplace.json` — Claude Code
     caches plugins per version and will not re-fetch an unchanged one, so
     this bump is what makes the release's skill reach installed clients
     ([ADR-0059](adr/0059-claude-code-skill-ships-as-a-marketplace-plugin.md))

   Desktop (CLI and GUI are always in lockstep — same version number):
   - `apps/desktop/src-tauri/Cargo.toml` — `package.version`
   - `apps/desktop/src-tauri/tauri.conf.json` — top-level `"version"`
     (drives the installer metadata users see in Finder / Explorer)
   - `apps/desktop/package.json` — `version`
   - `apps/desktop/preview-handler/Cargo.toml` — `package.version`
     (the Windows preview handler DLL ships inside the same installer)
   - `packaging/flatpak/me.koeda.ChordSketch.metainfo.xml` — a new
     `<release version="X.Y.Z" date="YYYY-MM-DD">` at the top of
     `<releases>` (the Flathub listing's release history)

   Pins on the wasm packages, all `^X.Y.Z` of the version being released:
   - `@chordsketch/wasm` in `dependencies` of
     `packages/{vscode-extension,react,vue,svelte}/package.json` and in
     `peerDependencies` of `packages/ui-irealb-editor/package.json`
   - `@chordsketch/wasm-export` in `peerDependencies` of
     `packages/{react,vue,svelte}/package.json`

   Then refresh the lockfiles, after `packages/npm/package.json` carries the
   new version:
   ```bash
   for d in react-ui react vue svelte chordpro-lite ui-irealb-editor vscode-extension; do
     (cd packages/$d && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
   done
   ```
   Those lockfiles install `@chordsketch/wasm` from `packages/npm`, not
   from npm, so the release commit installs and tests against the version
   it releases before npm serves it (ADR-0073). They keep that link while
   `packages/npm`'s version satisfies the pin; `check-version-consistency.py`
   fails if a lockfile resolves it from npm instead.

   Hardcoded pins in CI:
   - `.github/workflows/readme-smoke.yml` ~line 204:
     `npm install '@chordsketch/wasm@<version>'`
   - `.github/workflows/readme-smoke.yml` ~lines 450–451:
     `chordsketch-chordpro = "^<major>.<minor>"` and the matching
     `chordsketch-render-text` pin

   Allowlist (if applicable):
   - If this release re-syncs any drift, remove the corresponding entries
     from `ci/version-skew-allowlist.toml` **and close their tracking
     issues in the same commit**. Leaving stale entries causes
     `check-version-consistency.py` to fail (which is the point — you
     can't forget).

   Sanity: run `python3 scripts/check-version-consistency.py` after the
   edit. It must exit 0 before you commit.

2. **Update CHANGELOG.md**: change `## [X.Y.Z] - Unreleased` to
   `## [X.Y.Z] - YYYY-MM-DD` and add a new `## [Unreleased]` section above.

3. **Commit** with message: `Release vX.Y.Z`

   Steps 4-7 below are what `scripts/release.py` runs. They stay here as
   the reference for what it does, and for re-running a single step by
   hand.

4. **Create and push tag**:
   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. **Wait for the release workflow**: pushing the tag triggers
   `.github/workflows/release.yml`, which builds binaries for all targets and
   creates a GitHub Release with archives attached.

6. **Publish to crates.io and npm.** `scripts/release.py` dispatches
   `publish-registries.yml` once every CI-published channel serves the
   version:
   ```bash
   V=X.Y.Z  # replace with the actual version
   gh workflow run publish-registries.yml -R koedame/chordsketch \
     -f ref=v$V -f mode=publish
   ```
   The run publishes every crate and npm package whose channel in
   `ci/release-channels.toml` carries the tag's version and is not served
   yet, so dispatching it again resumes a failed run:
   - **crates.io:** one `cargo publish` over the pending crates, which
     verifies all of them before uploading any and uploads them in
     dependency order ([crates.io Publishing Order](#cratesio-publishing-order)).
     The crates are dry-run first, because the token the job exchanges
     lasts 30 minutes.
   - **npm:** `@chordsketch/wasm`, `@chordsketch/wasm-export`,
     `tree-sitter-chordpro`, `@chordsketch/react-ui`, `@chordsketch/react`,
     `@chordsketch/vue`, `@chordsketch/svelte` and
     `@chordsketch/chordpro-lite` are built and packed on the runner; the napi
     resolver and its five platform packages come from the tarballs
     `napi.yml` put on the GitHub Release, platform packages first. Each
     tarball passes the publish checks before any is uploaded, and the job
     waits until npm serves every package it published. Every upload
     carries a provenance attestation.

7. **Run the channel rollup.** Every CI-published channel has already
   run inside the release workflow (step 5) — Docker, VS Code / Open
   VSX, napi tarballs, the Swift Package (with its CocoaPods and
   `Package.swift` updates), and the whole `post-release.yml` fan-out are
   `needs: [release]` jobs in that single run, per
   [ADR-0039](adr/0039-release-fan-out-is-an-explicit-call-graph.md).
   Nothing needs dispatching to make the release happen.

   What is left is the convergence check, and it can only run once
   step 6 has published crates.io and npm:
   ```bash
   V=X.Y.Z  # replace with the actual version
   gh workflow run release-verify.yml -f tag=v$V -R koedame/chordsketch
   ```
   `release-verify.yml` also sweeps daily at 07:00 UTC, so a forgotten
   dispatch surfaces within a day rather than never. It is expected to be
   red between the tag and the completion of step 6 — that is an
   accurate report of an unfinished release, not noise.

   To re-run a single channel against an existing tag (a failed publish,
   a rotated credential), dispatch that workflow directly:
   ```bash
   gh workflow run docker.yml           -f tag=v$V -R koedame/chordsketch
   gh workflow run vscode-extension.yml -f tag=v$V -R koedame/chordsketch
   gh workflow run post-release.yml     -f tag=v$V -R koedame/chordsketch
   gh workflow run napi.yml             -f tag=v$V -R koedame/chordsketch
   gh workflow run swift.yml            -f tag=v$V -R koedame/chordsketch
   ```
   A `docker.yml` dispatch deliberately does **not** move the `:latest`
   tag unless you tick `promote-latest`, so re-running an older tag
   cannot regress it (#1064). The `napi.yml` dispatch only re-runs the
   build matrix and re-uploads platform tarballs to the Release; it does
   not publish to npm (step 6 does that). A `swift.yml` dispatch rebuilds
   the XCFramework and **replaces** the release asset, which changes its
   SHA256; to retry only a failed CocoaPods or `Package.swift` update, re-run
   that job inside the release run instead
   (`gh run rerun <run-id> --failed -R koedame/chordsketch`).

8. **Verify each channel.** The release run from step 5 covers every
   CI-published channel, so check that first:
   ```bash
   gh run list -R koedame/chordsketch --workflow release.yml --limit 5
   ```
   Check that post-release.yml updates Homebrew, Scoop, AUR, Snap,
   and Chocolatey, and that the Swift Package jobs push to
   CocoaPods and open the `Package.swift` PR. Docker pushes to both
   GHCR and Docker Hub. VS Code publishes **8 VSIXes per release**
   (1 universal + 7 platform-specific: `linux-x64`, `linux-arm64`,
   `darwin-x64`, `darwin-arm64`, `win32-x64`, `alpine-x64`,
   `alpine-arm64`, see #1789) to both the Marketplace and Open VSX
   (if `OPEN_VSX_TOKEN` is configured). The Marketplace "Version
   History" page and a listing of release artifacts matching
   `chordsketch-*.vsix` should both show 8 entries for the new
   version.

9. **Submit winget-pkgs PR**: see "Post-Release > winget" below. This is the
   only post-release step that involves an external repo (`microsoft/winget-pkgs`).

## crates.io Publishing Order

Crates must be published in dependency order because crates.io resolves
versions from the registry, not the local workspace. The inter-crate
dependencies specify both `path` (for local development) and `version` (for
crates.io).

`publish-registries.yml` publishes them with one `cargo publish` call, which
derives this order itself and waits for each crate to be served before
uploading its dependents. The list is here to review the dependency graph
against, and for publishing a new crate's first version by hand.

Publishing order:
1. `chordsketch-chordpro` (no internal dependencies)
2. `chordsketch-ireal` (no internal dependencies)
3. `chordsketch-render-text` (depends on `chordsketch-chordpro`)
4. `chordsketch-render-html` (depends on `chordsketch-chordpro`)
5. `chordsketch-render-pdf` (depends on `chordsketch-chordpro`)
6. `chordsketch-render-ireal` (depends on `chordsketch-ireal`)
7. `chordsketch-convert-musicxml` (depends on `chordsketch-chordpro`)
8. `chordsketch-convert` (depends on `chordsketch-chordpro` + `chordsketch-ireal`)
9. `chordsketch-mcp` (depends on `chordsketch-chordpro` +
   `chordsketch-render-text` + `chordsketch-render-html`)
10. `chordsketch` (depends on 1–7 and 9; does not depend on `chordsketch-convert`)

Steps 3-7 can be published in any order among themselves. All of steps 1-7 and
step 9 must complete before step 10. Step 8 only requires steps 1-2 and is
independent of step 10.

## Distribution Channels

`koedame/chordsketch` is distributed across multiple channels. Each channel
has its own automation, secret, and verification path. The
`.github/workflows/readme-smoke.yml` workflow exercises every channel
end-to-end on a daily schedule (and on PRs that touch the README system —
ADR-0041) as the single source of truth for "is the project's promised
distribution actually working right now". It deliberately does not run at
release time: crates.io and npm are not updated until step 6 has run.

This table is the **human-readable view** of `ci/release-channels.toml`.
When adding a new channel, update both, and add what the channel requires
of an upload to [`docs/publishing-requirements.md`](publishing-requirements.md)
together with the check in `scripts/_publish_checks.py`.

| Channel | Identifier | Trigger | Required secret(s) | Verified by |
|---|---|---|---|---|
| crates.io | `chordsketch` (CLI) + 9 lib crates | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6) | none (OIDC trusted publisher, environment `crates-io`) | `cargo-install` job |
| GitHub Releases | binary archives | `release.yml` on tag push | `GITHUB_TOKEN` | `source-build` job |
| GHCR | `ghcr.io/koedame/chordsketch` | `docker.yml`, called by `release.yml` on tag push | `GITHUB_TOKEN` (push), org policy must allow public packages | `docker-ghcr` job |
| Docker Hub | `docker.io/koedame/chordsketch` | `docker.yml`, called by `release.yml` on tag push | `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | `docker-hub` job |
| npm (wasm) | `@chordsketch/wasm` | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6) | none (OIDC trusted publisher, environment `npm`) | `npm-wasm` job |
| npm (wasm-export) | `@chordsketch/wasm-export` | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6). Ships in lockstep with `@chordsketch/wasm` (#2466). | none (OIDC trusted publisher, environment `npm`) | `npm-wasm-export` job |
| npm (napi) | `@chordsketch/node` + 5 prebuilt platform packages | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6), from the platform tarballs `napi.yml` uploads to the GitHub Release. | none (OIDC trusted publisher, environment `npm`) | `napi-node` job |
| npm (tree-sitter) | `tree-sitter-chordpro` | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6) | none (OIDC trusted publisher, environment `npm`) | `npm-tree-sitter` rollup entry |
| npm (React) | `@chordsketch/react-ui` (design-system primitives, ADR-0029) + `@chordsketch/react` (component library) | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6). Versions with the workspace (ADR-0073). | none (OIDC trusted publisher, environment `npm`) | `npm-react-ui` / `npm-react` rollup entries, plus `npm-react-ui` / `npm-react` jobs in `readme-smoke.yml` that install the `latest` dist-tag daily and server-render a component (ADR-0064), plus source-side `react-ui.yml` / `react.yml` / `playground-smoke.yml`. |
| npm (Vue) | `@chordsketch/vue` | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6). Versions with the workspace (ADR-0073). | none (OIDC trusted publisher, environment `npm`) | `npm-vue` rollup entry, plus the `npm-vue` job in `readme-smoke.yml` (daily `latest` install + server render, ADR-0064) and source-side `vue.yml` / `playground-smoke.yml`. |
| npm (Svelte) | `@chordsketch/svelte` | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6). Versions with the workspace (ADR-0073). | none (OIDC trusted publisher, environment `npm`) | `npm-svelte` rollup entry, plus the `npm-svelte` job in `readme-smoke.yml` (daily `latest` install + server render, ADR-0064) and source-side `svelte.yml` / `playground-smoke.yml`. |
| npm (chordpro-lite) | `@chordsketch/chordpro-lite` | `publish-registries.yml`, dispatched by `scripts/release.py` (Step 6). Versions with the workspace (ADR-0073). | none (OIDC trusted publisher, environment `npm`) | `npm-chordpro-lite` rollup entry. No `readme-smoke.yml` job — it is not an install method under README `## Installation`. Source side: `chordpro-lite.yml` plus the unfiltered `directive-catalog-sync` job in `ci.yml`. |
| Homebrew tap | `koedame/tap/chordsketch` | `post-release.yml`, called by `release.yml` on tag push | `TAP_GITHUB_TOKEN` | `homebrew` job |
| Scoop bucket | `koedame/scoop-bucket/chordsketch` | `post-release.yml`, called by `release.yml` on tag push | `TAP_GITHUB_TOKEN` | `scoop` job |
| AUR | `chordsketch` | `post-release.yml`, called by `release.yml` on tag push | `AUR_SSH_KEY` | `aur` rollup entry |
| Chocolatey | `chordsketch` | `post-release.yml`, called by `release.yml` on tag push (windows-latest) | `CHOCOLATEY_API_KEY` | `chocolatey` rollup entry |
| Snap Store | `chordsketch` | `post-release.yml`, called by `release.yml` on tag push | `SNAP_STORE_TOKEN` | `snap` rollup entry |
| nixpkgs | `pkgs.chordsketch` | manual PR to `NixOS/nixpkgs` | none | `nixpkgs` rollup entry |
| winget | `koedame.chordsketch` | manual PR to `microsoft/winget-pkgs` (Step 9) | none (uses your `gh` token to fork+push) | `winget` job |
| MacPorts | `textproc/chordsketch` | manual PR to `macports/macports-ports` (Step 5) | none | `macports` job |
| VS Code Marketplace | `koedame.chordsketch` (1 universal + 7 platform-specific VSIXes, #1789) | `vscode-extension.yml`, called by `release.yml` on tag push | `VSCE_PAT` (PAT, Marketplace Publish scope) | `vscode-marketplace` rollup entry |
| PyPI | `chordsketch` | `python.yml` on tag push | none (OIDC trusted publisher) | `pypi` rollup entry |
| RubyGems | `chordsketch` | `ruby.yml` on tag push | none (OIDC trusted publisher) | `rubygems` rollup entry |
| Maven Central | `me.koeda:chordsketch` | `kotlin.yml` on tag push | `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `SIGNING_KEY`, `SIGNING_PASSWORD` | `maven-central` rollup entry |
| CocoaPods | `ChordSketch` | `swift.yml` (after its XCFramework `publish`), called by `release.yml` on tag push | `COCOAPODS_TRUNK_TOKEN` | `cocoapods` rollup entry |
| JetBrains Marketplace | `me.koeda.chordsketch` | manual `./gradlew publishPlugin` | `JETBRAINS_MARKETPLACE_TOKEN` | not yet automated |
| from source | `git clone` + `cargo install --path crates/cli` | always available | none | `source-build` job |
| Library Usage (Rust) | crates.io snippet from README | implicit via crates.io | none | `library-smoke` job |

## Post-Release

After the release workflow completes and the GitHub Release is published:

1. **Automatic updates** — the `post-release.yml` workflow is called by
   `release.yml` once the Release exists and automatically:
   - Updates the Homebrew formula in `koedame/homebrew-tap`
   - Updates the Scoop manifest in `koedame/scoop-bucket`

2. **Docker images** — the `docker.yml` workflow is called by
   `release.yml` once the Release exists and builds a multi-arch Docker image (linux/amd64,
   linux/arm64) pushed to **both** `ghcr.io/koedame/chordsketch` AND
   `docker.io/koedame/chordsketch`. The Docker Hub push depends on the
   `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets being present.
   ⚠️ **First-time setup**: if the Docker Hub repo `koedame/chordsketch`
   does not exist yet, create it manually (Public visibility) at
   <https://hub.docker.com/repository/create> before triggering the workflow.
   ⚠️ **Namespace ownership**: the `docker.io/koedame` namespace is owned by
   the project maintainer. If ownership is ever lost or the namespace is
   transferred to a different party, anyone running
   `docker pull docker.io/koedame/chordsketch:latest` would receive whatever
   the new owner serves. In that scenario, immediately remove the Docker Hub
   install instructions from `README.md` and stop referencing
   `docker.io/koedame/chordsketch` in `readme-smoke.yml`.

3. **npm package** — see Step 6 of the Release Checklist above. CI workflow
   only updates existing packages; first publish of any new `@chordsketch/*`
   name requires the manual local fallback (see quirks).

4. **winget submission** — submit a PR to `microsoft/winget-pkgs`:
   1. The 3 manifest files live in `packaging/winget/`. Update
      `PackageVersion` and `InstallerSha256` to match the new release. Get
      the Windows zip directly from the GitHub Release (do **not** rely on a
      local copy that might have been tampered with), then compute the
      sha256:
      ```bash
      gh release download vX.Y.Z -R koedame/chordsketch \
        -p chordsketch-vX.Y.Z-x86_64-pc-windows-msvc.zip
      sha256sum chordsketch-vX.Y.Z-x86_64-pc-windows-msvc.zip | awk '{print toupper($1)}'
      ```
      If `release.yml` ever starts publishing a checksums file alongside the
      archives, cross-check the value above against that file before
      committing it to the manifest.
   2. Fork `microsoft/winget-pkgs` (or use the existing fork). **Before
      branching, sync the fork's `master` with `microsoft/winget-pkgs:master`
      and skim `git log` for unexpected commits** — winget-pkgs is a
      high-traffic upstream and a stale or hijacked fork can quietly publish
      surprising history into your PR. Then clone with sparse checkout — the
      repo has 500K+ files and full clone exhausts filesystem inodes:
      ```bash
      git clone --filter=blob:none --no-checkout --depth 1 \
        https://github.com/<your-fork>/winget-pkgs.git
      cd winget-pkgs
      git sparse-checkout init --cone
      git sparse-checkout set manifests/k/koedame
      git checkout
      ```
   3. Copy the 3 manifest files into
      `manifests/k/koedame/chordsketch/X.Y.Z/` (the directory will not exist
      yet on the first release of a given version).
   4. Push to your fork. ⚠️ If your local SSH key is not for the same GitHub
      user that owns the fork, switch to HTTPS first:
      ```bash
      git remote set-url origin https://github.com/<your-fork>/winget-pkgs.git
      gh auth setup-git
      ```
      Note: `gh auth setup-git` writes credential-helper entries to your
      global `~/.gitconfig`. On a shared maintainer machine, scope it
      narrowly with `gh auth setup-git --hostname github.com`.
   5. Open the PR with `gh pr create -R microsoft/winget-pkgs --base master`.
   6. ⚠️ **First-time contributor**: a `microsoft-github-policy-service` bot
      will request CLA agreement via a comment. Reply on the PR with
      `@microsoft-github-policy-service agree` (no leading whitespace).
      Subsequent PRs from the same account skip this step.
   7. The validation pipeline runs in Azure DevOps. If any check is red,
      address the feedback in your fork branch and force-push.
   8. After Microsoft reviewer approves and merges, `winget install
      koedame.chordsketch` becomes available within minutes. The next
      `readme-smoke.yml` run will turn the `winget (Windows)` job green.

5. **MacPorts Portfile** — MacPorts does **not** have an automated update
   mechanism. After each release, the Portfile must be updated manually and
   submitted as a PR to `macports/macports-ports`:

   1. A reference Portfile lives at `packaging/macports/Portfile`. Update
      the `github.setup` version and the `checksums` block. To compute the
      checksums, download the source tarball that GitHub auto-generates for
      the tag:
      ```bash
      TAG=vX.Y.Z
      curl -L -o chordsketch-${TAG}.tar.gz \
        "https://github.com/koedame/chordsketch/archive/refs/tags/${TAG}.tar.gz"
      openssl dgst -rmd160 chordsketch-${TAG}.tar.gz
      openssl dgst -sha256 chordsketch-${TAG}.tar.gz
      wc -c chordsketch-${TAG}.tar.gz
      ```
   2. Regenerate the `cargo.crates` block from the **tagged** `Cargo.lock`.
      The cargo portgroup downloads each crate listed in `cargo.crates` and
      validates its checksum against the lockfile shipped inside the
      source tarball — so the right input is always
      `git show ${TAG}:Cargo.lock`, never HEAD's lockfile. Two options:
      - In-tree, no MacPorts install needed:
        ```bash
        # Bump the Portfile's `github.setup` to the new tag *first*,
        # then run the regen script — it auto-detects the tag from
        # the Portfile and reads `git show v<TAG>:Cargo.lock`.
        python3 scripts/macports-regen-cargo-crates.py --apply
        ```
        Use `--from-ref HEAD` instead when the new tag does not yet
        exist (release rehearsal against unreleased commits, or the
        release-cut PR itself bumping the Portfile inline before the
        merge → tag-push sequence). The bare `--check` form is what
        the `macports-portfile-sync` CI guard runs on every PR, so
        running it locally before pushing catches drift before CI.

        The CI guard also tolerates the **release-cut window** —
        when the auto-resolved tag does not yet exist, `--check`
        falls back to comparing against `HEAD:Cargo.lock` with a
        clear advisory note on stderr, instead of failing. This
        means a release-cut PR can bump `github.setup` and
        regenerate `cargo.crates` (against HEAD via `--apply
        --from-ref HEAD`) inline; the next normal CI run, after
        the tag is pushed, validates against the real tagged
        `Cargo.lock`. See #2413 / ADR-0012 for the rationale.
      - With MacPorts' canonical `cargo2port`
        (https://ports.macports.org/port/cargo2port/) installed, run it
        **after** checking out the tag (so `Cargo.lock` in the working
        tree is the tagged one). Its default alignment mode and the
        in-tree script produce byte-identical blocks — same column
        layout, same semver-aware ordering — so either tool keeps the
        Portfile reproducible, and a MacPorts committer regenerating
        with `cargo2port` during a version bump sees only the crates
        that actually changed rather than a reshuffle of every line.
   3. Validate the Portfile end-to-end. Trigger
      `.github/workflows/macports-smoke.yml` via `gh workflow run
      macports-smoke.yml`; it spins up a `macos-latest` runner,
      installs MacPorts from the official `.pkg`, registers the
      in-tree Portfile as a local source, and runs `port lint` plus
      `port install chordsketch` followed by the `cli-render-smoke`
      composite. A green run is the local-equivalent evidence that
      `sudo port install` works against the tagged source tarball.
      Dependencies come from the MacPorts buildbot's binary archives;
      chordsketch itself is still compiled from source, because a port
      that is not yet in the upstream tree has no archive to fetch.
   4. Fork `macports/macports-ports` (or use the existing fork), place the
      Portfile in `textproc/chordsketch/Portfile`, and open a PR.
   5. Wait for MacPorts CI and maintainer review.

6. **Automated channel rollup** — `.github/workflows/release-verify.yml`
   has `on: release: types: [published]`, but like the other publish
   workflows it does **not** auto-trigger when `release.yml` creates the
   release with `GITHUB_TOKEN` (anti-recursion rule, see Known
   Operational Quirks). Manual dispatch is included in step 7 of the
   Release Checklist. Once dispatched, it queries every registry listed
   in `ci/release-channels.toml` and appends a
   `## Channel Verification` section to the release body. Wait for that
   workflow to complete, then read the appended table on the GitHub Release
   page:

   ```bash
   gh release view vX.Y.Z -R koedame/chordsketch --web
   ```

   Every row must be green. Any ❌ is a release blocker: open a follow-up
   issue tagged with the failing channel and either fix it or mark the
   channel as an explicit `skip` in `ci/release-channels.toml` with a
   `skip_reason`. Do **not** close the release milestone until every row
   is resolved.

   Red-path dry-run: to confirm the rollup actually fails loudly when it
   should, trigger it manually with a forced-stale channel and verify the
   job turns red:

   ```bash
   gh workflow run release-verify.yml -R koedame/chordsketch \
     -f tag=vX.Y.Z -f force_stale_channel=crates-io-cli
   ```

7. **Manual verification** — confirm every documented install path works for
   end users. Easiest: trigger `readme-smoke.yml` via `workflow_dispatch` and
   confirm every job is green. `gh workflow run` does not print the run id,
   so resolve it from the workflow's most recent run before passing it to
   `gh run watch`:
   ```bash
   gh workflow run readme-smoke.yml -R koedame/chordsketch
   # The freshly triggered run can take 2-5 seconds to appear in the list
   # API. Without this pause, `gh run list --limit 1` can return the
   # *previous* run's id and you'd watch an already-completed run.
   sleep 5
   RUN_ID=$(gh run list --workflow=readme-smoke.yml -R koedame/chordsketch \
     --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch "$RUN_ID" -R koedame/chordsketch
   ```
   Spot-check from a clean machine:
   - `cargo install chordsketch && chordsketch --version`
   - `brew install --formula koedame/tap/chordsketch && chordsketch --version`
   - `docker run --rm ghcr.io/koedame/chordsketch:latest --version`
   - `docker run --rm docker.io/koedame/chordsketch:latest --version`
   - `npm install @chordsketch/wasm && node -e "import('@chordsketch/wasm').then(({version}) => console.log(version()))"`
   - `npm view @chordsketch/wasm version`
   - `winget install koedame.chordsketch && chordsketch --version` (after
     winget-pkgs PR merges)

## Required Secrets

| Secret | Scope | Purpose |
|--------|-------|---------|
| `TAP_GITHUB_TOKEN` | `contents:write` on `koedame/homebrew-tap` and `koedame/scoop-bucket` | Push updated formulae/manifests after release |
| `DOCKERHUB_USERNAME` | string | Docker Hub username under which images are pushed (currently `koedame`) |
| `DOCKERHUB_TOKEN` | Docker Hub Personal Access Token, "Read & Write" | Authenticate `docker push` against `docker.io/koedame/chordsketch` from `docker.yml` |
| `CHOCOLATEY_API_KEY` | Chocolatey Community Repository API key | Authenticate `choco push` from `post-release.yml` (windows-latest runner) |
| `AUR_SSH_KEY` | ed25519 SSH private key registered with AUR account `koedame` | Authenticate `git push` to `ssh://aur@aur.archlinux.org/chordsketch.git` from `post-release.yml` |
| `SNAP_STORE_TOKEN` | Snapcraft exported credentials (`snapcraft export-login`) | Authenticate `snapcraft upload` + `snapcraft release` from `post-release.yml` |
| `COCOAPODS_TRUNK_TOKEN` | CocoaPods trunk session token (from `~/.netrc` after `pod trunk register`) | Authenticate `pod trunk push` from `swift.yml` |
| `OPEN_VSX_TOKEN` | Open VSX personal access token (**environment secret** in `open-vsx`, not repo-level) | Authenticate `ovsx publish` from `vscode-extension.yml` |
| `FLATHUB_TOKEN` | Classic token with `public_repo`, from an account with write access to `flathub/me.koeda.ChordSketch` | Open the update pull request from `desktop-release.yml`'s `update-flathub` job. Not set until the first submission is accepted ([Flathub](#flathub-desktop-app)) |
| `GITHUB_TOKEN` | provided automatically | Used by `docker.yml` to push to GHCR, by `release.yml` to upload assets, by `npm-publish.yml` checkout |

crates.io, npm, PyPI and RubyGems need no secret: they publish through
trusted publishing ([Trusted publishing](#trusted-publishing)).

If any of these secrets are missing or wrong, the corresponding distribution
channel will silently break. The `report-failure` job in `readme-smoke.yml`
auto-creates an issue when smoke jobs fail (managed via the rolling tracking
issue titled "README install smoke tests are failing").

### Secret rotation

None of the tokens above are infinite-lived. A token that silently expires
mid-release surfaces the breakage at the worst possible time. Treat the
following as the rotation policy:

| Secret | Target cadence | Rotation UI |
|--------|----------------|-------------|
| `DOCKERHUB_TOKEN` | Every 90 days | <https://hub.docker.com/settings/security> |
| `TAP_GITHUB_TOKEN` | Every 90 days, or whenever the issuing GitHub account changes 2FA / recovery setup | <https://github.com/settings/tokens> |
| `CHOCOLATEY_API_KEY` | Only if regenerated on chocolatey.org | <https://community.chocolatey.org/account> → API Key → copy, then `gh secret set CHOCOLATEY_API_KEY` |
| `AUR_SSH_KEY` | Only if the key is compromised or the AUR account changes | <https://aur.archlinux.org/account/koedame> (replace SSH public key, then `gh secret set AUR_SSH_KEY < new_key`) |
| `SNAP_STORE_TOKEN` | Before expiry date (check current expiry with `snapcraft whoami`) | `snapcraft export-login ~/snap-token.txt && gh secret set SNAP_STORE_TOKEN < ~/snap-token.txt && rm -f ~/snap-token.txt` |
| `COCOAPODS_TRUNK_TOKEN` | Sessions last ~4 months; re-register if expired | `pod trunk register <email> <name>`, confirm email, then pipe token directly: `grep -A2 trunk.cocoapods.org ~/.netrc \| awk '/password/{print $2}' \| gh secret set COCOAPODS_TRUNK_TOKEN` |
| `FLATHUB_TOKEN` | Every 90 days, like `TAP_GITHUB_TOKEN` | <https://github.com/settings/tokens>, then `gh secret set FLATHUB_TOKEN` |
| `OPEN_VSX_TOKEN` | Only if revoked or compromised | <https://open-vsx.org/user-settings/tokens> → generate new token, then `gh secret set OPEN_VSX_TOKEN --env open-vsx` |
| `DOCKERHUB_USERNAME` | Only if the Docker Hub namespace owner changes | n/a (string, not a credential) |
| `GITHUB_TOKEN` | Provided automatically per workflow run; no rotation needed | n/a |

Procedure for any rotation:

1. Issue the new token with the **same scope** documented in the Required
   Secrets table above.
2. Update the repo secret: `gh secret set <NAME> -R koedame/chordsketch`.
3. Revoke the old token in the issuing UI.
4. Trigger a verification run and confirm the affected smoke job is green:
   ```bash
   gh workflow run readme-smoke.yml -R koedame/chordsketch
   ```

If a token must be rotated out-of-band (e.g., suspected leak), do steps 1-3
in the order listed — do **not** revoke before updating the secret, or the
next release will fail until you set the new value.

## Known Operational Quirks

These are non-obvious gotchas discovered during real publishing. They are not
derivable from the code; check this section before assuming the simple path
will work.

### Nothing keys off the `release: published` event any more

Historical note, kept because the symptom is memorable and the cause is
not visible in the workflow files.

`gh release create` run with `GITHUB_TOKEN` does not fire
`release: published` — GitHub's anti-recursion rule suppresses it. While
the downstream workflows subscribed to that event, this meant none of
them ran: discovered during the v0.2.1 release (2026-04-16), when
Homebrew, Scoop, AUR, Snap, Chocolatey, CocoaPods, Swift, Flathub and
Docker all silently did not update. ADR-0009 worked around it with a PAT
(`RELEASE_DISPATCH_TOKEN`).

Both the event and the PAT are gone now. Per
[ADR-0039](adr/0039-release-fan-out-is-an-explicit-call-graph.md) the
downstream workflows are reusable (`workflow_call`) and are invoked by
`release.yml` as `needs: [release]` jobs in the same run, so the release
event is never consulted and the token that made it fire is no longer
provisioned.

**If you are adding a publishing workflow, do not give it a `release:`
trigger.** Add a caller job for it in `release.yml` instead — that is
what gives it tag-namespace filtering and after-the-Release-exists
ordering.

### Trusted publishing cannot create a package

Neither crates.io nor npm lets a trusted publisher publish a package that
does not exist yet. crates.io refuses the upload ("Trusted Publishing
tokens do not support creating new crates"), and npm will not register a
trusted publisher for a name that has never been published, so the OIDC
exchange has nothing to match. `publish-registries.yml` names such a
package in its `plan` job and stops before building anything.

The first version of a new package is therefore published by hand; see
[Adding a package](#adding-a-package). This replaces the older quirk that
a granular `NPM_TOKEN` in CI answered `404 PUT` for new packages
(ADR-0008): no token is involved any more, but the constraint on new
packages remains, for a different reason.

### New GHCR packages are private by default

`koedame` is a GitHub **organization**. The org-level "Public packages
allowed" setting has been enabled, but **each new GHCR package is still
created Private** and must be manually flipped to Public via the package
settings page after the first push:

```
https://github.com/orgs/koedame/packages/container/<package-name>/settings
→ Danger Zone → Change visibility → Public
```

This is the bug originally reported in issue #1001: the v0.1.0 image was
pushed to GHCR successfully but anonymous pull returned `unauthorized`
because the package was still private. The `readme-smoke.yml` `docker-ghcr`
job (added in #1012) now probes the HTTP layer with an anonymous bearer
token to detect this state immediately.

The visibility flip cannot be done via `gh api` with the standard `repo` /
`workflow` token scopes — it requires `admin:packages`, which is not granted
to the maintainer's default `gh` token. So this is a manual web-UI step on
every new package.

### winget-pkgs PRs need a CLA agreement on first contribution

The first time the submitting GitHub account opens a PR to
`microsoft/winget-pkgs`, the `microsoft-github-policy-service` bot will post
a comment requesting Contributor License Agreement signing. The CLA must be
agreed by replying to the PR with:

```
@microsoft-github-policy-service agree
```

(No leading whitespace. For employer-sponsored contributions, append
`company="<name>"`.) Subsequent PRs from the same account skip this step.

### npm package version may be skewed from workspace crates version

When a packaging-only fix is needed (the WASM library code is unchanged but
the npm wrapper needs a bump — e.g., the dual-package fix for the
broken-on-Node `0.1.0` build), the npm package version is allowed to be
**skewed** from the workspace crates version. The wasm `version()` function
exposed by the package returns the **Rust crate version**, not the npm
wrapper version, because it is compiled into the binary.

`@chordsketch/wasm@0.1.0` is published-but-broken-on-Node (the
`wasm-pack --target web` build calls `fetch()` on a `file://` URL which
Node's undici does not implement). It cannot be unpublished (>24h since
publish, npm policy). The fix is to publish `0.1.1` with the dual-package
layout. The `packages/npm/README.md` banner instructs end users to install
`>=0.1.1`. **Do not try to "fix" 0.1.0** — it is permanently broken on the
registry and the only mitigation is the `>=0.1.1` recommendation.

### `packaging/winget/` already contains manifest templates — copy them, do not re-author

The repo ships winget manifest templates at:

```
packaging/winget/koedame.chordsketch.installer.yaml
packaging/winget/koedame.chordsketch.locale.en-US.yaml
packaging/winget/koedame.chordsketch.yaml
```

The release flow is to **update `PackageVersion` and `InstallerSha256` in
these templates**, then copy them into the winget-pkgs PR. Do not re-author
the manifests from scratch — the templates are tuned (per-installer
`NestedInstallerType: portable`, `PortableCommandAlias: chordsketch`, etc.)
and easy to get subtly wrong.

### `report-failure` job has been silently broken since #1004 — fixed in #1031

Historical: from `readme-smoke.yml`'s introduction (#1004) until #1031, the
`report-failure` job that is supposed to auto-create / update a tracking
issue when smoke fails was itself broken — it had no `actions/checkout` and
the `gh issue` calls failed with `fatal: not a git repository`. This means
**no auto-tracking issues were created for any failure between those two
PRs**. Going forward, expect the rolling tracking issue titled "README
install smoke tests are failing" to actually be maintained.

## Version Skew Allowlist Procedure

`ci/version-skew-allowlist.toml` declares intentional drifts between the
canonical workspace crate version and specific manifests or pins in the
repo. The `version-consistency` CI job enforces that every versioned file
either matches canonical or has an entry here. This section describes the
lifecycle of an allowlist entry.

### When to add an entry

Add an entry only when:

1. A channel is **unpublished** and its package version is intentionally
   lagging until the first publish (e.g., the VS Code Marketplace case).
2. A package needs a **patch-only bump** for a packaging-only fix while the
   underlying library remains unchanged (e.g., `@chordsketch/wasm` dual-
   package fix).
3. A CI pin references a version that is **not yet resolvable from the
   registry** (e.g., `readme-smoke.yml` caret constraints point at what
   crates.io actually serves, which lags workspace during the bump-then-
   publish window).

The `@chordsketch/wasm` and `@chordsketch/wasm-export` pins of the packages
built on them cannot lag: their lockfiles install `@chordsketch/wasm` from
`packages/npm`, which `npm ci` refuses once its version leaves the pin's
range (ADR-0073).

**Do not** add an entry to hide a legitimate mistake (forgot to bump, copy-
paste error). Fix the source instead.

### How to add an entry

1. **File a `type:tracking` issue first.** The issue body must state:
   - Which file/field is drifting and why
   - What condition retires the skew
   - The plan for the PR that performs the retirement

   Labels: `type:tracking`, `size:small`, plus `blocked` if the retirement
   is waiting on independent work (e.g., first-time Marketplace publish).

2. **Add the allowlist entry** with all required fields:
   - `file` and `field` must match the labels emitted by
     `scripts/check-version-consistency.py` for the drifting source.
     Easiest: run the script, see it fail, copy the `(file, field)` pair
     from the error message.
   - `current_value` must exactly equal the literal string the source has
     right now.
   - `reason` must explain why the skew is tolerated. Multi-line OK.
   - `expires_at` must describe the condition that retires the entry in
     human-actionable terms (e.g., "first 0.2.x crates.io publish").
   - `tracking_issue` must be the GitHub issue number from step 1. A
     missing or empty `tracking_issue` fails the check script — this is
     the guardrail that prevents forgotten skips.

3. **Verify the check now passes**:
   ```bash
   python3 scripts/check-version-consistency.py
   ```

### How to retire an entry

When a condition like "next workspace release" or "first Marketplace
publish" is met, **the same PR that fulfils the condition must also
remove the allowlist entry AND close the tracking issue**. The check
script reports stale entries (entries that no longer match any real
source) as errors, so a half-finished retirement cannot silently slip
through.

Closing the tracking issue should reference the PR that fulfils the
condition so the rationale trail is navigable.

## When to update `README.md` `## Installation`

The project's contract with end users is `README.md ## Installation`. Any
change to a documented install method is a user-visible release-blocking
event. This section is enforced via `.claude/rules/readme-sync.md`.

Specifically:

- **New channel added.** Every add requires three concurrent touches in
  the same PR:
  1. `README.md` gets a new subsection under `## Installation`.
  2. `.github/snapshots/readme-commands.txt` is regenerated via
     `python3 scripts/extract-readme-commands.py > .github/snapshots/readme-commands.txt`.
  3. A new smoke job is added to `.github/workflows/readme-smoke.yml`
     that exercises the documented command(s) against the actual binary
     produced by the install (not just `--version`; include a real render
     assertion via the `cli-render-smoke` composite action).
  4. A new `[[channels]]` entry is added to `ci/release-channels.toml`
     so the post-release rollup covers it.

- **Channel removed.** Same three touches, but each is a deletion:
  remove the README subsection, regenerate the snapshot, delete the
  smoke job, and delete the `ci/release-channels.toml` entry (or mark
  it `expected_version = "skip"` with a `skip_reason` if removal is
  temporary). A channel that stays published but stops being advertised
  under `## Installation` loses its smoke job, so it takes
  `expected_version = "exists"` rather than `"skip"`, which issues no
  request at all (ADR-0065).

- **Channel renamed.** Treat it as "remove old + add new" in the same
  PR.

Snapshot drift without corresponding smoke coverage defeats the purpose
of the rule. `readme-sync.yml` fails the PR if the snapshot is touched
without human attention, so a silent rename cannot sneak through.

## napi distribution (`@chordsketch/node`)

`@chordsketch/node` is the native Node.js addon built via napi-rs. It is
shipped as **six** npm packages in the napi-rs prebuilt-binary layout:

- `@chordsketch/node` — pure-JS resolver package that loads the right
  platform binary at runtime
- `@chordsketch/node-linux-x64-gnu`
- `@chordsketch/node-linux-arm64-gnu`
- `@chordsketch/node-darwin-x64`
- `@chordsketch/node-darwin-arm64`
- `@chordsketch/node-win32-x64-msvc`

All six must be published at the same version on every release, or the
resolver package's `optionalDependencies` will fail to install on the
affected platform. The `napi-node` rollup entry in
`ci/release-channels.toml` verifies every one of the six against the git
tag at release time.

### How it is published

`napi.yml` builds the five platform addons, stages the six tarballs with
`crates/napi/scripts/stage-release-tarballs.sh` and uploads them to the
GitHub Release. `publish-registries.yml` downloads them from the Release,
checks them, and publishes the platform packages before the resolver: the
resolver's `optionalDependencies` name the platform packages, and an
install that finds one missing silently skips it and then fails at
`require()`.

A new platform package — a sixth target — is a new npm package, so its
first version is published by hand ([Adding a package](#adding-a-package)).

### Why the decision to ship napi (vs. defer)

`crates/napi` predates the current release-discipline work: the Rust code
and the `napi build` pipeline were already in place, but no publish job
existed and no `@chordsketch/node` package had ever been claimed on npm.
During #1506 the decision was to ship rather than defer, because:

1. `@chordsketch/wasm` already serves Node.js via its `node` export
   condition, so the native addon is purely a performance improvement
   — but leaving the code unpublished creates a "code exists, no one can
   use it" state that future contributors would find confusing.
2. The first-publish-is-manual constraint is identical to the one already
   accepted for `@chordsketch/wasm`, so there is no new operational cost.
3. Registering the six package names on npm now prevents a future squat
   attack on `@chordsketch/node-*`.

If subsequent napi publishes become problematic and the maintenance cost
exceeds the value, the channel can be downgraded by flipping every napi
entry in `ci/release-channels.toml` to `expected_version = "skip"` with a
`skip_reason` — that is the supported way to pause a channel without
deleting its infrastructure.

## Trusted publishing

crates.io and npm hand a job a short-lived publish token when the job's
GitHub OIDC token matches the package's **trusted publisher**:

| Registry | Repository | Workflow | Environment |
|---|---|---|---|
| crates.io | `koedame/chordsketch` | `publish-registries.yml` | `crates-io` |
| npm | `koedame/chordsketch` | `publish-registries.yml` | `npm` |

Both environments admit only `main` (Settings → Environments → Deployment
branches and tags → Selected branches and tags → `main`), and
`publish-registries.yml` refuses a dispatch from any other ref, so a token
can only be minted for a run of the workflow as it is on `main`.

### One-time setup

Done once, when moving from the maintainer-local publish (ADR-0008) to CI.

1. **GitHub environments.** Create `crates-io` (the `npm` one exists) and
   restrict both to `main`:
   ```bash
   for env in crates-io npm; do
     gh api -X PUT repos/koedame/chordsketch/environments/$env \
       -F 'deployment_branch_policy[protected_branches]=false' \
       -F 'deployment_branch_policy[custom_branch_policies]=true'
     gh api -X POST repos/koedame/chordsketch/environments/$env/deployment-branch-policies \
       -f name=main -f type=branch
   done
   ```
2. **npm.** With npm 11.15.0 or newer, logged in as an owner with 2FA on
   the account, register every package. The first call asks for a
   one-time password; choosing "skip two-factor authentication for the
   next 5 minutes" on the npm page lets the rest go through:
   ```bash
   npm install -g npm@^11.15.0
   for package in @chordsketch/wasm @chordsketch/wasm-export tree-sitter-chordpro \
       @chordsketch/node @chordsketch/node-linux-x64-gnu @chordsketch/node-linux-arm64-gnu \
       @chordsketch/node-darwin-x64 @chordsketch/node-darwin-arm64 @chordsketch/node-win32-x64-msvc \
       @chordsketch/react-ui @chordsketch/react @chordsketch/vue @chordsketch/svelte @chordsketch/chordpro-lite; do
     npm trust github "$package" --repo koedame/chordsketch --file publish-registries.yml --env npm --allow-publish --yes
     sleep 2
   done
   ```
   npm allows one trusted publisher per package; `npm trust list <package>`
   shows it.
3. **crates.io.** Create a token at <https://crates.io/settings/tokens>
   with the `trusted-publishing` scope, then register every crate:
   ```bash
   read -rs CRATES_IO_TOKEN
   for crate in chordsketch-chordpro chordsketch-ireal chordsketch-render-text chordsketch-render-html \
       chordsketch-render-pdf chordsketch-render-ireal chordsketch-convert chordsketch-convert-musicxml \
       chordsketch-mcp chordsketch; do
     curl -fsS -X POST https://crates.io/api/v1/trusted_publishing/github_configs \
       -H "Authorization: $CRATES_IO_TOKEN" -H 'Content-Type: application/json' \
       -H 'User-Agent: chordsketch-maintainer (+https://github.com/koedame/chordsketch)' \
       -d "{\"github_config\":{\"crate\":\"$crate\",\"repository_owner\":\"koedame\",\"repository_name\":\"chordsketch\",\"workflow_filename\":\"publish-registries.yml\",\"environment\":\"crates-io\"}}"
     echo
   done
   ```
   Revoke the token afterwards; it is not needed again until a crate is
   added.
4. **Prove it.** Dispatch the check. It exchanges a token for every
   package, published or not, so a package without a matching trusted
   publisher fails by name:
   ```bash
   gh workflow run publish-registries.yml -R koedame/chordsketch -f mode=check
   ```
5. **After the first release published from CI**, close the token path:
   - crates.io: each crate's Settings → Trusted Publishing → enable
     "Trusted Publishing only".
   - npm: each package's Settings → Publishing access → "Require
     two-factor authentication and disallow tokens". Trusted publishing
     keeps working, and so does a logged-in maintainer with a one-time
     password.
   - GitHub: delete the unused `NPM_TOKEN` secret
     (`gh secret delete NPM_TOKEN -R koedame/chordsketch`).
   - Revoke any crates.io publish token and npm token left on the
     maintainer's machine.

### Adding a package

A package that has never been published cannot use trusted publishing
(see [the quirk](#trusted-publishing-cannot-create-a-package)), so its
first version goes out by hand and every later one from CI.

1. **Make the package publishable in the pull request that adds it.**
   - A crate: add it to `CRATES` in `scripts/_publish_checks.py`, give its
     `Cargo.toml` a `description`, `license`, `repository` and `readme`,
     and add it to [crates.io Publishing Order](#cratesio-publishing-order).
   - An npm package: add it to `NPM_PACKAGES` in
     `scripts/_publish_checks.py` — how it is built, any file over 1 MiB it
     ships on purpose, and a smoke snippet if Node can load it. Give the
     `package.json` a `description`, `license`, a README and
     `repository.url` in the `git+https://github.com/koedame/chordsketch.git`
     form (npm provenance requires the repository to match).
   The `Publishable` check (`publishable.yml`) picks either up from there.
2. **Add a channel entry** to `ci/release-channels.toml` and a matching
   row to the Distribution Channels table above:
   ```toml
   [[channels]]
   id = "npm-<short-name>"
   display = "npm — <package-name>"
   kind = "npm"
   package = "<package-name>"
   expected_version = "tag"
   required_secrets = []      # Trusted publishing from publish-registries.yml (ADR-0069); no stored secret.
   ```
   Every package this repository publishes carries the tag's version
   (ADR-0073); `scripts/test_publish_registries.py` fails for one that
   does not.
3. **Track its version.** A tag-versioned package goes into the Step 1
   bump list and into `scripts/check-version-consistency.py`
   (`load_all_sources()`) and the `_build_repo()` fixture of
   `scripts/test_check_version_consistency.py`; sync it with the workspace
   version or add a `ci/version-skew-allowlist.toml` entry. Regenerate any
   derived file that embeds the version (tree-sitter's `src/parser.c`).
4. **Merge the pull request.**
5. **Publish the first version by hand**, from a checkout of the merged
   commit:
   ```bash
   # a crate: a token scoped to publish-new for that crate name
   cargo publish -p <crate>
   # an npm package: logged in as an owner, with a one-time password
   cd <package-directory> && npm publish --access public
   ```
6. **Register its trusted publisher** with the command of the one-time
   setup (step 2 or 3), for that package only.
7. **Prove it** by dispatching `publish-registries.yml` in `check` mode. From then on it publishes from CI.

## First-Time Channel Setup

These procedures document how each distribution channel was initially
set up. They are needed only once per channel; subsequent releases are
automated via `post-release.yml` or dedicated publish workflows.

### AUR (Arch Linux)

Set up on 2026-04-15. Automated via `post-release.yml` `update-aur`.

1. Create an account at <https://aur.archlinux.org/register>.
   The CAPTCHA answer can be computed with:
   ```bash
   docker run --rm archlinux:latest bash -c \
     "LC_ALL=C pacman -V|sed -r 's#[0-9]+#aeb#g'|md5sum|cut -c1-6"
   ```
2. Generate an SSH key and register the public key in the AUR account:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aur_key -C "aur" -N ""
   # Paste ~/.ssh/aur_key.pub into AUR account → SSH Public Key
   ```
3. Clone the (empty) AUR package repo, generate PKGBUILD + .SRCINFO,
   and push. AUR only accepts the `master` branch:
   ```bash
   GIT_SSH_COMMAND="ssh -i ~/.ssh/aur_key" \
     git clone ssh://aur@aur.archlinux.org/chordsketch.git /tmp/aur
   cd /tmp/aur
   # Download checksums from the GitHub release
   gh release download vX.Y.Z -R koedame/chordsketch -p checksums.txt
   SHA=$(grep "x86_64-unknown-linux-gnu" checksums.txt | awk '{print $1}')
   # Generate PKGBUILD from template
   sed -e "s/{{VERSION}}/X.Y.Z/g" \
       -e "s/{{SHA256_X86_64_UNKNOWN_LINUX_GNU}}/$SHA/g" \
       packaging/aur/PKGBUILD.template > PKGBUILD
   # Generate .SRCINFO (on Arch: makepkg --printsrcinfo > .SRCINFO)
   # On non-Arch, see the heredoc in post-release.yml update-aur job
   # for the exact format, or use the docker approach:
   #   docker run --rm -v "$PWD:/pkg" archlinux:latest \
   #     bash -c "cd /pkg && makepkg --printsrcinfo > .SRCINFO"
   # Commit and push to master (AUR rejects any other branch)
   git add PKGBUILD .SRCINFO
   git commit -m "Initial upload: X.Y.Z"
   GIT_SSH_COMMAND="ssh -i ~/.ssh/aur_key" git push
   ```
4. Store the SSH private key as a GitHub secret:
   ```bash
   gh secret set AUR_SSH_KEY -R koedame/chordsketch < ~/.ssh/aur_key
   ```

### Chocolatey (Windows)

Set up on 2026-04-16. Automated via `post-release.yml` `update-chocolatey`.

The CI job runs on `windows-latest` where `choco` is pre-installed.
No local Windows machine is needed.

1. Create an account at <https://community.chocolatey.org/account/Register>.
   Confirm the email verification link.
2. Log in and copy the API key from
   <https://community.chocolatey.org/account>.
3. Store the API key as a GitHub secret:
   ```bash
   gh secret set CHOCOLATEY_API_KEY -R koedame/chordsketch
   # Paste the API key when prompted
   ```
4. The `post-release.yml` `update-chocolatey` job handles building the
   `.nupkg` from the template and pushing to the Chocolatey Community
   Repository on each release. No manual `choco push` is needed.

Both that job and `chocolatey-retry.yml` assemble the package through the
`.github/actions/chocolatey-generate-package` composite action and publish
it through `.github/actions/chocolatey-pack-push`, so the templates under
`packaging/chocolatey/` are filled the same way on both paths, and the
pre-flight feed probe, the `409 Conflict` handling, and the `403 Forbidden`
diagnosis described below apply identically to the release path. The two
callers differ only in disposition: the release job skips when
`CHOCOLATEY_API_KEY` is unset and downgrades a `403` to a warning, so a
moderation queue that has not drained cannot fail a release that already
published to the other seven registries. The retry workflow fails on both,
because pushing is the only thing it does.

#### Retrying a failed Chocolatey push

Use the standalone `chocolatey-retry.yml` workflow whenever
`update-chocolatey` did not publish this version. That job downgrades a
`403 Forbidden` to a warning (see above), so the typical trigger is a
**green** `update-chocolatey` job carrying a `::warning::` annotation —
not a failed one. `update-chocolatey` itself only turns red for a
genuine `choco pack` failure or a push refused for a reason other than
`403`/`409`; check the job's annotations either way, since a `403`
warning means the version was never pushed even though the job
succeeded:

```bash
gh workflow run chocolatey-retry.yml -R koedame/chordsketch -f tag=vX.Y.Z
```

The annotation is no longer the only thing that notices. The daily
`release-verify.yml` rollup asks the Chocolatey v2 feed about the released
version and reports one of three states, so a `403` that nobody read at
release time surfaces on the next sweep with this same dispatch command in
its failure detail ([ADR-0049](adr/0049-chocolatey-rollup-reports-pending-as-its-own-verdict.md)):

| Rollup row | Meaning | What to do |
|---|---|---|
| `✅ OK` | installable via `choco install` | nothing |
| `⏳ PENDING` | pushed, waiting on community moderation (28-54 days per release) | nothing — no action here can clear it |
| `❌ FAIL` | the repository does not have it | run the dispatch above once the queue drains |

This re-runs only the pack-and-push steps and does not re-trigger the
other 4 post-release jobs (AUR, Snap, Homebrew, Scoop), avoiding
duplicate side effects.

The workflow is safe to dispatch repeatedly. It checks the Chocolatey
v2 feed before pushing and exits successfully when the version is
already on the repository, and it treats a `409 Conflict` from the push
the same way, so re-running it after a push that actually landed does
not produce a red run.

A failure on `chocolatey-retry.yml` itself names the HTTP status: `403
Forbidden` means an earlier version is still queued for moderation and
is blocking this one; wait for it to clear and dispatch again (this
workflow, unlike `update-chocolatey`, fails rather than warns on a
`403` — see above).

Read the queue state from
`community.chocolatey.org/packages/chordsketch/<version>` under
**Package Status** — `Submitted` means still queued. Do not read the
review-timeline badge instead: it says `Ready for review`, which looks
like an approval but is the pre-approval state, and misreading it sent
the #1852 investigation down the wrong path once already.

### Snap Store

Set up on 2026-04-15. Automated via `post-release.yml` `update-snap`.

Uses **strict confinement** with `home` + `removable-media` plugs
(classic confinement requires Snap Store manual review and is not
needed for a file-processing CLI).

> **Note:** The `removable-media` plug is not auto-connected by default.
> Users who need to process files on USB drives must run:
> `sudo snap connect chordsketch:removable-media`

1. Create an Ubuntu One account at <https://login.ubuntu.com>.
2. Export login credentials:
   ```bash
   snapcraft export-login ~/snap-token.txt
   ```
3. Register the snap name:
   ```bash
   SNAPCRAFT_STORE_CREDENTIALS="$(cat ~/snap-token.txt)" \
     snapcraft register chordsketch
   ```
4. Build and upload the snap:
   ```bash
   mkdir -p /tmp/snap-build/stage /tmp/snap-build/snap
   cd /tmp/snap-build
   # Download and extract the prebuilt binary
   gh release download vX.Y.Z -R koedame/chordsketch \
     -p "chordsketch-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz"
   tar xzf chordsketch-vX.Y.Z-*.tar.gz --strip-components=1 -C stage
   chmod +x stage/chordsketch
   # Generate snapcraft.yaml from template
   sed -e "s/{{VERSION}}/X.Y.Z/g" \
     packaging/snap/snapcraft.yaml.template > snap/snapcraft.yaml
   # Build and upload
   snapcraft --destructive-mode
   SNAPCRAFT_STORE_CREDENTIALS="$(cat ~/snap-token.txt)" \
     snapcraft upload chordsketch_X.Y.Z_amd64.snap --release=stable
   ```
5. Store the credentials as a GitHub secret and clean up:
   ```bash
   gh secret set SNAP_STORE_TOKEN -R koedame/chordsketch < ~/snap-token.txt
   rm -f ~/snap-token.txt
   ```

### CocoaPods

Set up on 2026-04-15. Automated via `swift.yml` `update-cocoapods`, which
runs after that workflow's `publish` job has uploaded the XCFramework the
podspec downloads during `pod trunk push` validation.

The pod ships a prebuilt XCFramework (same artifact as the Swift package).

1. Install CocoaPods: `gem install cocoapods`
2. Register a trunk session:
   ```bash
   pod trunk register <email> <name>
   # Click the confirmation link in the email
   ```
3. Generate and push the podspec:
   ```bash
   sed -e "s/{{VERSION}}/X.Y.Z/g" \
     packaging/cocoapods/ChordSketch.podspec.template > ChordSketch.podspec
   pod trunk push ChordSketch.podspec --allow-warnings
   ```
4. Store the trunk token as a GitHub secret. The token is in `~/.netrc`.
   Pipe it directly to avoid leaking the value into shell history:
   ```bash
   grep -A2 trunk.cocoapods.org ~/.netrc | awk '/password/{print $2}' \
     | gh secret set COCOAPODS_TRUNK_TOKEN -R koedame/chordsketch
   ```

### Open VSX Registry

Set up on 2026-04-17. Automated via `vscode-extension.yml` publish job.

The VS Code extension is published to both the VS Code Marketplace and
the Open VSX Registry. Open VSX requires a separate account and token.

1. Sign in at <https://open-vsx.org> with your GitHub account.
2. Generate a personal access token at
   <https://open-vsx.org/user-settings/tokens>.
3. Create a namespace matching the VS Code publisher name, using the token
   from the previous step:
   ```bash
   npx ovsx create-namespace koedame -p <token-from-step-2>
   ```
4. Store the token as an **environment secret** (not repo-level):
   ```bash
   gh secret set OPEN_VSX_TOKEN --env open-vsx -R koedame/chordsketch
   # Paste the token when prompted
   ```
   The `open-vsx` environment must already exist at
   <https://github.com/koedame/chordsketch/settings/environments>.
5. The `vscode-extension.yml` `Publish to Open VSX Registry` job
   handles publishing on each release. No manual `ovsx publish` needed.

### Flathub (desktop app)

Not submitted yet. The manifest, metainfo and checks are in
`packaging/flatpak/`
([ADR-0074](adr/0074-the-desktop-app-is-built-for-flathub-from-source.md)).
The submission has to be made by a maintainer: Flathub's
[generative AI policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy)
does not allow AI tools to open or write submission pull requests, and
requires disclosing AI-generated code and packaging in the submission.

1. Release a desktop version that contains `packaging/flatpak/`. Flathub
   builds a tag, and the metainfo and desktop file are installed from it.
2. Write the submission files for that tag:
   ```bash
   python3 -m pip install -r packaging/flatpak/requirements.txt
   TAG=desktop-vX.Y.Z
   packaging/flatpak/prepare.py --out flathub-submission \
     --git-tag "$TAG" --git-commit "$(git rev-parse "$TAG^{commit}")"
   ```
3. Build, run and lint them as `packaging/flatpak/README.md` describes,
   using `flathub-submission/me.koeda.ChordSketch.yml`.
4. Fork <https://github.com/flathub/flathub> with *Copy the master branch
   only* unchecked, then:
   ```bash
   git clone --branch=new-pr git@github.com:<you>/flathub.git && cd flathub
   git checkout -b me.koeda.ChordSketch new-pr
   cp ../flathub-submission/* .
   git add . && git commit && git push -u origin me.koeda.ChordSketch
   ```
5. Open the pull request against the **`new-pr`** branch in the GitHub web
   interface, titled `Add me.koeda.ChordSketch`, and fill in its template,
   including the AI disclosure. Reviewers start a test build with
   `bot, build`.
6. Once it is merged, Flathub creates `flathub/me.koeda.ChordSketch` and
   invites you. Create a classic token with the `public_repo` scope from
   the account Flathub invited, and store it:
   `gh secret set FLATHUB_TOKEN -R koedame/chordsketch`. From the next
   release, `desktop-release.yml`'s `update-flathub` job opens the update
   pull request; install the test build Flathub links from it, then merge.
7. Verify the app on the Flathub developer portal, which asks for a token at
   `https://koeda.me/.well-known/org.flathub.VerifiedApps.txt`.
8. Add the channel to `ci/release-channels.toml` and the
   [Distribution Channels](#distribution-channels) table.
