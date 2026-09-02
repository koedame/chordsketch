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

Ubuntu 22.04 (glibc 2.35) is in LTS support until 2027, and Debian 11
(2.31) and RHEL 8 (2.28) are older still. The breakage reaches every
channel that redistributes the gnu tarball — Homebrew, AUR, Flatpak,
Snap — not just Homebrew, where it was first observed. `readme-smoke.yml`
cannot see any of it: its `homebrew` job runs on `ubuntu-latest`, where
the archive works.

## Decision

**Every `*-unknown-linux-*` target in `release.yml`'s build matrix is
built through `cross`**, `x86_64-unknown-linux-gnu` included. The
support floor for the gnu archives is declared as **glibc 2.18** and
enforced mechanically by `scripts/check-glibc-floor.py` at two points:

- **On every PR** (`ci.yml`, `glibc-floor` job) the script asserts the
  release matrix still declares `cross: true` for every Linux target.
- **At tag time** (`release.yml`, "Verify glibc floor" step) it reads
  the symbol versions of the binaries that are about to be packaged and
  fails the build job if any exceeds the floor. Because the `release`
  job is `needs: build`, a violation blocks the GitHub Release from
  being created rather than publishing a broken archive.

The same step asserts the inverse for the musl targets: no glibc
references at all, so "statically linked" stays true.

2.18 is not an aspiration — it is what building through `cross`
actually produces. `cross` 0.2.5's `x86_64-unknown-linux-gnu` image is
Ubuntu 16.04 (glibc 2.23); building `-p chordsketch -p chordsketch-lsp`
inside it yields `GLIBC_2.16` for `chordsketch` and `GLIBC_2.18` for
`chordsketch-lsp`, the latter from the same
`__cxa_thread_atexit_impl@GLIBC_2.18` weak import Rust's thread-local
teardown emits on the already-`cross`-built aarch64 artifacts. Those
binaries run and render correctly on Ubuntu 22.04, Debian 11 and
Rocky Linux 8, where the natively built ones do not start at all.

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
- v0.5.0's published `x86_64-unknown-linux-gnu` archive is still broken.
  This decision governs the next release; nothing here rewrites an
  existing tag's assets.
