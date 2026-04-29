# 0012. MacPorts Portfile cargo.crates is tag-relative, not HEAD-relative

- **Status**: Accepted
- **Date**: 2026-04-29

## Context

`packaging/macports/Portfile` is the upstream-MacPorts submission
recipe. It uses the `cargo` portgroup, which materially changes how
the build resolves dependencies:

- `github.setup koedame chordsketch <VERSION> v` tells MacPorts to
  fetch `https://github.com/koedame/chordsketch/archive/refs/tags/v<VERSION>.tar.gz`
  as the source distfile.
- `cargo.crates <name> <version> <checksum>` lines tell the cargo
  portgroup to download each registry crate by name+version and
  verify it against the listed SHA256.
- At build time, the cargo portgroup unpacks the source tarball,
  reads the `Cargo.lock` **inside the unpacked tarball**, and asks
  cargo to do an offline build using the pre-fetched crates.

The cargo portgroup raises "checksum mismatch on `<crate>`" if the
checksum it computed for a downloaded crate disagrees with the
`cargo.crates` entry. The implicit invariant is therefore:

> `cargo.crates` ⇔ the `Cargo.lock` shipped inside the source tarball.

PR #2287 introduced an in-tree regen script
(`scripts/macports-regen-cargo-crates.py`) plus a CI guard
(`macports-portfile-sync` in `.github/workflows/ci.yml`) so a
contributor bumping a dependency could not silently desync the
`cargo.crates` block. Both read the workspace's `Cargo.lock` —
i.e. **HEAD-relative**.

Several months later, an audit on PR #2317 caught the discrepancy:
the `cargo.crates` block of the in-tree Portfile was being
regenerated against HEAD, but the Portfile's `github.setup` line
still pointed at v0.3.0. HEAD's `Cargo.lock` had grown by 432 lines
(7211 vs 6779) since the v0.3.0 cut. The build only worked because
HEAD's lockfile happened to be a strict superset of v0.3.0's — a
removed-crate case (which `cargo update -p ...` or `cargo
remove` could produce at any time) would have shipped a Portfile
the cargo portgroup would refuse to build, with no in-tree signal
until upstream MacPorts CI flagged it.

Two possible fixes were available:

1. Treat the Portfile's `cargo.crates` as **tag-relative**: read
   `Cargo.lock` from `git show v<TAG>:Cargo.lock` (the file that
   matches the source tarball the cargo portgroup will download).
2. Keep the existing HEAD-relative behaviour and require the
   Portfile's `github.setup` to be bumped to a freshly cut tag any
   time `Cargo.lock` changes — turning every Cargo.lock-touching PR
   into a release-bumping PR.

## Decision

`packaging/macports/Portfile`'s `cargo.crates` block is
**tag-relative**. The script at
`scripts/macports-regen-cargo-crates.py` reads `Cargo.lock` via
`git show v<TAG>:Cargo.lock`, where `v<TAG>` is auto-detected from
the Portfile's own `github.setup` line. The CI guard
(`macports-portfile-sync`) runs the bare `python3
scripts/macports-regen-cargo-crates.py --check` and inherits the
same auto-detection, so the invariant is enforced on every PR.

`--from-ref REF` overrides the default for one explicit case: a
maintainer rehearsing the Portfile bump for an unreleased commit
(e.g. running `--from-ref HEAD` while preparing a release PR
before the actual tag exists).

This decision **supersedes** the HEAD-relative behaviour shipped in
PR #2287. PR #2287 was a regular-PR change, not an ADR; the
HEAD-relative implementation was an unrecorded design choice rather
than a deliberate one. This ADR locks in the corrected invariant so
future contributors do not re-propose HEAD-relative on the (now
debunked) intuition that "the regen script should match the
working-tree lockfile".

## Rationale

The cargo portgroup's behaviour is the load-bearing constraint: it
checksums `cargo.crates` entries against the unpacked tarball's
`Cargo.lock`, full stop. Any other reference point is fictional —
HEAD, working-tree, ad-hoc snapshot — and will diverge from the
tarball the moment `Cargo.lock` changes between the tag and HEAD.

