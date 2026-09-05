# 0057. The desktop `.rpm` stays a webkit2gtk 4.1 channel

- **Status**: Accepted
- **Date**: 2026-09-05

## Context

`desktop-release.yml` publishes `ChordSketch-<version>-1.x86_64.rpm`
alongside the `.deb` and the `.AppImage`. Its only two library
dependencies are `libgtk-3.so.0` and `libwebkit2gtk-4.1.so.0`
(`rpm -qp --requires`), and the second one is not a package every
RPM distribution has. [ADR-0056](0056-desktop-bundles-target-ubuntu-2204.md)
noted this in passing and explicitly left it unaddressed, so the
question of what to do about the channel was still open.

Measured on 2026-09-05 against the published `desktop-v0.5.0` assets,
in containers rather than by inspection (`dnf install` of the `.rpm`,
then running the installed binary; the AppImage extracted and its
payload run the same way):

| Distribution | glibc | `webkit2gtk4.1` packaged | `.rpm` installs | Binary starts |
|---|---|---|---|---|
| Fedora 42 | 2.41 | yes (base) | yes | yes |
| AlmaLinux 10 | 2.39 | yes (EPEL, `2.50.4-2.el10_2`) | yes | yes |
| AlmaLinux 9 | 2.34 | no (`webkit2gtk3` = 4.0 only, EPEL included) | no | — |
| AlmaLinux 8 | 2.28 | no (same) | no | — |

"Starts" means the process gets past the dynamic loader; in a container
it then exits at GTK initialisation because there is no display, which
is the expected outcome for a GUI application and is the same on
Fedora and on AlmaLinux 10.

So the premise this ADR was opened under — "the `.rpm` installs on no
RHEL-family distribution" — is true for EL 8 and EL 9 and false for
EL 10, which EPEL has served since RHEL 10's release.

The AppImage is a different case and worth stating, because it is the
obvious suggestion for the distributions the `.rpm` misses. It bundles
its own `libwebkit2gtk-4.1.so.0` (one of 189 shared objects it ships),
so it asks the distribution for nothing beyond an ordinary X11 / GL
desktop stack — but ADR-0056's glibc 2.35 floor still applies to it,
and EL 9 is at 2.34, EL 8 at 2.28. Measured on AlmaLinux 9, the
payload fails at the loader on both counts: `GLIBC_2.35` /
`GLIBC_2.38` from the bundled libraries, and `GLIBCXX_3.4.30` from the
build host's libstdc++, where EL 9's tops out at `GLIBCXX_3.4.29`.
The AppImage is not a receptacle for EL 8 or EL 9; it is one for EL 10,
which does not need it.

## Decision

**The `.rpm` continues to be built and published unchanged, and the
per-format requirements are stated where users read them.** No format
is dropped and no second Linux build cell is added.

- `README.md` and `apps/desktop/README.md` state the split the
  measurements above establish: glibc 2.35+ for all three formats,
  webkit2gtk 4.1 from the distribution for the `.deb` and `.rpm`
  (Ubuntu 22.04+, Debian 12+, Fedora, EL 10 with EPEL), bundled inside
  the `.AppImage`, and no desktop bundle at all for Debian 11, EL 8 and
  EL 9 — where the CLI, which reaches glibc 2.18, is the answer.
- Revisit on demand, not on schedule. The two watch signals are in
  References.

## Rationale

The channel serves Fedora and EL 10 today at zero maintenance cost: it
is one line of `bundles` configuration in a build that already runs for
the `.deb` and the `.AppImage`. Nothing about it is broken; it is
narrower than its file extension suggests, which is a documentation
problem, and documentation is what this ADR spends.

The population that would gain from any other option is EL 8 and EL 9
desktop users, and no one has asked for it. Both alternatives below
cost real work — a permanently uninstallable-anywhere regression, or a
second build cell with its own dependency stack — to serve a population
whose size is currently zero as far as this project can observe.

## Alternatives considered

**Drop the `.rpm` and point RPM users at the AppImage.** The AppImage
does not reach EL 8 or EL 9 either (glibc, above), so this removes a
working install path for Fedora and EL 10 users and gives the RHEL
family nothing in exchange. Dropping a published format is also a
user-visible regression that would have to be justified by something,
and "it does not work on distributions the replacement does not work on
either" is not that.

**Build a second `.rpm` against webkit2gtk 4.0 / libsoup2.** Tauri 2
does support the older stack behind its own feature selection, so this
is possible rather than blocked. It costs a second build cell, a second
dependency set to keep alive, a second artefact to name and explain,
and a second glibc floor to measure — and it still would not reach
EL 8 or EL 9 unless it were also built on a host old enough for them,
which is a different and larger problem (ADR-0056: the floor is set by
the oldest distribution that can build a Tauri app, and for the 4.1
stack that is Ubuntu 22.04). Left on the table for the day someone asks
for it.

## Consequences

- The `.rpm`'s audience is Fedora and EL 10 with EPEL. That is now
  written down in both READMEs instead of being inferable from a
  dependency list.
- EL 8 and EL 9 have no desktop bundle in any format, and this ADR
  accepts that rather than working around it. Their supported path is
  the CLI.
- ADR-0056's Consequences overstated the exclusion ("uninstallable on
  RHEL, Rocky and AlmaLinux at any version"); it is amended to point
  here.
- Nothing in the build changes, so nothing in CI changes. The glibc
  floor check (`scripts/check-glibc-floor.py --channel desktop`)
  continues to be the only gate this channel has, and it is enough:
  the webkit2gtk half of the requirement is a fixed property of the
  bundle, not something a build can drift on.

## References

- [ADR-0056](0056-desktop-bundles-target-ubuntu-2204.md) — the glibc
  2.35 desktop floor, and the Consequences bullet this ADR amends
- [#2839](https://github.com/koedame/chordsketch/pull/2839) — the PR
  that implemented ADR-0056; it lowered the floor to 2.35 and did not
  and could not change the webkit2gtk requirement
- **Watch signal**: a request from an EL 8 or EL 9 user for a desktop
  bundle. That is when the "build against webkit2gtk 4.0 / libsoup2"
  alternative gets priced properly rather than deferred.
- **Watch signal**: `webkit2gtk4.1` appearing in EPEL 9. It would make
  the existing `.rpm` installable on EL 9 with no change here, leaving
  only the glibc floor (2.35 against EL 9's 2.34) in the way — which
  would then be the thing to re-measure.
