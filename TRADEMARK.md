# ChordSketch Trademark Policy

ChordSketch's source code is open. Its name and logo are not: they are how
someone can tell a release that came from this project apart from everything
else that renders a chord chart.

The short version: **describing, packaging, and building on ChordSketch never
needs permission. Naming your own thing ChordSketch does.**

## What this policy covers

| Mark | Form |
|---|---|
| `ChordSketch` | The word, in any capitalisation (`chordsketch`, `CHORDSKETCH`) |
| The ChordSketch logo | `assets/logo.svg` and its raster exports |

These are unregistered marks of the ChordSketch project (koedame), so they
carry ™ rather than ®. This page is updated if that changes.

## The licence covers the code, not the name

[MIT](LICENSE) (SDK crates) and AGPL-3.0-only (application layer) are
copyright licences. They let you use, modify, redistribute, and sell the
code, and neither grants any trademark permission — AGPL-3.0 §7(e) says so
explicitly, and MIT never addressed marks at all.

So forking is always allowed and always will be. Shipping the fork *under
this name* is the part that needs permission, so that a user who installs
something called ChordSketch gets what this project actually released. React,
Rust, and WordPress all draw the line in the same place.

## Uses that never need permission

- **Saying what your software does.** "Built on ChordSketch", "uses
  ChordSketch", "ChordSketch-compatible", "imports ChordSketch output" — as
  long as the sentence is true and does not suggest this project made,
  endorses, or supports your product.
- **Redistributing an official release unmodified.** Distro packages,
  Homebrew formulae, AUR PKGBUILDs, container images, and mirrors of the
  published crates / npm packages / binaries keep the name. Patches of the
  kind a packager normally applies (build flags, paths, backported fixes)
  are fine; document them where your packaging convention says to.
- **Writing and talking about the project.** Documentation, tutorials, blog
  posts, books, videos, conference talks, courses, screenshots, and
  screencasts. Reproducing the logo unmodified to identify the project is
  part of this.
- **Linking here**, with or without the logo.
- **Community groups and meetups** that are clearly about the project and
  clearly not run by it — "Berlin ChordSketch user group" is fine, an event
  billed as "ChordSketch Conf" is not.
- **Bug reports, forks for contribution, and CI that names the project.**

## Uses that need written permission

- Naming a product, service, company, app-store listing, domain, or social
  account with `ChordSketch` in it, or with a name close enough to be
  confused with it.
- Distributing a **modified** build under the ChordSketch name.
- Publishing a package under a name that reads as official — the
  `@chordsketch/*` npm scope, `chordsketch*` crate names, and equivalents on
  other registries are this project's.
- Merchandise, or any use of the logo altered in colour, proportion, or
  composition.
- Anything that states or implies endorsement, affiliation, partnership, or
  certification.

## Naming: what reads as yours and what reads as ours

| Allowed | Not allowed |
|---|---|
| `Songbook, a ChordSketch plugin` | `ChordSketch Songbook` |
| `Songbook — built on ChordSketch` | `ChordSketch Pro` / `ChordSketch Cloud` |
| `ChordSketch-compatible chord charts` | `chordsketch-songbook` on a package registry |
| `songbook-for-chordsketch` (your own scope) | `MyChordSketch` / `ChordSketchJS` |

The pattern: the mark may appear **after** your own name, describing a
relationship. It may not be the name, the prefix, or the thing a user reads
first.

## If you fork

You are welcome to. To keep the name from following the fork:

1. Rename the project, the binaries, and the published packages.
2. Replace the logo.
3. Keep [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) — the copyright licence
   requires it, and this policy does not change that.
4. Say where it came from in prose: "forked from ChordSketch" is exactly the
   nominative use the section above allows.

## Other people's marks

ChordPro, iReal Pro, and the other product and format names referenced in
this repository belong to their respective owners. ChordSketch is not
affiliated with, endorsed by, or sponsored by any of them; those names appear
here only to say truthfully which formats this software reads and writes.

## Attribution text

When a notice is useful, this is the wording to copy:

> ChordSketch™ is a trademark of the ChordSketch project. This product is not
> affiliated with or endorsed by the ChordSketch project.

## Asking, and reporting misuse

Open an issue at <https://github.com/koedame/chordsketch/issues>. Permission
under this policy is only ever granted in writing; silence is not consent,
and one grant does not extend to the next use.

The rationale behind this policy is recorded in
[ADR-0058](docs/adr/0058-the-name-is-protected-separately-from-the-code.md).
