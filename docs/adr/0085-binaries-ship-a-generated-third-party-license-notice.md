# 0085. Binaries ship a generated third-party license notice, and dependency licenses are held to an allow list

- **Status**: Accepted
- **Date**: 2026-10-01

## Context

MIT, Apache-2.0, BSD, ISC, Unicode-3.0 and MPL-2.0 each require that a
redistributed binary carry the copyright notice and license text of the
code compiled into it (MPL-2.0 also asks where the source of the covered
files can be had). ChordSketch's binaries link about 700 third-party crates
and bundle a few dozen npm packages. Before this ADR:

- `NOTICE` named one third-party work (the Bravura glyph outlines). Noto Sans
  CJK JP, embedded in `chordsketch-render-pdf` and so in the CLI, the
  desktop app and the wasm and native packages, was not named, and its OFL
  text lived only inside the crate.
- The CLI archives, the container image, the desktop installers, the VSIX,
  `@chordsketch/wasm` and the napi packages carried no notice for any of
  their dependencies.
- No check looked at dependency licenses at all. `cargo audit` reads
  advisories, not licenses, so a GPL or AGPL crate could have been added
  without anything failing.

Auditing the lock file: no dependency is under GPL, AGPL or LGPL alone
(`r-efi` offers `MIT OR Apache-2.0 OR LGPL-2.1-or-later` and is taken
under the permissive choice), 16 crates are MPL-2.0, and 28 crates publish
no license file at all, so a generator that copies license files reproduces
a template with no copyright holder for them.

## Decision

1. **`deny.toml` is the license policy.** `cargo deny --all-features check
   licenses` runs in `dependency-audit.yml` on every pull request that
   touches the dependency graph or the policy. It allows the permissive
   licenses already in the graph, nothing copyleft, and names the
   exceptions (the AGPL desktop crates and the OFL glyph crates) one by one.
   The graph is not narrowed to a target, because the binaries ship for
   several platforms and a platform-specific crate has to be covered for the
   one it ships on.
2. **`THIRD_PARTY_LICENSES.md` is generated and committed.**
   `scripts/third-party-licenses.py` builds it from cargo-about (every
   crate of the workspace, all features, dev-dependencies excluded) and from
   the lock files of the three npm surfaces whose packages are bundled (the
   desktop app, the playground, the VS Code extension), plus the two OFL
   fonts copied into the source. Identical license texts are reproduced
   once with the list of packages that use them; the appendix line of the
   Apache-2.0 text, which crates fill in with their own copyright, is moved
   next to the crate so nearly fifty copies of the license are not repeated.
   A crate or package that publishes no license file gets the standard text
   with the holders its manifest names. MPL-2.0 packages get a source link.
3. **`about.toml` and `deny.toml` must accept the same licenses.** The
   script refuses to run, and `--check` fails, when they differ, so a
   license cannot be allowed without being reproduced.
4. **CI fails when the file is stale.** `ci.yml` runs
   `third-party-licenses.py --check`, which needs no Rust or Node: the file
   header holds a hash of the third-party packages in `Cargo.lock` and in
   the selected part of each `package-lock.json`, of `about.toml`,
   `deny.toml`, the OFL files and the script, and a hash of the body, so a
   hand edit fails too. Workspace version bumps and changes to build
   tooling (`vite`, `vitest`, `@types/*`, ...) do not change the hash.
5. **Every binary distribution carries the file.** The CLI archives and the
   container images add `NOTICE` and `THIRD_PARTY_LICENSES.md` beside
   `LICENSE`; the desktop bundle lists them under `bundle.resources` (and
   the Flatpak installs them); the build of each npm package that ships a
   `.wasm` or `.node` file, and of the VSIX, copies the file into the
   package directory, because `npm pack` and `vsce` take files from there
   only. `notice_problems` in `scripts/_publish_checks.py` fails a package
   that ships such a file without the notice.

## Rationale

- **Committed rather than generated at release time**: every channel then
  takes the same file from the tree, including ones that build from source
  (Flatpak, Homebrew formula, AUR, nixpkgs). The staleness check keeps the
  committed file honest. Generating at release time would have left the
  file out of the source archives those channels build from.
- **One list for the whole workspace rather than one per binary**: a given
  binary contains a subset, and a notice that lists a few packages it does
  not contain is harmless, while a per-binary list needs a build graph per
  artifact and is where an omission would come from.
- **Allow list rather than deny list**: a new license has to be decided on,
  not discovered in a review.
- **The hash covers third-party packages only**, so releases and tooling
  updates do not churn a 0.6 MB file. Dependabot's cargo bumps do change it
  and need a regeneration, as the MacPorts crate list already does;
  `/dependabot-review` runs the check and pushes the regenerated file.

## Consequences

- A change to `Cargo.lock` or to a bundled `package-lock.json` that adds,
  removes or bumps a shipped package fails CI until
  `python3 scripts/third-party-licenses.py` is run. Regenerating needs
  `cargo-about`, network access and `npm ci --ignore-scripts` in each
  directory named in the script (about a minute).
- A dependency under a license outside `deny.toml` fails the pull request
  that adds it. Adding a license to the policy means adding it to both
  `deny.toml` and `about.toml`.
- The npm side treats every dependency of a Vite app as bundled except the
  build and test tooling listed in `TOOLING`. That errs towards listing too
  much; a new tool that is never bundled but is not in `TOOLING` is listed
  until it is added there.
- Not yet covered: the PyPI wheel, the RubyGem, the Maven artifact and the
  Swift and CocoaPods XCFramework, which link the same Rust crates. Their
  build steps do not copy the file in yet, and `notice_problems` does not
  cover their formats.
