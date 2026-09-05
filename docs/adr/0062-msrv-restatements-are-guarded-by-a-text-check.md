# 0062. The MSRV restatements are guarded by a text check, not by a Docker build

- **Status**: Accepted
- **Date**: 2026-09-06

## Context

`Cargo.toml`'s `[workspace.package] rust-version` is the single place this
project declares the Rust it needs, and `cargo` enforces it: a toolchain below
the floor refuses to compile the workspace at all.

```
error: rustc 1.85.1 is not supported by the following packages:
  chordsketch@0.5.0 requires rustc 1.88
  chordsketch-chordpro@0.5.0 requires rustc 1.88
  ...
```

Two files restate that number, and until this ADR neither was asserted by
anything running on a pull request.

**`Dockerfile`** — the from-source build image — pins its builder stage to an
exact `rust:<tag>@sha256:<digest>` pair (#1103). It is built by **no workflow**:
`docker.yml` publishes from `Dockerfile.release`, which copies a prebuilt musl
binary out of a GitHub Release and never compiles Rust. The only occurrence of
a Dockerfile path anywhere under `.github/` is that `file: Dockerfile.release`
line.

**`README.md`** states `Requires Rust 1.88 or later.` under `## Installation`
→ `### From source`. `readme-sync.yml` extracts and snapshots the *bash
commands* in that section (see `.claude/rules/readme-sync.md`), not the prose
around them.

The gap was not hypothetical. When the workspace floor moved to 1.88, the
builder stage stayed on `rust:1.85-bookworm`, and nothing went red: the
release path does not touch that file and no other job builds it. A
`docker build .` reproduces the compile error above.

## Decision

Add `scripts/check-msrv-consistency.py` and run it as an unconditional
`msrv-consistency` job in `ci.yml`, alongside the other guard jobs
(`version-consistency`, `fixture-counts`, `core-zero-deps`, `glibc-floor`,
`macports-portfile-sync`).

It reads the floor from `Cargo.toml` and asserts, as text:

- every `FROM rust:...` line in **every** Dockerfile discovered in the tree
  names a version at or above the floor;
- each such pin carries **both** halves of the #1103 pair — the digest that
  decides which image builds, and the tag that Dependabot correlates a bump
  against and that this check reads the version from;
- `README.md`'s requirement sentence names the floor exactly.

Do **not** add a job that runs `docker build .`.

## Rationale

- The check runs on every PR with no `paths:` filter, so it cannot be evaded by
  a diff that touches neither file — which matters, because the drift is
  introduced by editing a *third* file (`Cargo.toml`).
- It is text-only: no network, no `docker pull`, no cargo, sub-second wall
  clock. That is the same shape as every other guard job in `ci.yml`, and it
  adds nothing to the critical path.
- Dockerfiles are **discovered** by walking the tree rather than listed in a
  constant. `deploy-playground.yml` has two incident reports (#2608, #2636)
  where a hand-maintained path list went stale; ADR-0041 records the same
  concern. A future `Dockerfile.<something>` with a Rust builder is covered
  without anyone remembering this file exists.
- The README site is included because it is the same failure — the MSRV
  restated outside `Cargo.toml` — and a user following the from-source
  instructions on the version it names would hit the compile error above
  rather than a clear statement of the floor.

## Consequences

- An MSRV bump that leaves either site behind fails on the PR that makes it,
  with a message naming the file, the line, both versions, and the fact that
  the tag and the digest have to move together.
- **Negative**: the check cannot see a pin whose tag and digest disagree. A
  digest that resolves to a different toolchain than its tag advertises would
  pass. *Mitigation*: the two halves are one token in one line, written and
  bumped together (by hand or by Dependabot), so the tag is a faithful label of
  the digest in practice; and the digest requirement above means a pin cannot
  quietly drop to a tag-only reference where the mismatch would become
  invisible for a different reason.
- **Negative**: the from-source `Dockerfile` is still built by nothing, so a
  break unrelated to the MSRV — a `--locked` mismatch, a missing system
  library, a Debian runtime change — is still first seen by a user.
  *Mitigation*: the file is 9 lines of `FROM` / `COPY` / `cargo build`, and its
  two base images are Dependabot-managed and digest-pinned. The watch signal is
  below.

## Alternatives considered

**Build `Dockerfile` in CI on every PR.** This is the complete check: it
catches the MSRV drift, a tag/digest mismatch, and any build-time breakage. It
was measured rather than assumed — the CLI's dependency graph is 45 crates and
compiles in ~19 s inside the image, and a full `docker build .` finished in
~1 min locally with the base images warm, so the compile itself is not the
objection. The objection is what it adds to every PR: an anonymous Docker Hub
pull of the ~1.5 GB `rust` image, i.e. a dependency on a third-party registry
in the path of every pull request. ADR-0041's measurement is the relevant
precedent — of 187 failing `readme-smoke.yml` jobs across that workflow's
history, 186 were jobs that install from a published artifact, failing for
reasons the PR did not cause. A registry-pulling build job on `ci.yml` would
add that failure shape back to the workflow every PR waits on, in exchange for
covering a file whose content is nine lines. Rejected for now, not on
principle.

**Scope the Docker build to PRs that touch `Dockerfile` / `Cargo.toml` /
`Cargo.lock`.** Cheaper, and it would have caught this instance. Rejected for
the reason ADR-0041 and #2608 / #2636 both record: a `paths:` list is a second
place to keep correct, and the one failure mode it is guarding against is
introduced from a file outside the obvious list.

**Pin the builder to the MSRV exactly (`rust:1.88-bookworm`).** Turns the image
into a free MSRV verification. Rejected: `Dockerfile` exists so a user can
build from source with the toolchain they would otherwise install, which is
current stable, and a dependency raising its own floor above the declared one
would break the image for a reason unrelated to what it is for.

## References

- #1103 — why the base images are pinned by digest with the tag kept alongside.
- ADR-0039 — the release fan-out that calls `docker.yml`, and the
  `Dockerfile.release` path it publishes from.
- ADR-0040 — external-tool integration is deliberately not covered by CI; the
  same principle, that a workflow must not claim coverage it does not have,
  is what makes the "built by nothing" state worth recording rather than
  papering over.
- ADR-0041 — the measurement behind not spending PR wall-clock on jobs whose
  failures the PR did not cause.
- `.claude/rules/readme-sync.md` — what the README snapshot does and does not
  cover.
- **Watch signal**: if a from-source Docker build ever breaks for a reason this
  text check cannot see, add a **scheduled** (not per-PR) `docker build .` job,
  the way `readme-smoke.yml` uses a daily cron for the checks whose failure
  mode is time-based rather than diff-based.
