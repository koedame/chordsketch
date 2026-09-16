# 0078. The runner pool keeps a Rust cache per runner

- **Status**: Accepted
- **Date**: 2026-09-16

## Context

[ADR-0076](0076-linux-jobs-run-on-a-runner-pool-named-by-a-repository-variable.md)
moved the Linux jobs to a pool of eight self-hosted runners and kept the
GitHub Actions cache as their Rust cache. On the pool that cache is slow
to reach and crowds the repository's 10 GiB budget:

- The four Rust jobs of `ci.yml` (Clippy, Docs, and the two `test`
  toolchains) took 17 minutes together on a `main` push whose caches all
  restored, and about 12 of those minutes were the restores themselves.
  A pool runner restored a 714 MB entry in 247 s (3.4 MB/s), where a
  GitHub-hosted runner restores entries of that size in 9–25 s. The same
  host downloads from elsewhere at 28 MB/s, so the limit is the path from
  the cache service, not the host's link.
- When the entries had been evicted the same four jobs took 56–67 minutes
  ([run 35036668599](https://github.com/koedame/chordsketch/actions/runs/35036668599)),
  against 4 minutes on hosted runners with a warm cache
  ([run 34997524579](https://github.com/koedame/chordsketch/actions/runs/34997524579)).
  Saving a cold entry back from the pool took up to 333 s per job.
- The entries the pool's jobs write are about half of the 10 GiB budget,
  which is what evicts them (and the macOS and Windows entries) in the
  first place.

## Decision

1. Each runner of the pool is given a cache directory on its host that
   outlives the job. There is one directory per runner slot; a runner
   holds its slot for its whole life, so two jobs never share one at the
   same time. The directory holds the cargo registry and one `target/`
   per cache key and toolchain. It is emptied when it is a week old or
   grows past its size cap. The runner exports its path as
   `RUST_CACHE_DIR`.
2. Rust-compiling jobs cache through the local composite action
   `.github/actions/rust-cache`, never through `Swatinem/rust-cache`
   directly. When `RUST_CACHE_DIR` is set it links `target/` to
   `$RUST_CACHE_DIR/<shared-key>-<toolchain hash>` and does not touch the
   GitHub Actions cache; otherwise it runs `Swatinem/rust-cache` with the
   caller's `shared-key` and `save-if`. The inputs, and the rule that
   every caller pins `save-if`, are unchanged.
3. A pull request's job may leave build output in a slot that a later
   job — including a `main` push — reuses. This is accepted. What bounds
   it is that nothing built on the pool is published: jobs whose output
   is released stay on GitHub-hosted runners, as ADR-0076 already
   requires. Three places ran on the pool while feeding the release, and
   move back to `ubuntu-latest`: the platform VSIX packaging in
   `vscode-extension.yml` (`targets`, `build-platform`), and
   `generate-and-test` in `kotlin.yml` and `ruby.yml`, whose bindings
   artifact the `publish` job ships as built.

This amends ADR-0076's "nothing carried over to the next job" and
"nothing of the host mounted": the Rust cache directory is the one
exception.

## Rationale

- **The restore is the cost, so the fix is not downloading.** A local
  directory removes the transfer outright; tuning keys or trimming
  entries only changes how much is transferred.
- **One directory per runner, not one for the pool.** Cargo locks its
  build directory, so eight jobs sharing one `target/` would queue
  behind each other. One per slot also keeps a job's leftovers visible
  only to the jobs that later land on that slot.
- **The switch is the runner, not the workflow.** A workflow cannot tell
  a pool runner from `ubuntu-latest` without naming the label.
  `RUST_CACHE_DIR` is present only where the directory exists, so forks,
  hosted runners and an emptied `LINUX_RUNNER` all fall back to the
  GitHub Actions cache with no change.
- **Poisoning is bounded by what the pool produces.** A pull request can
  already make its own checks pass; a poisoned slot can additionally
  make a later run's checks lie. It cannot reach a published artifact as
  long as release builds stay hosted, and the weekly reset caps how long
  anything left behind survives. External pull requests still need
  approval before any workflow runs (ADR-0076).

## Consequences

- The pool's jobs stop writing to the GitHub Actions cache, which leaves
  that budget to the hosted macOS and Windows jobs.
- A slot's first job after a reset, or a job that lands on a slot that
  has not seen its key, builds cold. With eight slots that is at most
  eight cold builds per key per week.
- A check that passed on the pool is weaker evidence than one that
  passed on a clean runner. A result that looks wrong is re-run on
  `ubuntu-latest` by deleting `LINUX_RUNNER`.
- A new release job must not run on the pool. §7 of
  `.claude/rules/ci-parallelization.md` already says so; this ADR is
  the reason it now matters for integrity as well as for credentials.

## Alternatives considered

- **Turning the cache off on the pool.** Rejected: measured cold, the
  four `ci.yml` Rust jobs take 41–49 minutes against 17 with the slow
  restores.
- **A read-only directory that only `main` writes.** Rejected for now:
  it needs the pool to tell `main` pushes from pull requests before the
  job starts, and a runner cannot keep a pull request from writing to a
  directory it can read and build in without a second user per job.
- **A GitHub-compatible cache server on the host.** Rejected: it keeps
  the `save-if` separation, but it reimplements an undocumented protocol
  that GitHub changes on its own schedule, and a change would silently
  turn every job's cache off.
- **sccache on the host.** Rejected: it shares compiled crates with the
  same poisoning path but does not cache build scripts or linking, and it
  has to be configured per job.

## References

- [ADR-0076](0076-linux-jobs-run-on-a-runner-pool-named-by-a-repository-variable.md)
- `.claude/rules/ci-parallelization.md` §2, §7
