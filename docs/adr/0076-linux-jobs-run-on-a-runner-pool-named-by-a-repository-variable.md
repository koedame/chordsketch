# 0076. Linux jobs run on a runner pool named by a repository variable

- **Status**: Accepted
- **Date**: 2026-09-16

## Context

A push to a pull request starts 94 jobs across 12 workflows: 65 on
`ubuntu-latest`, 19 on `macos-latest`, 9 on `windows-latest`, 1 on
`ubuntu-24.04-arm`. The account's GitHub-hosted concurrency is 20 jobs
(5 of them macOS), and that ceiling is shared with every other repository
in the organization. Measured on the push of 2026-09-15 12:53 UTC
([run 34971594888](https://github.com/koedame/chordsketch/actions/runs/34971594888)
and the 11 workflows that started with it):

| Runner | Jobs | Queue wait, median / max | Run time, median / total |
|---|---|---|---|
| `ubuntu-latest` | 65 | 43 min / 53 min | 0.9 min / 108 min |
| `macos-latest` | 19 | 63 min / 96 min | 4.3 min / 74 min |
| `windows-latest` | 9 | 34 min / 41 min | 2.4 min / 21 min |

The hosted pool sat at 20 running jobs for the first hour with 230–439
jobs queued behind it (this repository and one other in the organization
together), and the last 40 minutes of the 1 h 46 min the push took were
macOS jobs alone, five at a time. Linux jobs are the bulk of the count
and the shortest to run: their wait is forty times their run time.

Public repositories get hosted minutes for free, so the constraint is not
cost but concurrency, and a larger plan raises the total without touching
the macOS cap.

## Decision

1. A job that needs nothing beyond a Linux userland runs on the runner
   named by the repository variable `LINUX_RUNNER`, and on `ubuntu-latest`
   when the variable is not set:

   ```yaml
   runs-on: ${{ vars.LINUX_RUNNER || 'ubuntu-latest' }}
   ```

   A matrix job keeps `ubuntu-latest` as its `os` cell, so required
   checks keep their names, and selects the runner through an `include`
   key:

   ```yaml
   runs-on: ${{ matrix.runner || matrix.os }}
   strategy:
     matrix:
       os: [ubuntu-latest, macos-latest, windows-latest]
       include:
         - os: ubuntu-latest
           runner: ${{ vars.LINUX_RUNNER || 'ubuntu-latest' }}
   ```

2. `LINUX_RUNNER` names the label of a pool of self-hosted Linux x64
   runners the maintainer operates. Each runner is ephemeral (registered
   just in time, takes one job, is discarded), runs Ubuntu 24.04 with
   rustup, Node, Python and `gh` preinstalled, and has no `sudo`, no
   container engine and no mount from its host. The label itself is never
   written into a workflow.

3. Fork pull requests from outside collaborators do not run workflows
   until a maintainer approves them (repository setting *Require approval
   for all external contributors*).

4. A job stays on plain `ubuntu-latest` when it needs any of: `sudo` /
   `apt-get`; a container engine (`docker`, `cross`, `maturin-action`'s
   manylinux build, the AUR and Flathub checks); `snapcraft` or `flatpak`;
   Homebrew; the Swift toolchain; a display (`xvfb-run`, Playwright
   `--with-deps`); or when it runs with `pull_request_target`. Release,
   publish and deploy workflows, the Claude workflows and the
   `workflow_run`-driven maintenance workflows stay on GitHub-hosted
   runners as well: they carry publishing credentials and gain nothing
   from the pool, since they do not run on pull requests.

## Rationale

- **The variable, not the label, is in the file.** Removing the variable
  returns every job to GitHub-hosted runners without a commit, which is
  the recovery when the pool is down (jobs queued for a self-hosted label
  wait up to 24 hours before GitHub cancels them). Forks have no such
  variable and run unchanged.
- **Only Linux moves.** The pool cannot run macOS or Windows jobs. With
  Linux gone from the hosted pool, the macOS cap (74 minutes of macOS work
  at five at a time, about 15 minutes) is the floor of a pull request, and
  the pool is sized so that the Linux work finishes under it.
- **Ephemeral, unprivileged runners on a public repository.** GitHub
  advises against self-hosted runners for public repositories because a
  pull request can run arbitrary code on the runner. The pool accepts that
  code runs there and bounds it: one job per runner, nothing carried over
  to the next job, no `sudo`, no container engine, no credential beyond
  the job's own `GITHUB_TOKEN`, and nothing of the host mounted. The
  approval setting keeps code from outside collaborators from running at
  all until it has been read.
- **Required checks keep their names.** Branch protection matches
  `Test (ubuntu-latest, stable)` by name; the `include` key changes where
  the cell runs without changing what it is called.

## Consequences

- Linux jobs depend on the pool being up. When it is not, the variable is
  deleted and the jobs go back to GitHub-hosted runners.
- The runner image has to keep up with what jobs assume of
  `ubuntu-latest`. A job that starts needing `sudo`, a container engine or
  a toolchain the image lacks fails on the pool and moves back to
  `ubuntu-latest` with a comment naming the reason; the list in this ADR
  is the reference.
- A job killed by the host going down fails with *the runner lost
  communication* and is re-run by hand.
- The before / after numbers `.claude/rules/ci-parallelization.md` §4
  asks for are the table in *Context* and the table in *Measured after*
  below.

## Measured after

The pull request that introduced this ADR
([#2915](https://github.com/koedame/chordsketch/pull/2915)) ran 123 jobs on
its own head, all green (its workflow edits trip every `paths:` filter, and
`readme-smoke.yml` was dispatched by hand):

| Runner | Jobs | Queue wait, median / max | Run time, median / total |
|---|---|---|---|
| pool (`LINUX_RUNNER`) | 70 | 1.9 min / 25.7 min | 1.2 min / 259 min |
| `ubuntu-latest` (jobs that stay hosted) | 25 | 48 min / 56 min | 1.9 min / 68 min |
| `macos-latest` | 15 | 66 min / 89 min | 4.2 min / 60 min |
| `windows-latest` | 12 | 37 min / 42 min | 2.4 min / 41 min |

- The Linux wait went from a median of 43 minutes to under 2. The 25-minute
  maximum is the first burst: 70 jobs arrived at once on 8 runners that were,
  for this run, allowed 4 CPUs each on a 16-core host. The cap has since been
  lowered so the pool no longer oversubscribes its host.
- Total Linux run time is not directly comparable to the baseline (70 jobs
  including the `readme-smoke.yml` installs against 65) and is higher: the
  pool has less CPU per job than a hosted runner and started with cold caches.
  The wait it removes is an order of magnitude larger.
- The hosted-side numbers are not yet the after-state. Five Dependabot pull
  requests on the previous workflow files were filling the 20 hosted slots
  with their own Linux jobs during this run. Those move to the pool once this
  change is on `main` and they rebase; the macOS floor (about 15 minutes of
  work at five at a time) is the expected pull-request duration after that.

## Alternatives considered

- **A larger GitHub plan.** Rejected: raises the total to 40 or 60 but
  leaves macOS at 5, costs money for a public repository whose minutes are
  free, and keeps the pool shared with the rest of the organization.
- **Writing `self-hosted` into the workflows.** Rejected: recovery from an
  outage would need a commit on every branch, and forks would inherit a
  label they cannot satisfy.
- **A container engine on the pool for the nine `docker` / `cross` jobs.**
  Rejected: a container socket in a runner that executes pull request
  code is root on the host. Those jobs stay hosted; they are not what
  makes the queue long.
- **Fewer jobs.** Merging the one-minute consistency checks into one job
  and building the platform packages only on `main` would cut the count
  and the macOS floor. Complementary, not a substitute; not done here.
