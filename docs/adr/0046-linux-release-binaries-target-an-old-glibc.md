# 0046. Linux release binaries are cross-compiled against an old glibc

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

`chordsketch-v0.5.0-x86_64-unknown-linux-gnu.tar.gz` installs cleanly on
Ubuntu 22.04 and then refuses to run:

```console
$ brew install koedame/tap/chordsketch
🍺  /home/linuxbrew/.linuxbrew/Cellar/chordsketch/0.5.0: 6 files, 8.5MB
$ chordsketch --version
chordsketch: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by chordsketch)
```

A glibc-linked ELF runs only on hosts whose glibc is at least as new as
the highest `GLIBC_x.y` symbol version it references. `release.yml`'s
build matrix cross-compiled every Linux target through `cross` — which
builds inside a container with a deliberately old sysroot — **except**
`x86_64-unknown-linux-gnu`, which was built natively on `ubuntu-latest`.
That runner is Ubuntu 24.04 (glibc 2.39), so the most widely installed
of all the release archives inherited the newest possible floor.

Measured against the published v0.5.0 archives with
`readelf --wide --dyn-syms --version-info`:

| Archive | Built with | Highest referenced version |
|---|---|---|
| `x86_64-unknown-linux-gnu` | `cargo` on `ubuntu-latest` | `GLIBC_2.39` (`chordsketch`), `GLIBC_2.34` (`chordsketch-lsp`) |
| `aarch64-unknown-linux-gnu` | `cross` | `GLIBC_2.18` |
| `x86_64-unknown-linux-musl` | `cross` | none (static) |

The two symbols that set the 2.39 floor are `pidfd_spawnp` and
`pidfd_getpid`, weak imports Rust's standard library emits for process
spawning when the build host's glibc offers them. Weakness does not
help: the loader rejects the binary over the `.gnu.version_r` entry, not
over the symbol binding.

The CLI archives were not the only channel doing this. The language
bindings ship Linux shared objects that the same dynamic linker loads,
and `napi.yml`, `ruby.yml` and `kotlin.yml` built them on
`ubuntu-latest` too — natively for x86_64, and through apt's
`gcc-aarch64-linux-gnu` (which links against the runner's own aarch64
sysroot) for aarch64. Measured against the published v0.5.0 packages
with the same `readelf` invocation:

| Artifact | Built with | Highest referenced version |
|---|---|---|
| `@chordsketch/node-linux-x64-gnu` | `napi build` on `ubuntu-latest` | `GLIBC_2.39` |
| `@chordsketch/node-linux-arm64-gnu` | `napi build` + apt `gcc-aarch64-linux-gnu` | `GLIBC_2.39` |
| `chordsketch` gem, `lib/x86_64-linux` | `cargo` on `ubuntu-latest` | `GLIBC_2.39` |
| `chordsketch` gem, `lib/aarch64-linux` | `cargo` + apt `gcc-aarch64-linux-gnu` | `GLIBC_2.39` |
| `chordsketch` JAR, `jni-linux-x86-64` | `cargo` on `ubuntu-latest` | `GLIBC_2.39` |
| `chordsketch` JAR, `jni-linux-aarch64` | `cross` | `GLIBC_2.18` |