Tag-relative is the only definition under which the CI guard's
"non-zero on drift" promise is actually true. With HEAD-relative,
a green CI guard meant nothing about whether `port install` would
succeed. With tag-relative, a green CI guard is a strong upstream
build signal: if anything in `cargo.crates` is wrong, the script
detects it before merge.

The `--from-ref` override exists because the alternative —
requiring the tag to exist before the regen runs — would block the
release-prep workflow. A release-prep PR legitimately needs to
regenerate `cargo.crates` against an unreleased commit, and that
commit becomes the tag at merge time. `--from-ref HEAD` lets that
flow proceed; the bare `--check` in CI catches the eventual mismatch
once the tag is in place.

The auto-detection of `v<TAG>` from `github.setup` (rather than a
separate workflow input or an env var) keeps the Portfile itself
the single source of truth: bumping `github.setup` is the only
release-time edit needed before regen can run.

## Consequences

**Positive**

- The CI guard's "no drift" promise is meaningful — a green check
  implies the cargo portgroup can build the recipe.
- The Portfile is self-describing: `github.setup` is the single
  configuration knob, and the regen script + CI guard read from it
  uniformly.
- Cargo.lock-touching PRs no longer need a Portfile edit. The
  Portfile is bumped only at release time, when `github.setup`
  moves and the regen script runs against the new tag's lockfile.

**Negative**

- The `macports-portfile-sync` job needs `fetch-depth: 0` so the
  tagged commit is reachable for `git show`. This adds ~1 s to the
  job and increases checkout payload modestly. Acceptable: the job
  is otherwise sub-second.
- Local contributors who run `--check` in a shallow clone will see
  a `git show v<TAG>:Cargo.lock` failure instead of a clean drift
  report. The script raises `SystemExit` with the underlying git
  error, so the diagnostic points at the right cause.
- A `--from-ref` typo could be mis-parsed by `git show` as a CLI
  flag. Mitigation: the script rejects `from_ref` values starting
  with `-` before invoking `git show`. Covered by
  `scripts/test_macports_regen_cargo_crates.py`.

## Alternatives considered

**HEAD-relative (the PR #2287 status quo).** Rejected. The cargo
portgroup does not consume HEAD's lockfile — it consumes the
lockfile inside the source tarball. HEAD-relative was a category
error: it produced a CI guard that turned green for the wrong
reason and silently allowed Portfile/tarball drift in the
removed-crate case.

**Bump `github.setup` on every Cargo.lock change.** Rejected. This
would couple every dependency bump in the workspace to a synthetic
release tag, and would invert the conventional release flow (tag
because we shipped, not because we bumped a transitive crate).

**Snapshot Cargo.lock in `packaging/macports/`.** Rejected. The
on-disk snapshot would itself need a "matches the tarball's
Cargo.lock" check, recursing the original problem. The tarball's
Cargo.lock is the source of truth; reading it via `git show` is
the cleanest way to reach it without a snapshot copy.

**Read Cargo.lock from a downloaded tarball at CI time.** Rejected
on cost grounds. CI would have to fetch the tarball over the
network on every PR for a check that `git show` can answer offline.
The only material difference would be detecting GitHub serving a
tarball whose contents disagree with the tag — a separate,
out-of-scope class of bug.

## References

- Issue [#1615](https://github.com/koedame/chordsketch/issues/1615)
  — MacPorts submission tracking.
- PR [#2287](https://github.com/koedame/chordsketch/pull/2287) —
  introduced the HEAD-relative regen script and CI guard. This ADR
  records the corrected invariant.
- PR [#2317](https://github.com/koedame/chordsketch/pull/2317) —
  switches the regen script to tag-relative, adds
  `macports-smoke.yml`, and lands this ADR.
- MacPorts cargo portgroup reference:
  https://github.com/macports/macports-base/blob/master/src/port1.0/group/cargo-1.0.tcl
- `.claude/rules/fix-propagation.md` — the rule that motivated the
  audit catching this defect.
- Watch signal: any future PR that proposes reverting
  `--from-ref` to working-tree default should be reviewed against
  this ADR. The tag-relative invariant must hold for the cargo
  portgroup to accept the build.
