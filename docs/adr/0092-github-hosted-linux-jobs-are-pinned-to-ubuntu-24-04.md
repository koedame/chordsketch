# 0092. GitHub-hosted Linux jobs are pinned to `ubuntu-24.04`

- **Status**: Accepted
- **Date**: 2026-11-04
- **Amends**: [ADR-0076](0076-linux-jobs-run-on-a-runner-pool-named-by-a-repository-variable.md)

## Context

`ubuntu-latest` is an alias GitHub moves to a new Ubuntu release on its own
schedule. It began resolving to Ubuntu 26.04 on 2026-11-01, and during the
roll-out the same label gave 24.04 to one run and 26.04 to the next. Two jobs
broke on 26.04 within three days:

- `snapcraft` refused a `core24` build (`Ubuntu 24.04 builds cannot be
  performed on this Ubuntu 26.04 system`). Those two jobs were pinned in
  [#3075](https://github.com/koedame/chordsketch/pull/3075).
- Browser Smoke failed at `Install Playwright Chromium` with `Playwright does
  not support chromium on ubuntu26.04-x64`, while a run of the same commit a few
  hours earlier had passed.

The repository had 166 mentions of `ubuntu-latest` in 53 files. Fixing the jobs
that happened to fail leaves the others to fail the same way the next time the
alias moves, and a check that passes or fails depending on which image it was
handed cannot be trusted either way.

The self-hosted pool of ADR-0076 runs Ubuntu 24.04. A job that falls back to a
hosted runner because `LINUX_RUNNER` is unset should therefore find the same
userland it finds on the pool.

## Decision

1. **No workflow uses `ubuntu-latest` as a runner.** Every GitHub-hosted x64
   Linux job names `ubuntu-24.04`. The pool fallback is
   `${{ vars.LINUX_RUNNER || 'ubuntu-24.04' }}`.
2. **The required checks keep their names.** The `Test` matrix of `ci.yml`
   keeps `ubuntu-latest` as its `os` cell, because branch protection matches
   `Test (ubuntu-latest, stable)` by name, and selects its runner through the
   `include` key (`runner: ${{ vars.LINUX_RUNNER || 'ubuntu-24.04' }}`). The cell
   name is a name; it is never the runner.
3. **Moving to the next Ubuntu release is one edit made on purpose**: replace
   `ubuntu-24.04` with the new label in every workflow, in a pull request that
   passes on it, together with the pool image. `macos-latest` and
   `windows-latest` are left on their aliases; they have not broken this way.

## Consequences

- A change of the alias no longer changes what CI runs on; the runner image
  changes when a pull request changes it.
- Jobs on a pinned label stop receiving a newer toolchain image by themselves.
  The pin is revisited when GitHub announces that the label is deprecated.
- `docs/github-action.md` still shows `runs-on: ubuntu-latest` in the example for
  users of the action; that is advice to others, not this repository's CI.

## Alternatives considered

- **Port each failing job to 26.04.** Rejected: the next release breaks a
  different set, and the pool is on 24.04, so a hosted fallback on 26.04 would
  behave differently from the pool.
- **Pin only the jobs that fail now and leave the rest on `ubuntu-latest`.**
  Rejected: it needs a reason per job and leaves the roll-out's flakiness in
  every other check.
