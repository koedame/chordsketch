# 0056. The Linux desktop bundles are built on Ubuntu 22.04

- **Status**: Accepted
- **Date**: 2026-09-04

## Context

ADR-0046 put every Linux artifact this project publishes on a single
glibc 2.18 floor by building it inside an old sysroot. It missed a
channel: the desktop bundles. `desktop-release.yml`'s `linux-x86_64`
cell ran `cargo tauri build` natively on `ubuntu-latest`, so the
`desktop-v0.5.0` bundles inherited that runner's glibc exactly the way
the CLI archive did.

Measured against the published `desktop-v0.5.0` assets with
`readelf --wide --dyn-syms --version-info`:

| Artifact | Highest referenced version |
|---|---|
| `ChordSketch_0.5.0_amd64.deb`, `usr/bin/chordsketch-desktop` | `GLIBC_2.39` |
| `ChordSketch-0.5.0-1.x86_64.rpm`, same path | `GLIBC_2.39` |
| `ChordSketch_0.5.0_amd64.AppImage`, same path | `GLIBC_2.39` |
| the ~160 system libraries the AppImage packs beside it | `GLIBC_2.38` |

The executable's 2.39 comes from the same two weak imports as the CLI's
(`pidfd_spawnp`, `pidfd_getpid`); without them it tops out at 2.34. The
AppImage's 2.38 is different in kind and is the reason this is not a
one-line fix: `linuxdeploy` copies the build host's own
`libwebkit2gtk-4.1.so.0`, `libsystemd.so.0`, `libpango-1.0.so.0` and so
on into the image, so the AppImage carries a second, independent floor
set by the runner's userland rather than by the compiler.

Installed into a container and started, rather than inspected:

