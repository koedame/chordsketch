# 0071. The AUR gets a source package, `chordsketch`, and a prebuilt one, `chordsketch-bin`

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

Since #1609 the release has pushed one AUR package, `chordsketch`, whose
`PKGBUILD` installs the prebuilt `x86_64-unknown-linux-gnu` release
archive. The [AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines)
reserve the plain name for a package that builds the software from source
when a source build exists, and ask for a `-bin` suffix on a package of
prebuilt binaries. ChordSketch builds from source with a stock Rust
toolchain, so the package was misnamed. ADR-0070's check could not decide
this mechanically and left it unchecked.

## Decision

1. **`chordsketch` builds the tagged source.** Its `PKGBUILD` downloads
   GitHub's archive of the tag and follows the
   [Rust package guidelines](https://wiki.archlinux.org/title/Rust_package_guidelines):
   `cargo fetch --locked` in `prepare()`, `cargo build --frozen --release
   -p chordsketch` in `build()`.
2. **`chordsketch-bin` repackages the Linux release archive**, which is
   what `chordsketch` did until now, and `provides` / `conflicts` with
   `chordsketch`.
3. **`post-release.yml`'s `update-aur` job generates and pushes both.** The
   `.SRCINFO` files are written by `makepkg --printsrcinfo` in an Arch
   container rather than by hand. The first push to `chordsketch-bin`
   creates the package base; `release-credentials.yml` accepts it as
   absent until then.
4. **The `Publishable` check builds the source package** with `makepkg -s`
   in `archlinux:base-devel` from a `git archive` of the checkout, and runs
   `namcap` on both `PKGBUILD`s and on the built package. A package without
   `build()` must be named `-bin`, and one with `build()` must not.

## Rationale

Renaming the existing package to `-bin` and dropping the plain name would
need a deletion request for `chordsketch` and would move every current
installer to a package they did not choose. Keeping `chordsketch` and
changing what it builds needs no request to the AUR: existing installs
upgrade to a source build of the same version, and users who prefer the
binary switch to `chordsketch-bin`, which conflicts with it.

Building the source package on every pull request is ADR-0070's "publish
path minus the upload". The build is what an Arch user runs, and it found a
missing `zlib` dependency that `namcap` on the `PKGBUILD` alone cannot see:
Arch's `libz-sys` links the system `zlib`, the release build does not.

## Consequences

- Every pull request pays for one release build of the CLI in an Arch
  container, about 1.5 minutes on a warm machine.
- The source package's checksum is taken at release time from the archive
  GitHub serves for the tag. If GitHub regenerated that archive with
  different bytes, `makepkg` would refuse it until `pkgrel` is bumped with a
  new checksum.
- `chordsketch-bin` stays x86_64-only, as the previous package was.
- `README.md` keeps `yay -S chordsketch`, which works before and after the
  switch; `chordsketch-bin` does not exist until the first release that
  pushes it.

## Alternatives considered

- **Keep one binary package under the plain name** until the AUR asks.
  Knowingly publishing against the submission guidelines.
- **Rename the package to `chordsketch-bin` only.** Needs a deletion or
  merge request for `chordsketch`, and leaves no source package.
- **Hand-write the two `.SRCINFO` files.** The source package's
  `makedepends` and `options` would be a second copy of the `PKGBUILD`
  kept in step by hand, which the check existed to catch.
