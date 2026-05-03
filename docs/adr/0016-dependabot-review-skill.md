# 0016. Dependabot review moves from a CI bot to a session skill; major bumps are no longer suppressed

- **Status**: Accepted
- **Date**: 2026-05-03

## Context

Two prior decisions defined the previous Dependabot flow:

- `.github/workflows/claude-dependabot.yml` ran `anthropics/claude-code-action`
  on every Dependabot PR, asking it to read the diff, run CI, and call
  `gh pr review --approve` on success. The intended effect was that a
  human merger could squash-merge a green Dependabot PR with a
  pre-existing automated review attached.
- `.github/dependabot.yml` carried `ignore: version-update:semver-major`
  for every dependency in both ecosystems (`github-actions`, `cargo`).
  The closing comment in #1838 stated the rationale: the auto-approval
  path could not reliably catch behaviour deltas that did not show up
  in a unit-test diff (e.g. `actions/checkout@v4 → @v5` changed the
  default `fetch-depth`), so major bumps were forced through a
  human-driven PR that read the dependency's release notes first.

Both decisions were entangled: blocking majors was specifically the
hedge against the auto-approval path's inability to reason about
behaviour changes. The hedge made sense as long as the auto-approval
path was carrying the load.

The auto-approval path is no longer carrying the load. Sampling the
seven Dependabot PRs open at the time of this ADR (#2378–#2384), every
one shows `claude-review fail` in the check rollup, with the job
exiting in 19–28 s. The workflow is firing, but no review signal is
being produced. Branch protection does not list `claude-review` in
`required_status_checks.contexts`, so the failures do not block merge —
they just sit red on the PR while the maintainer applies an entirely
manual review by hand.

The state of "no working automated review AND a hard block on
major-version PRs ever appearing" combines the worst of both regimes:
the maintainer pays the audit cost manually anyway, and the upgrade
backlog of major versions is invisible because Dependabot is
suppressing the PRs that would surface it.

## Decision

1. **Delete `.github/workflows/claude-dependabot.yml`.** Dependabot
   PRs receive no automated review. `.github/workflows/claude-review.yml`
   continues to skip Dependabot PRs (its existing branch covers the
   not-this-workflow case).

2. **Stop ignoring `version-update:semver-major` in `.github/dependabot.yml`.**
   Every dependency update — patch, minor, AND major — opens a
   separate Dependabot PR per ecosystem.

3. **Introduce `.claude/commands/dependabot-review.md` (the
   `/dependabot-review` slash command).** When the maintainer invokes
   this command, Claude iterates over every open Dependabot PR
   sequentially. For each PR it audits the dependency (CHANGELOG /
   release notes, advisory database lookup, repository-activity
   sniff-test for malicious-commit indicators), runs build / test /
   clippy on the PR's branch in an isolated worktree, applies any
   required code-side fixes as commits on the Dependabot branch, and
   on a clean result performs `gh pr merge <N> --squash`. PRs that
   the audit cannot clear are reported and skipped, not merged.

4. **The four conditions of [ADR-0013](0013-conditional-bot-driven-merge.md)
   continue to govern bot-initiated merges.** The skill operates
   under that gate as follows:

   - **Condition 1 (per-session permission)**: the maintainer's
     invocation of `/dependabot-review` IS the per-session grant. No
     additional verbal permission is required for the merges the
     skill performs in that invocation.
   - **Condition 2 (full check rollup green)**: the skill verifies
     `gh pr checks <N>` shows every check in `pass` or `skipping`
     before each merge. A `fail` or `pending` blocks that PR.
   - **Condition 3 (auto-review converged on HEAD)**: there is no
     longer an `auto-review` job. The skill's own audit + build +
     test + fix-commit cycle IS the converged review for the PR,
     and the skill must complete that cycle on the latest commit
     before merging.
   - **Condition 4 (direct squash merge)**: `gh pr merge <N> --squash`,
     unchanged.

## Rationale

### Why delete the auto-review workflow rather than fix it?

The seven failing runs predate this ADR by hours, but the workflow
has been broken long enough that the policy of "automated review
gates merge" was already de facto suspended. Repairing the workflow
would re-introduce the failure mode that motivated the major-block
in the first place — an automated reviewer that cannot reason about
behaviour deltas, gating an automated approval that the maintainer
trusts more than they should. The skill replaces that with an
explicitly maintainer-triggered review cycle whose outputs are
visible to the same human in real time.

### Why surface major bumps now?

The major-block was a hedge against the auto-approval path. With
that path removed, the hedge protects nothing. The skill applies
the same audit depth to a major bump as to a patch bump (CHANGELOG
read, advisory check, build/test, fix-or-skip), and the maintainer
sees the result before any merge happens. Suppressing the PRs
entirely would leave the upgrade backlog invisible to both the
maintainer and the skill.

### Why per-PR audits instead of a grouped Dependabot PR?

`groups:` in `dependabot.yml` would consolidate, for example, all
seven currently-open `cargo` patch bumps into one PR. That makes
the audit harder, not easier: one bad dependency in the group can
no longer be skipped without unwinding the whole grouped PR through
`@dependabot recreate`. The per-PR layout matches the per-PR audit
the skill performs, and the skill loop already removes the human
cost of "many PRs to look at."

### Why retain the four-clause merge gate from ADR-0013?

The two original failure modes of bot-driven merge — silent merge
of red non-required checks (clause 2) and inheritance of merge
authority across sessions (clause 1) — are independent of who runs
the audit. The skill is no exception: an unaudited green check
rollup is still the contract that lets the maintainer trust an
automated merge, and per-session permission is still the
checkpoint that keeps the assistant from inheriting authority from
sessions the maintainer no longer recalls.

## Consequences

**Accepted:**

- Dependabot now opens more PRs, including ones the previous
  configuration silently suppressed. The maintainer has to invoke
  `/dependabot-review` (or process them by hand) to drain the
  backlog. Mitigation: the skill is sequential and idempotent, so
  invoking it once when convenient handles the queue.
- The skill's audit is only as deep as the prompt. A maintainer
  who delegates without reviewing the skill's verdicts is taking
  on the same risk the deleted workflow was taking on.
  Mitigation: the skill posts a per-PR summary before each
  merge, so the rollup is visible after the fact.

**Gained:**

- Major-version bumps stop accumulating invisibly. The maintainer
  sees them on the next `/dependabot-review` invocation alongside
  patches and minors.
- The "claude-review red, merge anyway" failure mode is gone:
  the workflow that was producing the red signal no longer exists.
- The audit step gains the ability to **fix** breakage in the
  same loop, where the deleted workflow could only **report** it.
  Major-version PRs that need a code-side adaptation now land
  with the adaptation as part of the same PR's commit history,
  rather than a follow-up branch.

**Negative:**

- Until `/dependabot-review` is invoked, Dependabot PRs sit open
  with no review signal at all. A maintainer who forgets to run
  the skill faces a longer backlog than under the previous
  (broken) workflow. Mitigation: the skill is cheap to invoke,
  and the previous workflow was producing a misleading signal,
  not an actually-protective one.

## Alternatives considered

1. **Repair `.github/workflows/claude-dependabot.yml`.** Rejected.
   Even a working version of the workflow re-introduces the
   "approval gates merge for a class of changes the reviewer
   cannot reliably reason about" failure mode that motivated the
   major-block. The fix would be a fragile improvement to a
   layered system the maintainer was already bypassing in
   practice.

2. **Repair the workflow AND keep the major-block.** Rejected.
   This is the previous regime. It made sense as long as the
   workflow was carrying load; with the workflow producing no
   review signal, the major-block is hiding upgrade work for no
   compensating gain.

3. **Group all Dependabot updates into one PR per ecosystem.**
   Rejected. Grouping makes per-dependency audit harder and
   couples merge fate across unrelated dependencies. The skill
   loop addresses the multi-PR friction without the coupling
   cost.

4. **Move review into a pre-merge GitHub Action that runs the
   same audit the skill runs.** Considered. Rejected for now
   because the audit involves reading external CHANGELOGs and
   advisory feeds, which is where the deleted workflow's
   reliability problems originated. Re-running the same shape
   of action on the same shape of input is unlikely to land
   somewhere fundamentally different. If the skill's audit
   stabilises into something genuinely deterministic, this
   option can be revisited as a follow-up ADR.

## References

- Issue #2391 — this ADR's tracking issue.
- Issue #1838 — the prior decision to block `version-update:semver-major`,
  superseded by this ADR.
- [ADR-0013](0013-conditional-bot-driven-merge.md) — the four-clause
  bot-merge gate the skill operates under.
- `.claude/commands/dependabot-review.md` — the skill body.
- `.claude/rules/pr-workflow.md` §"Bot-driven merge: conditional
  permission" — the rule text that mirrors ADR-0013 for the active
  workflow.
- PRs #2378–#2384 — the snapshot of failing `claude-review` runs
  that motivated the workflow deletion.
