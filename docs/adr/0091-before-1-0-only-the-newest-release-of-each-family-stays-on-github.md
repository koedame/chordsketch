# 0091. Before 1.0, only the newest release of each family stays on GitHub Releases

- **Status**: Accepted
- **Date**: 2026-11-03
- **Amends**: [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md)

## Context

ChordSketch is pre-1.0 and breaking changes are expected
([ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md)). Every release since
0.1.0 stayed on the GitHub Releases page with its archives, installers and
`checksums.txt`. An old release can carry a vulnerability that a later one
fixed, and the page still offers it: someone who lands on it, or follows a
link to it, installs the vulnerable version.

## Decision

1. **Only the newest release of each tag family stays.** The families are the
   library and CLI (`v<X.Y.Z>`) and the desktop app (`desktop-v<X.Y.Z>`). They
   ship independently, so publishing one never removes the other's newest
   release.
2. **What is deleted is the release and its assets. The git tag stays.** The
   registries and package definitions resolve source archives through the tag
   (`archive/refs/tags/...` in the AUR source package, the MacPorts Portfile
   and the Homebrew `chordsketch-desktop` formula), and a tag costs nothing.
3. **The deletion is the last job of the release run**, a call to
   `prune-old-releases.yml` that `needs:` the release job and every job that
   updates a channel pointing at the release's assets (`release.yml`:
   Docker, napi, VS Code, the npm builds, Swift, `post-release.yml`;
   `desktop-release.yml`: the Cask, the desktop formula, Flathub, the updater
   manifest). It is skipped when any of them failed, so a channel that still
   serves an older release's assets keeps working until it is repaired; after
   the repair, dispatch `prune-old-releases.yml` with the tag.
4. **A release is only pruned by a newer one.** `scripts/prune-old-releases.py`
   deletes releases of the same family with a lower SemVer precedence than the
   tag it is given, and nothing at all if a newer release of the family
   exists (a re-run for an old tag). Publishing a prerelease deletes only older
   prereleases, never the newest stable release.
5. **Versions in the registries are not touched here.** Whether to yank or
   deprecate old crates.io, npm, PyPI, RubyGems and Maven Central versions is a
   separate decision.

Installing an old version from a channel that downloads a release asset
(Homebrew formula, Scoop, Chocolatey, winget, the AUR binary package, SwiftPM's
XCFramework) fails with a 404 once its release is gone. That is the point:
those channels carry the newest version, and a user who needs an old one builds
the tag.

## Consequences

- A broken release is fixed by publishing a new one, not by pointing users at
  the previous release.
- The policy is meant to end with 1.0. When it does, replace the job's
  selection rule (keep the newest of each minor line, say) rather than dropping
  the family boundary.
- A dispatch of `prune-old-releases.yml` defaults to a dry run.