| Distribution | glibc | `.deb` / `.rpm` dependencies resolve | Starts |
|---|---|---|---|
| Ubuntu 22.04 | 2.35 | yes | no — ``version `GLIBC_2.39' not found`` |
| Debian 12 | 2.36 | yes | no — same |
| Ubuntu 24.04 | 2.39 | yes | yes |
| Fedora 42 | 2.41 | yes (`webkit2gtk4.1`) | yes |
| Debian 11 | 2.31 | no — no `libwebkit2gtk-4.1` package | — |
| Rocky 8 / 9 | 2.28 / 2.34 | no — EL packages webkit2gtk 4.0 only, EPEL included | — |

So the population this breaks is precisely Ubuntu 22.04 and Debian 12:
distributions that resolve the dependencies, install the bundle, and
then produce a loader error on launch.

ADR-0046's mechanism does not transfer. A Tauri app links webkit2gtk and
GTK from the system, and `cross`'s `x86_64-unknown-linux-gnu` image
(Ubuntu 16.04) has neither, nor a webkit2gtk 4.1 that could be installed
into it — webkit2gtk 4.1 first appears around 2022. The floor for this
channel is therefore not "as old as a sysroot can go" but "as old as a
distribution that can build it", which is a different question with a
different answer.

## Decision

**The desktop bundles are built on `ubuntu-22.04` and carry a glibc
2.35 floor** — a second support contract, separate from ADR-0046's 2.18,
because it is the oldest one this channel can reach.

- Both desktop matrices (`desktop-build.yml` and `desktop-release.yml`)
  pin `runner: ubuntu-22.04` on the `linux-x86_64` cell instead of
  `ubuntu-latest`. 22.04 is the oldest GitHub-hosted image that carries
  `libwebkit2gtk-4.1-dev`, so it is simultaneously the lowest floor
  available and the newest constraint the bundle's own dependencies
  impose.
- `scripts/check-glibc-floor.py` grows a `--channel` flag selecting
  between the two floors (`cross` → 2.18, `desktop` → 2.35). It is a
  choice between named contracts, not a `--floor 2.31` knob.
- Its workflow mode now asserts the runner pin in both desktop
  workflows in addition to `cross: true` in the release matrix. This
  matters most for `desktop-release.yml`, which has no `pull_request`
  trigger: without the assertion, moving its runner label back would
  first be observed at tag time, on a release that is already cutting.
- `.github/actions/desktop-build-steps` — the composite both desktop
  workflows share — gains a "Verify glibc floor" step that measures the
  built bundles before the caller uploads them. It reads all three
  formats, not the executable alone: the `.deb` and `.rpm` payloads are
  not byte-identical to each other, and the AppImage's copy is rewritten
  by `linuxdeploy` and shipped alongside the host libraries that carry
  the second floor. Measuring only the executable would have reported
  the v0.5.0 AppImage fixed while it still could not start on Ubuntu
  22.04.

What this buys, stated as distributions rather than as version numbers:
Ubuntu 22.04 (LTS until 2027) and Debian 12 gain a desktop app that
starts. Nothing else changes hands — every distribution below them lacks
webkit2gtk 4.1 entirely, so no lower floor would reach them.

## Alternatives considered

**Build in a container with an old base, as ADR-0046 does.** The
constraint is not the compiler but webkit2gtk: the oldest base that has
it is the same Ubuntu 22.04, so a container arrives at the identical
floor while adding a Rust/Node/Tauri-CLI bootstrap the runner already
provides and an AppImage build that wants FUSE inside the container.
The one thing it would buy is independence from the `ubuntu-22.04`
runner label's lifetime. GitHub has announced no retirement for it, and
22.04's own LTS window runs to April 2027; when a retirement is
announced, this is the option to move to.

**Ship only the AppImage, or only the `.deb`.** Neither the floor nor
the audience changes, and dropping a format is a user-visible
regression justified by nothing.

**Leave the runner alone and document a glibc 2.39 requirement.** This
is ADR-0046's rejected "document the floor" option with the same
objection: it converts a build-host slip into a permanent user-facing
restriction, here for the two distributions most likely to be running a
desktop Linux install.

**Raise ADR-0046's 2.18 to 2.35 so there is one number again.** One
number is not worth regressing the CLI archives, the gem, the JAR and
the Node addon — all of which reach 2.18 today — by seventeen glibc
releases. Two channels with two honestly measured floors beats one
channel-blind floor set by the weakest member.

**Add `pidfd`-free process spawning to get the executable below 2.34.**
It would not help: the AppImage's bundled libraries set the floor
independently, and the `.deb`/`.rpm` still need webkit2gtk 4.1 from the
system.

## Consequences

- ADR-0046's "one glibc floor for every Linux artifact" now reads "one
  floor per channel": 2.18 for the CLI archives and the language
  bindings, 2.35 for the desktop bundles. The README and
  `apps/desktop/README.md` state the desktop requirement — glibc 2.35+
  **and** webkit2gtk 4.1 — because the second half of it is what
  excludes RHEL 8/9 and Debian 11 regardless of glibc.
- The `.rpm` remains published and remains uninstallable on RHEL,
  Rocky and AlmaLinux at any version, because none of them package
  webkit2gtk 4.1; in practice it is a Fedora channel. That predates this
  decision and is not addressed by it.
- Moving either desktop matrix off `ubuntu-22.04` turns the PR red, and
  a build whose bundles exceed 2.35 fails before its artefacts are
  uploaded — on pull requests through `desktop-build.yml` as well as at
  tag time.
- **A pinned host has to be able to run the build's own tools, and one
  of them could not.** `tree-sitter-cli`'s npm package contains no
  binary: it downloads one from upstream's GitHub release, and upstream
  builds those on `ubuntu-latest`, so 0.26.8's Linux binary requires
  GLIBC_2.39 and cannot start on 22.04 — the desktop prebuild hook died
  at `npx tree-sitter build --wasm`. Upstream publishes no musl build
  and no release since has a lower floor (0.27.0 measured), so the
  composite compiles the CLI from source at the version the npm
  lockfile pins, and only when the downloaded binary cannot start. This
  is the general shape of the cost: pinning the host does not just move
  the output's floor, it constrains every prebuilt tool the build
  consumes.
- `desktop-v0.5.0`'s published bundles stay broken. This decision
  governs the next desktop release; nothing here rewrites an existing
  tag's assets.

## References

- [ADR-0046](0046-linux-release-binaries-target-an-old-glibc.md) — the
  glibc 2.18 floor this ADR carves the desktop bundles out of
- #2817 / #2820 — the same defect fixed in the CLI archives and the
  Node/Ruby/Kotlin bindings, the two channels ADR-0046 covered
- **Watch signal**: a GitHub-announced retirement of the `ubuntu-22.04`
  runner label. 22.04's own LTS window runs to April 2027 and no
  retirement is announced as of this ADR's date; when one is, "build in
  a container with an old base" (Alternatives above) is the option to
  move to, since it decouples the floor from a runner image's lifetime.
