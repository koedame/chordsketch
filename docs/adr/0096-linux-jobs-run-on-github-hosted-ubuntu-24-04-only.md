# 0096. Linux jobs run on GitHub-hosted `ubuntu-24.04` only

- **Status**: Accepted
- **Date**: 2026-11-21
- **Supersedes**: [ADR-0076](0076-linux-jobs-run-on-a-runner-pool-named-by-a-repository-variable.md), [ADR-0078](0078-the-runner-pool-keeps-a-rust-cache-per-runner.md)
- **Amends**: [ADR-0089](0089-dependabot-cargo-updates-get-their-license-notice-regenerated-by-a-workflow.md), [ADR-0092](0092-github-hosted-linux-jobs-are-pinned-to-ubuntu-24-04.md)

## Context

[ADR-0076](0076-linux-jobs-run-on-a-runner-pool-named-by-a-repository-variable.md)
let a repository variable, `LINUX_RUNNER`, select the runner of every Linux
job (`runs-on: ${{ vars.LINUX_RUNNER || 'ubuntu-24.04' }}`, 26 workflow
files), and [ADR-0078](0078-the-runner-pool-keeps-a-rust-cache-per-runner.md)
kept a Rust cache on the pool's runners (`RUST_CACHE_DIR`).

The repository is public. A workflow that runs on `pull_request` executes
code from the pull request, and for a fork that code is written by a
stranger. Setting `LINUX_RUNNER` to a self-hosted label would have made
every such job run on the self-hosted machine: arbitrary code on a host that
sits inside someone's network, with whatever that host can reach and a cache
directory that outlives the job. The switch needed one variable and no code
change, so it was one misconfiguration away.

The variable is not set, no self-hosted runner is registered, and the pool
was retired on 2026-09-24, so the switch has no use left.

## Decision

1. **Every Linux job names `runs-on: ubuntu-24.04`.** No workflow reads its
   runner from a repository variable, a matrix value that comes from one, or
   any self-hosted label. This repository does not use self-hosted runners.
2. **`scripts/check-runs-on.py` enforces it.** It fails when `runs-on:` or a
   matrix `runner:` / `os:` key reads `vars.`, or when any workflow line
   names `self-hosted`. It runs in the `guards` job of `ci.yml`, on every
   pull request and push to `main`, and its unit tests run with the other
   script tests.
3. **`.github/actions/rust-cache` only wraps `Swatinem/rust-cache`.** The
   `RUST_CACHE_DIR` branch is removed. `save-if` stays required so every
   caller states that only `main` writes to the Actions cache.

## Rationale

- Removing the switch removes the attack surface; a rule ("do not set the
  variable") would depend on nobody ever doing so.
- The check keeps the switch from coming back through a new workflow, such
  as a scheduled job copied from an old one.

## Consequences

- Linux jobs share GitHub-hosted concurrency again; the cache budget of
  `.claude/rules/ci-parallelization.md` §2 covers every Linux cell.
- Needing a self-hosted runner later means a new ADR and a change to the
  check, not a variable.