Five of the six are unloadable below glibc 2.39; the sixth is the one
cell that already used `cross`. `require('@chordsketch/node')` on
Ubuntu 22.04 raises ``Error: /lib/x86_64-linux-gnu/libc.so.6: version
`GLIBC_2.39' not found``, and `require 'chordsketch'` and the JAR's
`System.load` fail the same way. Nothing in CI could see it: the smoke
tests that load these artifacts all run on `ubuntu-latest`, where they
work.

Ubuntu 22.04 (glibc 2.35) is in LTS support until 2027, and Debian 11
(2.31) and RHEL 8 (2.28) are older still. The breakage reaches every
channel that redistributes the gnu tarball — Homebrew, AUR, Flatpak,
Snap — not just Homebrew, where it was first observed. `readme-smoke.yml`
cannot see any of it: its `homebrew` job runs on `ubuntu-latest`, where
the archive works.

## Decision

**Every Linux artifact this project publishes is linked against an old
sysroot**, and **glibc 2.18 is a single support floor for all of them** —
a user who can run the CLI can also load the gem, the JAR and the Node
addon. Concretely:

- `release.yml`: every `*-unknown-linux-*` target in the build matrix is
  built through `cross`, `x86_64-unknown-linux-gnu` included.
- `ruby.yml` and `kotlin.yml`: both Linux targets build through `cross`.
  This replaces the apt `gcc-aarch64-linux-gnu` toolchain on the aarch64
  cells, which produced the same 2.39 floor as a native build.
- `napi.yml`: both Linux targets build with `napi build
  --use-napi-cross`, which downloads `@napi-rs/cross-toolchain` (a
  prebuilt gcc with a glibc 2.17 sysroot) and points cargo's linker and
  CC at it.

The floor is enforced mechanically by `scripts/check-glibc-floor.py`:

- **On every PR** (`ci.yml`, `glibc-floor` job) the script asserts the
  release matrix still declares `cross: true` for every Linux target.
- **At tag time** (`release.yml`, "Verify glibc floor" step) it reads
  the symbol versions of the binaries that are about to be packaged and
  fails the build job if any exceeds the floor. Because the `release`
  job is `needs: build`, a violation blocks the GitHub Release from
  being created rather than publishing a broken archive.
- **In each binding workflow** (`napi.yml`, `ruby.yml`, `kotlin.yml`,
  "Verify glibc floor" step) it reads the addon or shared object in the
  build job that the publishing job depends on, so a violation blocks
  the upload the same way. Those three workflows also build on pull
  requests, so this doubles as their per-PR check — which is why they
  get no workflow-mode counterpart in `ci.yml`: their Linux builds are
  separate jobs rather than one uniform matrix, and measuring the
  artifact is the stronger of the two checks.

The same step asserts the inverse for the musl targets: no glibc
references at all, so "statically linked" stays true.

The artifact check is not a restatement of the build configuration.
`cross` falls back to a plain host `cargo` build — emitting a warning
and continuing — when it cannot read the package metadata, which was
observed while verifying this decision: the workflow still said `cross
build`, and the resulting library required `GLIBC_2.35`. Configuration
says what was asked for; only the artifact says what was linked.

2.18 is not an aspiration — it is what building through `cross`
actually produces. `cross` 0.2.5's `x86_64-unknown-linux-gnu` image is
Ubuntu 16.04 (glibc 2.23); building `-p chordsketch -p chordsketch-lsp`
inside it yields `GLIBC_2.16` for `chordsketch` and `GLIBC_2.18` for
`chordsketch-lsp`, the latter from the same
`__cxa_thread_atexit_impl@GLIBC_2.18` weak import Rust's thread-local
teardown emits on the already-`cross`-built aarch64 artifacts. Those
binaries run and render correctly on Ubuntu 22.04, Debian 11 and
Rocky Linux 8, where the natively built ones do not start at all.

The binding artifacts land below the same ceiling: the FFI shared object
built inside `cross`'s Ubuntu 16.04 image tops out at `GLIBC_2.18`, and
the napi addon built with `--use-napi-cross` at `GLIBC_2.15`. Both load
and run correctly on Ubuntu 22.04, Debian 11 and Rocky Linux 8, where
the published v0.5.0 artifacts they replace cannot be loaded at all.

The constant is a support contract, so a build that trips the check is
fixed by restoring the old sysroot, never by raising the constant.

## Alternatives considered

**Bottle the Homebrew formula.** Homebrew relocates and dependency-
resolves bottles, so its own glibc 2.39 would be used instead of the
host's. It fixes exactly one channel, requires standing up per-OS/arch
bottle builds and an upload path, and leaves AUR, Flatpak, and Snap
broken.

**Ship musl in place of gnu.** The musl archives already work on every
distribution tested. But this is a per-channel URL substitution — each
consumer has to be pointed at a different asset — and it treats the
symptom in the packaging layer while `release.yml` keeps producing an
archive that does not run. It also costs measurable
throughput: rendering a 3002-line ChordPro file to HTML on Ubuntu 24.04
averaged 15 ms with the musl archive against 12 ms with the gnu one (20
runs each after three warm-ups, v0.5.0 binaries). The musl archives
remain published, for genuinely static use, but they are not the answer
to this.

**Document a glibc floor of 2.39 in the README and send older systems to
`cargo install`.** This converts a build-configuration slip into a
permanent user-facing restriction, and requires a Rust toolchain from
users who came for a prebuilt binary.

**Build the napi addon through `cross` too, for one mechanism
everywhere.** `napi build` is not `cargo build`: it drives cargo, then
renames and post-processes the cdylib into a `.node`, and `cross`'s
container has no Node.js or `@napi-rs/cli` in it. Running `cross build`
and moving the cdylib by hand would work — the workflow already renames
the artifact when it stages the platform packages — but it forks the
Linux cells away from the `napi build` invocation the macOS and Windows
cells use, and away from the command a contributor runs locally.
napi-rs ships `--use-napi-cross` for exactly this problem; its
toolchain's sysroot (glibc 2.17) is older than `cross`'s (2.23), and the
artifact check measures the result either way. `cross` stays the
mechanism for `ruby.yml` and `kotlin.yml`, whose builds *are* plain
`cargo build` and where `kotlin.yml` was already using it.

The price of `--use-napi-cross` is that it swaps the toolchain without
isolating the environment: the runner's `/usr/lib` stays visible, so a
`-sys` build script can probe pkg-config, find the host's copy of its C
library and emit a link flag the sysroot cannot satisfy. `libz-sys` does
this, and the link fails with `cannot find -lz`. `napi.yml` therefore
points `PKG_CONFIG_LIBDIR` at a nonexistent directory for those cells,
which makes such crates compile their C dependency from source with the
cross toolchain — the same outcome the container produces for the other
two workflows, whose artifacts carry no libz dependency either. A
container gets that isolation for nothing; this is what it costs to keep
one `napi build` invocation across all five cells.

**Assert the binding workflows' configuration in `ci.yml` as well.**
The workflow mode of `check-glibc-floor.py` reads `release.yml`'s build
matrix and asserts `cross: true` on every Linux row. There is no
equivalent line to assert in the binding workflows: their Linux builds
are separate jobs, and `napi.yml` derives `--use-napi-cross` from the
target triple rather than from a matrix flag — so that there is no flag
to forget, which is how the x86_64 cells got here. What replaces it is
that all three workflows build on pull requests, so the artifact check
runs per-PR for them. Adding a second, weaker configuration check would
duplicate the guarantee against a more fragile input.

**Keep building `x86_64-unknown-linux-gnu` natively for speed.** `cross`
adds a container pull and an image build to the release job. This is the
option a future contributor is most likely to re-propose, which is why
the check is mechanical rather than a comment: a native build silently
raises the floor to whatever the runner ships, and nothing in the
release pipeline noticed for at least one full release.

## Consequences

- The gnu archives run on any distribution with glibc 2.18 or newer,
  matching what the aarch64 archives have always offered.
- A Linux target added to the release matrix without `cross: true` turns
  the PR red, and a `cross` image whose sysroot moves forward turns the
  release build red before anything is published.
- `packaging/snap/snapcraft.yaml.template` moved from `core22` to
  `core24` for glibc 2.39 compatibility (#1774). That constraint is
  removed by this decision, but the base is left where it is: reverting
  it changes the runtime of an already-published channel and is not
  needed for correctness.
- The gem, the JAR and the Node platform packages carry the same floor
  as the CLI archives, so "which distributions does ChordSketch support"
  has one answer across every channel.
- `napi.yml` no longer installs an apt cross-toolchain and `ruby.yml`
  no longer installs one either; both aarch64 cells now get their
  toolchain from a pinned prebuilt (`@napi-rs/cross-toolchain` and
  `cross`'s image respectively), which also removes an `apt-get update`
  from each.
- v0.5.0's published `x86_64-unknown-linux-gnu` archive is still broken,
  and so are five of the six published Linux binding artifacts. This
  decision governs the next release; nothing here rewrites an existing
  tag's assets or republishes a package version.
