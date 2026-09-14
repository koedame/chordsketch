# Publishing requirements

What each distribution channel requires before it accepts an upload, and
which check proves it on every pull request.

A release reaches every channel in `ci/release-channels.toml`. Each of
them can refuse an upload for a reason that was knowable long before the
release: crates.io refused `chordsketch-render-pdf` 0.6.0 for being over
its size limit, and the VS Code Marketplace publish job failed on a build
step no pull request ran. A package that cannot be published is treated
as a defect of the same weight as a security issue, so these conditions
are checked on every pull request, every push to `main` and nightly
([ADR-0070](adr/0070-publishability-is-checked-on-every-pull-request.md)).

## How the checks run

| Where | What runs | When |
|---|---|---|
| [`publishable.yml`](../.github/workflows/publishable.yml) | `scripts/check-publishable.py` | every pull request, push to `main`, nightly. Its `Publishable` job is a required status check. |
| [`scripts/release.py`](../scripts/release.py) preflight | the same functions, against the release commit | before the tag is pushed, and before crates.io / npm are published |
| [`napi.yml`](../.github/workflows/napi.yml) `upload-release-tarballs` | `scripts/check-publishable.py napi` | at release time, against the real prebuilt addons, before the tarballs are uploaded |

Every condition below is implemented once, in
[`scripts/_publish_checks.py`](../scripts/_publish_checks.py). The
release preflight imports it rather than keeping its own copy, and
`release.py` refuses to start unless `publishable.yml` passed on the
release commit.

**A warning from a publish tool is a failure.** `cargo publish` warned
that a `Cargo.lock` entry was yanked, and `npm publish` warned that it had
rewritten `repository.url` in four packages; both were ignored because
they were only warnings. The only warnings tolerated are the two cargo
prints on every dry run of a version that is already on crates.io
(`already exists on crates.io index`, `aborting upload due to dry run`) —
every pull request between releases is such a dry run.

### Adding a package

1. Add the channel to `ci/release-channels.toml`.
2. Add the package to `CRATES` or `NPM_PACKAGES` in
   `scripts/_publish_checks.py`. `scripts/test_publish_checks.py` fails
   until the two agree.
3. If it legitimately ships a file over 1 MiB, declare that file in its
   `large_files`.

## Rules for every package

These apply to every artifact any channel receives.

| Condition | Why | Checked by |
|---|---|---|
| No file matching `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.git/`, `node_modules/`, `target/` | Credentials and build debris must never be published; nothing can be taken back from a registry | `content_problems` |
| No file containing a private key or a GitHub, npm, crates.io, PyPI, RubyGems, AWS or Slack token | Same | `content_problems` |
| No file over 1 MiB unless it is declared in the package's `large_files` | The 0.6.0 render-pdf crate carried test PDFs; an undeclared large file fails on the pull request that adds it, before any registry limit is reached. A declaration that matches no packed file also fails. | `content_problems` |
| The publish dry run prints no unexpected warning | See above | `tool_warnings` |

## crates.io

Published by `scripts/release.py` from the maintainer's machine
([ADR-0008](adr/0008-npm-publishing-is-local.md) covers the local publish
model). Crates: every `kind = "crates-io"` channel in the manifest.

| Condition | Source | Checked by |
|---|---|---|
| The `.crate` is at most 10 MiB; crates.io answers HTTP 413 otherwise | [Cargo: publishing](https://doc.rust-lang.org/cargo/reference/publishing.html) | `crate_size_problems` on the file `cargo package` wrote |
| `description`, `license` (or `license-file`), `repository` and `readme` are set, and the readme is inside the packaged crate | [Cargo: publishing](https://doc.rust-lang.org/cargo/reference/publishing.html) | `crate_metadata_problems`, `crate_readme_problems` |
| The crate does not set `publish = false` | [Cargo: the manifest](https://doc.rust-lang.org/cargo/reference/manifest.html#the-publish-field) | `crate_metadata_problems` |
| Every dependency has a version requirement and comes from crates.io; no path-only or git dependency | [Cargo: specifying dependencies](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#multiple-locations) | `cargo publish --dry-run` fails |
| Workspace crates that depend on each other resolve at the version being released | [Cargo: `cargo publish`](https://doc.rust-lang.org/cargo/commands/cargo-publish.html) (multi-package publish, Cargo 1.90+) | one `cargo publish --dry-run -p …` over every crate |
| No `Cargo.lock` entry is yanked | [Cargo: `cargo package`](https://doc.rust-lang.org/cargo/commands/cargo-package.html) | the dry run's `is yanked` warning |
| The packaged crate — not the workspace — builds | [Cargo: `cargo publish`](https://doc.rust-lang.org/cargo/commands/cargo-publish.html) (verification step) | `cargo publish --dry-run` |
| The version is not already on crates.io | [Cargo: publishing](https://doc.rust-lang.org/cargo/reference/publishing.html) ("a version can never be overwritten") | release preflight only (`decide` in `release.py`); between releases every pull request is at a published version |

## npm

Published by `scripts/release.py` from the maintainer's machine
([ADR-0008](adr/0008-npm-publishing-is-local.md)): `@chordsketch/wasm`,
`@chordsketch/wasm-export`, `tree-sitter-chordpro` and `@chordsketch/node`
with its five platform packages on the release tag;
`@chordsketch/react-ui`, `@chordsketch/react`, `@chordsketch/vue`,
`@chordsketch/svelte` and `@chordsketch/chordpro-lite` on their own
cadence. Every one of them is checked on every pull request, whatever its
cadence.

| Condition | Source | Checked by |
|---|---|---|
| `name` and `version` are valid, and `name@version` is unique | [npm: package.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#name) | `npm publish --dry-run`; uniqueness in the release preflight only |
| npm does not rewrite `package.json` while publishing (for example `repository.url` must be `git+https://…`) | [npm: package.json `repository`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#repository) | the dry run's `auto-corrected some errors` warning. The dry run runs on the unpacked tarball, because npm only normalises a directory publish. |
| `description`, `license` and `repository` are set, and a README is packed | [npm: package.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-json) | `npm_manifest_problems` |
| Every file `main`, `module`, `types`, `bin` and `exports` point at is inside the tarball | [npm: package.json `files`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#files) (a missing file is silently left out) | `npm_manifest_problems` |
| Every dependency resolves from the registry: no `file:`, `link:`, `workspace:`, git or URL spec, and some published version satisfies every range, unless it pins a package released in the same release at that exact version | [npm: package.json dependencies](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#dependencies) | `npm_dependency_problems` |
| The packed tarball installs into an empty project and loads | — | `npm_smoke_problems` for `@chordsketch/wasm`, `@chordsketch/wasm-export`, `@chordsketch/chordpro-lite` and `@chordsketch/node` (resolver plus the Linux x86_64 platform package). The framework packages need a bundler to load and are covered by the entry-point check here and by `readme-smoke.yml` after publishing ([ADR-0064](adr/0064-framework-binding-smoke-tracks-latest.md)); `tree-sitter-chordpro` is grammar source with no Node entry point. (Its `main` pointed at Node bindings that were never packaged, so `require('tree-sitter-chordpro')` failed for every published version; the entry-point check found it.) |
| Size: the npm registry documents no package size limit | [npm: package.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-json) | nothing beyond the 1 MiB large-file rule |

The napi platform packages are packed by
`crates/napi/scripts/stage-release-tarballs.sh`, the script the release
job runs. On a pull request only the Linux x86_64 addon can be built, so
it is staged into all five platform packages: the staging, packing and dry
run are the release's, and only that one addon is loaded. The release job
runs the same check against the five real addons before uploading them.
