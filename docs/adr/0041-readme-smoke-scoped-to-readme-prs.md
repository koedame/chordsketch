# 0041. README install smoke tests are scoped to README-system PRs

- **Status**: Accepted
- **Date**: 2026-08-30

## Context

`.github/workflows/readme-smoke.yml` verifies that every install method
advertised in `README.md` works for an unauthenticated end user, and that
the binary each method produces renders songs end to end. Until this ADR
it ran on **every** pull request with no path filter, on a daily cron, and
on dispatch. It also ran on `release: published` until
[ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md) dropped that
trigger: at tag time none of the published channels are updated yet, so the
run asserted the previous release.

The every-PR trigger was deliberate, and the workflow carried a comment
defending it: end-user installability is a global property of the repo,
and a path-filter list has to be re-audited whenever the workspace shape
changes, so a missed entry produces a false sense of safety. That concern
is not hypothetical here — `deploy-playground.yml` carries two incident
reports (#2608, #2636) where a narrow `paths` list let a change ship
without redeploying the playground, and its filter was widened to
`crates/**` in response.

Two facts moved the balance.

**This workflow is one of the most expensive things a PR starts.** Over
the last 90 days (`created>=2026-05-31`) it ran 357 times on
`pull_request`, and the 276 successful runs took a median of 7.0 min, a
mean of 10.7 min, a p90 of 26.4 min and a max of 67.8 min wall clock. It
is also macOS-bearing (`homebrew-cask` runs on `macos-latest`), and
[`one-pr-at-a-time.md`](../../.claude/rules/one-pr-at-a-time.md) records
that the org's 5-concurrent-macOS-job ceiling — not the 20-job total — is
this repo's practical CI bottleneck.

**Almost none of what it catches on a PR is caused by the PR.** On a
`pull_request` event, 11 of the 14 smoke jobs install from a published
artifact: GHCR, Docker Hub, crates.io, npm (×2), a Homebrew tap, a
Homebrew cask, scoop, winget, chocolatey, snap. No diff in a PR can
change what those registries serve. Only three jobs compile the PR's own
tree: `source-build` (clones `refs/pull/<N>/head` and
`cargo install --path crates/cli`), `usage-smoke` (installs from the
workspace), and `library-smoke`, whose PR branch swaps the crates.io
dependencies for workspace path deps.

Measured across the workflow's entire history — 1,832 `pull_request`
runs, of which 156 failed, with 187 failing jobs between them:

| Failing job | Count | Installs from |
|---|---|---|
| `winget (Windows)` | 89 | published |
| `npm (@chordsketch/wasm)` | 42 | published |
| `Chocolatey (Windows)` | 15 | published |
| `Homebrew` | 14 | published |
| `Snap (Linux)` | 8 | published |
| `Docker Hub` | 7 | published |
| `Docker (GHCR)` | 4 | published |
| `cargo install chordsketch` | 3 | published |
| `Scoop (Windows)` | 2 | published |
| `Homebrew Cask (macOS)` | 2 | published |
| `From source (git clone + cargo install)` | 1 | **the PR's tree** |
| `README Usage examples (source build)` | 0 | the PR's tree |
| `Library Usage` | 0 | the PR's tree (PR branch) |

186 of 187 failing jobs were registry-side. The single source-built
failure was run
[24884964801](https://github.com/koedame/chordsketch/actions/runs/24884964801)
on 2026-04-24 (branch `issue-2192-ui-web-polish`); its logs have since
expired, so the cause is not verifiable today.

Those 186 failures did not even produce the artefact this workflow exists
to produce. `report-failure` is gated on
`github.event_name != 'pull_request'`, so a PR-event failure never opens
or updates the rolling "README install smoke tests are failing" tracking
issue. It only turned the PR red for a registry condition the PR did not
cause and its author could not fix. The daily cron is the trigger whose
cadence matches a time-based failure mode, and it does detect them: 16 of
its 145 runs have failed.

No job in this workflow is in `required_status_checks.contexts` for
`main` (the list is `Format`, `Clippy`, and the six `Test (…)` cells), so
the PR trigger was never load-bearing for branch protection.

## Decision

`readme-smoke.yml`'s `pull_request` trigger gains a `paths` filter
covering the README system:

```yaml
pull_request:
  paths:
    - "README.md"
    - ".github/snapshots/readme-commands.txt"
    - ".github/fixtures/**"
    - ".github/actions/cli-render-smoke/action.yml"
    - ".github/workflows/readme-smoke.yml"
```

The daily `schedule` and `workflow_dispatch` triggers are unchanged. There is
no `release` trigger to change — ADR-0039 removed it.

## Rationale

The path list is not a dependency list. It is the set of inputs that
decide this workflow's outcome and that a contributor can enumerate by
reading the workflow: the README whose commands it asserts, the committed
snapshot of those commands, the fixtures every job renders, the composite
action that does the rendering, and the workflow file itself. That is
what distinguishes it from the `deploy-playground.yml` failures — those
filters tried to name a *transitive* dependency set (which crates feed the
wasm bundle) and went stale as soon as the dependency graph moved. A
filter over enumerable inputs cannot go stale that way.

The alignment this buys is between a failure mode and its detector: a
registry regression is time-based, so a daily sweep finds it and files the
tracking issue; a diff regression is diff-based, so PR CI finds it. The
old configuration pointed the PR at the time-based mode, where it produced
186 red PRs it could neither explain nor report.

## Consequences

**Positive.**

- One fewer workflow starts on a PR that does not touch the README
  system, and with it one of the five concurrent macOS slots
  (`homebrew-cask`) is freed for the workflows that need macOS to
  validate a diff. Of the 104 commits merged to `main` since
  2026-05-31, 4 touch a file in the list above
  (`git rev-list --since=2026-05-31 origin/main -- <paths>`), so the
  workflow is expected to keep running on roughly 4% of PRs rather than
  100%. `readme-sync.yml`, whose `paths` list is a near-superset of this
  one, is the live control: it ran on 18 `pull_request` events in the
  same window against this workflow's 357.
- PRs stop going red for registry conditions their authors did not cause
  and cannot fix. The 90-day sample contains 18 such failures
  (13 `Homebrew`, 2 `Homebrew Cask`, and one each of `Docker Hub`,
  `winget (Windows)`, and `cargo install chordsketch`) and zero
  source-built failures.
- README changes still gate both ways: `README.md` appears in this
  workflow's `paths` *and* in `readme-sync.yml`'s, so a PR that edits an
  advertised command still runs the smoke that proves it works and the
  sync check that proves the snapshot matches.

**Negative, accepted.**

- `source-build`, `usage-smoke`, and `library-smoke`'s path-dep branch no
  longer run on a PR that leaves the README system alone. The concrete
  loss is that a PR which changes the public library API surface without
  touching `README.md` will not have the README's Library Usage snippet
  compiled against it until the next daily cron — which at that point
  builds against crates.io, not the merged tree, so the drift surfaces at
  the next release rather than at merge. `ci.yml` still builds and tests
  the workspace on every PR, but nothing else in PR CI consumes the
  crates the way an external README reader would. The measurement above
  (one source-built failure in 1,832 PR runs) is the basis for accepting
  this rather than widening `paths` to `crates/**`.
- The composite action is pinned by file (`action.yml`) rather than
  directory. If `cli-render-smoke` ever grows a second file, this entry
  must become `.github/actions/cli-render-smoke/**`.

**Mitigation / watch signal.** Revisit if a daily-cron or dispatch run
fails in `source-build`, `usage-smoke`, or `library-smoke` for a reason
that a PR run would have caught earlier. The structural fix at that point
is not to widen `paths` — it is the alternative below.

## Alternatives considered

- **Leave it on every PR.** Rejected on the measurement: 186 of 187
  failing jobs were unrelated to the diff, none of them reportable
  (`report-failure` skips PR events), at a p90 of 26.4 min and one of the
  five macOS slots per PR.
- **Add `crates/**`, `Cargo.lock`, `rust-toolchain.toml` etc. to
  `paths`.** This preserves coverage for the three source-built jobs, but
  most PRs in this repo touch `crates/**`, so it recovers essentially none
  of the cost the change exists to recover. It is also exactly the
  transitive-dependency list that went stale in #2608 / #2636.
- **Move the three source-built jobs into `ci.yml` and leave
  `readme-smoke.yml` as a pure distribution-channel sweep on cron.** This
  is the structurally correct split — the two concerns
  have different failure modes, different detectors, and different owners
  — and it loses no coverage at all, because `ci.yml` already runs on
  every PR and is where the required checks live. It is deferred, not
  rejected: it is a larger change to the repo's most load-bearing
  workflow, and `readme-smoke.yml` was concurrently being edited by
  [#2778](https://github.com/koedame/chordsketch/pull/2778) (ADR-0039).
  Recorded here as the answer if the watch signal above fires.
- **Gate the jobs individually with a path-filter action
  (`dorny/paths-filter`) inside one workflow.** Same end state as the
  previous option, but it introduces a third-party action and a second
  path-expression language into a workflow that already has a path
  filter, to express something GitHub expresses natively at the workflow
  level.

## References

- `.github/workflows/readme-smoke.yml` — the trigger and the inline
  rationale this ADR backs.
- `.github/workflows/readme-sync.yml` and
  [`readme-sync.md`](../../.claude/rules/readme-sync.md) — the
  paths-scoped gate that keeps `README.md` and the smoke coverage in
  sync; unchanged by this ADR.
- `.github/workflows/deploy-playground.yml` — the two path-filter
  incidents (#2608, #2636) that set the bar this path list has to clear.
- [`one-pr-at-a-time.md`](../../.claude/rules/one-pr-at-a-time.md) — the
  5-concurrent-macOS-job ceiling that makes `homebrew-cask` expensive on
  a PR.
- [ADR-0002](0002-aur-smoke-coverage-exemption.md) — the prior decision to
  omit a smoke channel from this workflow on cost grounds.
- [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md) — removed
  this workflow's `release: published` trigger, leaving the daily cron as
  the sole scheduled detector for the published channels.
- Watch signal: a cron or dispatch failure in `source-build`,
  `usage-smoke`, or `library-smoke` that a PR run would have caught.
