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

## VS Code Marketplace and Open VSX

Published by the `publish` and `publish-openvsx` jobs of
[`vscode-extension.yml`](../.github/workflows/vscode-extension.yml) on a
release tag: one universal VSIX and one per target in `VSCODE_TARGETS`.
The pull-request check builds with the release's build composite
(`.github/actions/vscode-extension-build`), packages every VSIX with the
command the release uses, runs the publish jobs' own setup composite
(`.github/actions/vscode-extension-publish-setup`, where v0.6.0's publish
failed with `tsup: not found`) and checks the set the publish jobs would
upload. The publish jobs run the same set check before uploading.

| Condition | Source | Checked by |
|---|---|---|
| `name` (lowercase, no spaces), `publisher`, `version`, `engines.vscode` are set | [Extension manifest](https://code.visualstudio.com/api/references/extension-manifest) | `vsix_manifest_problems` |
| `version` is `major.minor.patch` with no pre-release suffix | [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions) | `vsix_manifest_problems` |
| The icon is a PNG of at least 128×128, not an SVG | [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) | `vsix_manifest_problems` |
| README / CHANGELOG images are `https` and not SVG (except trusted badges) | [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) | `vsce package` refuses otherwise |
| At most 30 keywords | [Extension manifest](https://code.visualstudio.com/api/references/extension-manifest) | `vsix_manifest_problems` |
| A `license` is declared (Open VSX) | [Open VSX: publishing extensions](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions) | `vsix_manifest_problems` |
| `vsce package` prints no warning | — | `vsce_package_problems` |
| Every platform VSIX bundles its target's `chordsketch-lsp` under the `server/` directory `src/platform.ts` reads, carries no other target's, is marked with its `TargetPlatform`, and the universal VSIX carries none | [Platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions) | `vsix_problems` |
| The set to upload is exactly one universal VSIX plus one per target | — (a missing target leaves its users on the universal VSIX, #1786) | `vsix_set_problems` |
| Size: neither registry documents a limit | [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) | the 1 MiB large-file rule (the wasm engine and the bundled server are declared) |

On a pull request only the host's `chordsketch-lsp` can be built, so it
stands in for every target's; release.yml's real per-target binaries are
checked by the same function when `build-platform` packages them.

## PyPI

Published by [`python.yml`](../.github/workflows/python.yml) on a release
tag, with `maturin upload`. The pull-request check builds the sdist and
the Linux x86_64 wheel with `python.yml`'s `maturin` arguments (a release
build, so the size limit means something); the publish job runs the same
check over every wheel before uploading.

| Condition | Source | Checked by |
|---|---|---|
| No file over 100 MiB | [PyPI: storage limits](https://docs.pypi.org/project-management/storage-limits/) | `python_dist_problems` |
| `Name`, `Version`, `Summary`, `Requires-Python`, a license, a project URL and a long description are in the metadata | [Core metadata](https://packaging.python.org/en/latest/specifications/core-metadata/) | `python_metadata_problems` |
| The version is a PEP 440 version | [Version specifiers](https://packaging.python.org/en/latest/specifications/version-specifiers/) | `python_metadata_problems` |
| The long description renders | [Making a PyPI-friendly README](https://packaging.python.org/en/latest/guides/making-a-pypi-friendly-readme/) | `twine check --strict` |
| Linux wheels carry a manylinux / musllinux tag, not the bare `linux_*` tag | [PEP 600](https://peps.python.org/pep-0600/) | `python_dist_problems` |
| The wheel installs into a fresh environment and works | — | `pip install` + `scripts/smoke-test-python.py` |

## RubyGems

Published by [`ruby.yml`](../.github/workflows/ruby.yml) on a release tag
with `gem build` and `gem push`. Its bindings are generated by
`packages/ruby/scripts/generate-bindings.sh` and its native libraries
staged by `packages/ruby/scripts/stage-native-libs.sh` — both run by the
release and by the pull-request check. The publish job builds the gem
through the check.

| Condition | Source | Checked by |
|---|---|---|
| `name`, `version`, `summary`, `authors`, `files`, `licenses` and `homepage` are set | [Specification reference](https://guides.rubygems.org/specification-reference/) | `gem_spec_problems` |
| The gem carries the native library for every platform `lib/chordsketch.rb` supports | — | `gem_spec_problems` |
| `gem build` prints no warning | — | `gem_problems` |
| The gem installs and loads | — | `gem install` + a render |
| Size: RubyGems documents no limit | [Publishing your gem](https://guides.rubygems.org/publishing/) | the 1 MiB large-file rule |

## Maven Central

Published by [`kotlin.yml`](../.github/workflows/kotlin.yml) on a release
tag through the Central Portal. Its JNI libraries are staged by
`packages/kotlin/scripts/stage-jni-libs.sh`, which the release and the
pull-request check both run. The check publishes to a scratch local
repository with `publishToMavenLocal`, signed with a throwaway key on a
pull request and with the release key in the publish job, which runs the
check before uploading.

| Condition | Source | Checked by |
|---|---|---|
| The POM has `groupId`, `artifactId`, `version`, `name`, `description`, `url`, a license, a developer and `scm` url / connection / developerConnection | [Central: requirements](https://central.sonatype.org/publish/requirements/) | `pom_problems` |
| The version is not a SNAPSHOT | [Central: requirements](https://central.sonatype.org/publish/requirements/) | `pom_problems` |
| Sources and javadoc jars are published | [Central: requirements](https://central.sonatype.org/publish/requirements/) | `maven_repository_problems` |
| Every file is signed | [Central: requirements](https://central.sonatype.org/publish/requirements/) | `.asc` beside every artifact |
| Checksums | [Central: requirements](https://central.sonatype.org/publish/requirements/) | generated by the Gradle plugin at upload; not checkable before it |
| The jar carries each platform's native library where JNA loads it (`linux-x86-64/`, `darwin-aarch64/`, …) | [JNA `NativeLibrary`](https://java-native-access.github.io/jna/5.17.0/javadoc/com/sun/jna/NativeLibrary.html) | `maven_repository_problems`. Every jar published up to 0.6.0 carried them under `jni-linux-x86-64/` and the like, where JNA does not look. |
| The jar works from a clean classpath of its declared runtime dependencies | — | a Java program calling the bindings |

## GHCR and Docker Hub

Built and pushed to GHCR by [`docker.yml`](../.github/workflows/docker.yml)
with the `.github/actions/docker-release-image` composite, then copied to
Docker Hub by tag. The pull-request check runs the same composite without
pushing.

| Condition | Source | Checked by |
|---|---|---|
| `Dockerfile.release` builds for linux/amd64 and linux/arm64 from the staged musl binaries | — | the composite's build |
| Every tag matches the reference grammar and the image name is lowercase | [distribution/reference](https://github.com/distribution/reference/blob/main/reference.go) | `container_tag_problems` |
| The image is tagged `X.Y.Z`, `X.Y` and `latest`, the tags the Docker Hub copy reads | — | `container_tag_problems` |
| The image runs, reports the version, and does not run as root | — | `container_image_problems` |
| Size: GHCR limits a layer to 10 GB; Docker Hub documents no limit | [Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) | not checked (the image is a few megabytes) |

The image pulls its pinned Alpine base from Docker Hub on every pull
request, the dependency ADR-0062 declined for the from-source `Dockerfile`.
Here the image is a published artifact, which ADR-0070 weighs above that
cost.

## GitHub Release archives

Built and uploaded by [`release.yml`](../.github/workflows/release.yml) on
a release tag. Every package manager below downloads these archives by
name, so their names, layout and checksum lines are part of every
channel's contract. The pull-request check runs `release.yml`'s own
`Package (Unix)` and `Generate checksums` steps on a debug Linux build, and
`Package (Windows)` in PowerShell on a debug Windows build.

| Condition | Source | Checked by |
|---|---|---|
| The archive is named `chordsketch-vX.Y.Z-<target>.tar.gz` (`.zip` on Windows), one per `release.yml` target | — (Homebrew, Scoop, Chocolatey, AUR, Snap, docker.yml and the VS Code build all download by this name) | `cli_archive_problems`; `release_assets` reads the targets from `release.yml` |
| A tarball holds `chordsketch-vX.Y.Z-<target>/` with `chordsketch`, `chordsketch-lsp`, `LICENSE`, `README.md`; the Windows zip holds `chordsketch.exe`, `chordsketch-lsp.exe`, `LICENSE`, `README.md` at its root | — (Scoop's `bin`, Chocolatey's unzip and winget's `RelativeFilePath` read the zip's root) | `cli_archive_problems` |
| `checksums.txt` has a `<sha256>  <archive name>` line, with no directory | — (the package managers `awk` for the name) | `cli_archive_problems` |

## Homebrew formula and cask

The formula is generated by [`post-release.yml`](../.github/workflows/post-release.yml)
and the desktop cask by [`desktop-release.yml`](../.github/workflows/desktop-release.yml),
both pushed to `koedame/homebrew-tap`. For this and every template-based
channel below, the pull-request check runs the release job's own
generating step — read out of the workflow file, so there is no second
copy — against a fabricated release in which every asset has a distinct
checksum.

| Condition | Source | Checked by |
|---|---|---|
| The formula has `desc`, `homepage`, `license`, and passes `brew audit --strict` | [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) | `homebrew_problems` |
| Formula and cask pass `brew style` | [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) | `homebrew_problems` |
| The cask has `name`, `desc`, `homepage` | [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook) | `homebrew_problems` |
| Every download is an asset the release publishes, paired with that asset's checksum, and no placeholder is left | — | `download_url_problems`, `checksum_problems` |

## Scoop

Generated by `post-release.yml` and pushed to `koedame/scoop-bucket`.

| Condition | Source | Checked by |
|---|---|---|
| Valid JSON with `version`, `description`, `homepage`, `license`, and a `bin` | [App manifests](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests) | `scoop_problems` |
| The pinned download and the `autoupdate` download are release assets; the pinned hash is that asset's | — | `scoop_problems` |

## Chocolatey

Generated by the `chocolatey-generate-package` composite and packed and
pushed by `chocolatey-pack-push` on Windows. The pull-request check runs on
Windows too: the generating composite, then the composite's own `Pack`
step.

| Condition | Source | Checked by |
|---|---|---|
| `choco pack` succeeds and writes `chordsketch.X.Y.Z.nupkg` | [Create packages](https://docs.chocolatey.org/en-us/create/create-packages/) | `chocolatey_problems` |
| The nuspec has `id` (lowercase), `version`, `title`, `authors`, `projectUrl`, `packageSourceUrl`, `description`, `summary`, `tags` and a license | [Create packages](https://docs.chocolatey.org/en-us/create/create-packages/), [Moderation](https://docs.chocolatey.org/en-us/community-repository/moderation/) | `chocolatey_problems` |
| The install script downloads a release asset with that asset's checksum | — | `chocolatey_problems` |
| Size: the community repository documents no limit | [FAQ](https://docs.chocolatey.org/en-us/faqs/) | the 1 MiB large-file rule |

## AUR

Two package bases, generated by `post-release.yml` (the `PKGBUILD`s from
`packaging/aur/<package>/PKGBUILD.template`, each `.SRCINFO` from
`makepkg --printsrcinfo`) and pushed to `aur.archlinux.org` (ADR-0071):
`chordsketch` builds the tagged source, `chordsketch-bin` repackages the
Linux release archive. The pull-request check stands a `git archive` of the
checkout in for the tag archive and builds the source package from it.

| Condition | Source | Checked by |
|---|---|---|
| `pkgname` and `pkgver` follow the PKGBUILD rules, and `pkgname` is the package base the release pushes to | [PKGBUILD](https://wiki.archlinux.org/title/PKGBUILD) | `aur_problems` |
| A package of prebuilt binaries is named `-bin` when a source build exists; a package that builds from source is not | [AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines) | `aur_naming_problems` |
| `.SRCINFO` describes the package base | [AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines) | `aur_problems` |
| `namcap` reports nothing on either `PKGBUILD` or on the built source package (shared libraries missing from `depends`) | [AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines) | `aur_problems`, in an `archlinux:base-devel` container |
| The source package builds with `makepkg -s`, which installs only the declared dependencies | [Rust package guidelines](https://wiki.archlinux.org/title/Rust_package_guidelines) | `aur_problems`, in an `archlinux:base-devel` container |
| `chordsketch` downloads the tag archive with its checksum; `chordsketch-bin` downloads a release asset with that asset's checksum | — | `aur_problems` |

## Snap Store

Generated and built with `snapcraft --destructive-mode` by `post-release.yml`.
The pull-request check runs the same build with a debug Linux CLI staged.

| Condition | Source | Checked by |
|---|---|---|
| `name` follows the store's rules; `version`, `summary` (at most 78 characters), `description`, `license`, `base`, `confinement`, `grade` are set | [Top-level metadata](https://snapcraft.io/docs/snapcraft-top-level-metadata) | `snap_problems` |
| `snapcraft --destructive-mode` builds a `.snap` | [Releasing your app](https://snapcraft.io/docs/releasing-your-app) | `snap_problems` |

## CocoaPods and the Swift package

The podspec is generated and pushed with `pod trunk push` by
[`swift.yml`](../.github/workflows/swift.yml), which also rewrites
`Package.swift` to the new XCFramework zip and checksum and opens a pull
request with it.

| Condition | Source | Checked by |
|---|---|---|
| The podspec has `name`, `version`, `summary` (at most 140 characters), `license`, `homepage`, `authors`, `source` | [Podspec syntax](https://guides.cocoapods.org/syntax/podspec.html) | `cocoapods_problems` via `pod ipc spec` |
| The license can be found: the source zip holds no LICENSE file, so the text is inlined | [Getting setup with trunk](https://guides.cocoapods.org/making/getting-setup-with-trunk.html) (an open-source pod may have no lint warnings) | `cocoapods_problems` |
| The source is the XCFramework asset the release uploads | — | `cocoapods_problems` |
| `Package.swift`'s `binaryTarget` points at that asset with its checksum, and the manifest still parses | [SE-0272](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0272-swiftpm-binary-dependencies.md) | `swift_package_problems` via `swift package dump-package` |
| `pod spec lint` and `swift build` against the XCFramework | [Getting setup with trunk](https://guides.cocoapods.org/making/getting-setup-with-trunk.html) | need macOS and the built XCFramework: `swift.yml` builds and tests it on the pull requests that touch its inputs |

## Desktop updater manifest

`desktop-release.yml` builds `latest.json` from the release's updater
signatures and publishes it to the `desktop-updater-manifest` branch, where
the app's Tauri updater reads it.

| Condition | Source | Checked by |
|---|---|---|
| `latest.json` has the version and one entry per platform, each with the asset's URL and the signature file's full minisign text | [Tauri updater](https://v2.tauri.app/plugin/updater/) | `desktop_updater_problems`, running the release's `Build latest.json` step |
| `tauri.conf.json`'s updater reads the URL the release publishes to | — | `desktop_updater_problems` |

## JetBrains Marketplace

Published by hand with `./gradlew publishPlugin`.

| Condition | Source | Checked by |
|---|---|---|
| The plugin builds and `verifyPluginProjectConfiguration` passes | [IntelliJ Platform Gradle Plugin](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html) | `jetbrains_problems` |
| The distribution is at most 400 MB | [Uploading a new plugin](https://plugins.jetbrains.com/docs/marketplace/uploading-a-new-plugin.html) | `jetbrains_problems` |
| `plugin.xml` has `id`, `name` (at most 60 characters), a SemVer `version`, `vendor`, `description` and `idea-version since-build` | [Plugin configuration file](https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html) | `jetbrains_problems` |

## MacPorts

Submitted by hand as a pull request to `macports/macports-ports`.

| Condition | Source | Checked by |
|---|---|---|
| `port lint --nitpick` passes | [MacPorts guide: contributing](https://guide.macports.org/chunked/project.contributing.html) | [`macports-smoke.yml`](../.github/workflows/macports-smoke.yml), called by `publishable.yml` |
| The Portfile's `cargo.crates` match the tagged `Cargo.lock` | — | `ci.yml`'s `macports-portfile-sync` job |

## nixpkgs

Submitted by hand as a pull request to `NixOS/nixpkgs` from
`packaging/nix/package.nix`.

| Condition | Source | Checked by |
|---|---|---|
| `meta` has `description` (no leading article, no trailing period, not starting with the name), `homepage`, `license`, `mainProgram`, `platforms`; the version is current | [pkgs/README.md](https://github.com/NixOS/nixpkgs/blob/master/pkgs/README.md) | `nixpkgs_problems` |
| `maintainers`, `hash` and `cargoHash` | [pkgs/README.md](https://github.com/NixOS/nixpkgs/blob/master/pkgs/README.md) | filled in at submission time (see the file's header); only their presence is checked |
| The package builds | — | [`nix.yml`](../.github/workflows/nix.yml) (the flake's derivation), called by `publishable.yml` |

## winget

Submitted by hand as a pull request to `microsoft/winget-pkgs` from
`packaging/winget/`.

| Condition | Source | Checked by |
|---|---|---|
| Each manifest has its required fields and the current `PackageVersion` | [Manifest schema](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest) | `winget_problems` |
| `InstallerUrl` is this version's release asset; `InstallerSha256` is 64 uppercase hex digits | [Manifest schema](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest) | `winget_problems`. Until this check, the manifests were at 0.6.0 but downloaded the 0.5.0 zip. |

## Flathub

`post-release.yml` generates a manifest and would open a pull request on
`flathub/me.koeda.chordsketch` if `FLATHUB_TOKEN` were set; the application
has not been submitted to Flathub, and the channel is not in
`ci/release-channels.toml`.

| Condition | Source | Checked by |
|---|---|---|
| `flatpak-builder-lint manifest` reports no error or warning | [Flathub linter](https://docs.flathub.org/docs/for-app-authors/linter) | `flathub_problems` — **not in the required check**: on `main` it reports `finish-args-home-filesystem-access` and an outdated runtime |
| The app builds from source and ships AppStream metainfo | [Flathub requirements](https://docs.flathub.org/docs/for-app-authors/requirements) | not met: the manifest installs the prebuilt release binary and there is no metainfo |

Flathub does not accept console software ("Console softwares will not be
accepted", [requirements](https://docs.flathub.org/docs/for-app-authors/requirements)),
so the CLI this manifest packages cannot be submitted however the manifest is
fixed. Whether to submit the desktop app instead or drop the dormant job is a
maintainer decision; until then the channel is documented here and checked
only on demand (`scripts/check-publishable.py flathub`).
