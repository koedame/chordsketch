# 0003. GitHub Merge Queue replaces the auto-update-branch cascade

- **Status**: Accepted
- **Date**: 2026-04-22

## Context

Until #2107 / #2123, the `main` branch's serialization model relied
on `.github/workflows/auto-update-branch.yml`. After every merge to
`main`, that workflow walked every other open PR and pushed an
"update branch" against it, which re-triggered CI on every PR from
scratch. Two compounding pressures made the cost of this model
visible during the 2026-04-XX merge batch:

1. **Linear-in-open-PR-count CI cost.** Each merge cost
   `O(open_PRs)` extra CI runs, not `O(1)`. With even four or five
   PRs in flight, a single merge could keep half a dozen `Test`
   matrix cells running for ten or more minutes apiece.
2. **macOS 5-job ceiling.** GitHub-hosted runners cap macOS jobs at
   5 concurrent on the Free / Pro / Team plans
   (https://docs.github.com/en/actions/reference/actions-limits).
   The repo has 9 macOS-bearing workflows (see
   `.claude/rules/ci-parallelization.md` §5), and the cascade's
   re-run fan-out turned that ceiling into a 20+ minute queue in
   practice — the actual measured impact that motivated #2107.

#2112 added the `merge_group:` trigger to `ci.yml`, making the
required status checks (`Format`, `Clippy`, `Test (matrix × 6)`)
fire on the speculative merge commit GitHub builds for queued PRs.
That change was a necessary precondition for any merge-queue
adoption decision but did not by itself enable the queue.

## Decision

Adopt **GitHub Merge Queue** on `main` and remove
`auto-update-branch.yml`. Specifically:

- Branch protection on `main` requires the merge queue (Settings →
  Branches → "Require merge queue").
- Required status checks (`Format`, `Clippy`, `Test (matrix × 6)`)
  remain unchanged; the queue gates on these via the
  `merge_group:` trigger added in #2112.
- Workflows producing a required check MUST include `merge_group:`
  alongside `pull_request:`. Non-required workflows MUST NOT add
  `merge_group:` (the queue does not gate on them; adding the
  trigger only burns CI minutes).
- The bot-driven merge prohibition from `pr-workflow.md` ("Why bots
  do not merge") is preserved. A human still clicks "Merge when
  ready" / runs `gh pr merge --merge-queue` to enter the queue.

## Rationale

1. **Merge Queue eliminates the cascade.** GitHub builds the
   speculative merge commit and runs CI exactly once per queued
   merge. Per-merge CI cost goes from `O(open_PRs)` back to
   `O(1)`. The macOS 5-job ceiling still applies to the queue's
   own CI runs, but only one queue position is active at a time —
   the ceiling stops being the practical bottleneck.
2. **The required-check surface is already aligned.** All required
   checks live in `ci.yml`, which already has `merge_group:` from
   #2112. No additional workflow plumbing is required for the
   queue to be operational the moment branch protection is flipped.
3. **The "humans merge" invariant is preserved.** The historical
   reason the repo banned bot-driven merging — silent merges with
   non-required checks failing (`pr-workflow.md` §"Why bots do not
   merge") — still applies under the queue. A human inspects the
   full check rollup before clicking "Merge when ready"; the queue
   does not replace that gate, it only replaces the
   serialize-after-click step.

## Consequences

Positive:

- Per-merge CI cost is `O(1)` instead of `O(open_PRs)`.
- No more rebase-cascade churn on every open PR after a merge.
- The serial-PR discipline in `one-pr-at-a-time.md` becomes a soft
  load-management policy ("keep the queue short") rather than a
  hard correctness requirement.
- One fewer workflow to maintain (`auto-update-branch.yml`
  deleted).

Negative:

- `merge_group:` events run with the **same secret access as
  `push:` to a protected branch** — unlike `pull_request:` from
  forks, which run with restricted permissions. A queued PR that
  modifies `.github/workflows/`, build scripts, or anything that
  executes during CI on the speculative merge commit gains
  secret-bearing CI. Mitigation: the human "Merge when ready"
  click is the gate. `pr-workflow.md` now requires reviewers to
  scrutinise diffs touching `.github/` or any CI step before
  queuing — treat workflow-file diffs the same as a `push:`
  directly to `main`.
- The macOS 5-job ceiling can still throttle the queue itself if
  many PRs queue at once. The serialization in
  `one-pr-at-a-time.md` is the management lever here; it now reads
  as "keep the queue short to keep wait time bounded" rather than
  "avoid the rebase cascade."
- Content conflicts (two PRs touching the same lines) are still
  not resolved by the queue — `auto-rebase.yml` and
  `auto-resolve-conflicts.yml` are intentionally retained for that
  path.

## Alternatives considered

- **Keep the cascade with `cancel-in-progress` on every workflow.**
  This was the partial mitigation taken in #2108 (concurrency
  groups added to seven heavy workflows). It clamped the worst
  cases but did not change the `O(open_PRs)` shape — every merge
  still re-triggered CI on every other PR. The cascade's
  fundamental cost model is incompatible with multi-PR throughput,
  so cancel-in-progress was triage, not a destination.
- **Drop the cascade and require contributors to manually
  `gh pr update-branch` before merging.** Rejected. Manual updates
  defeat the cascade's only purpose (ensuring CI was current
  against `main`) by moving the burden onto every contributor for
  every merge. The queue automates exactly the same step without
  adding a human checkbox.
- **Adopt a third-party merge-train tool (Mergify, Bors, etc.)**.
  Rejected. GitHub Merge Queue covers the current need natively,
  with no additional secrets, hosted-service availability, or
  vendor lock-in. Should the queue prove insufficient (e.g. for
  cross-repo PR batching), a future ADR can revisit.

## References

- Issue #2107 (this ADR resolves the rationale half of)
- PR #2112 (added `merge_group:` trigger to `ci.yml`)
- PR #2108 (cancel-in-progress mitigation that preceded the queue)
- PR #2115 (closed `ci-parallelization.md` §5 gaps; release-variant
  `cancel-in-progress: false` documented)
- PR #2123 (this ADR's implementation: removed
  `auto-update-branch.yml`, updated `pr-workflow.md`,
  `one-pr-at-a-time.md`, `ci-parallelization.md`, `CONTRIBUTING.md`)
- GitHub docs:
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- Actions runner limits:
  https://docs.github.com/en/actions/reference/actions-limits

Watch signals that should prompt revisiting this decision:

- A regression where queued PRs land with non-required checks red
  (would indicate the human-as-gate model has degraded — the same
  failure mode that originally banned bot-driven merging).
- macOS-runner capacity changing on the GitHub plan (would change
  the §1 / §5 motivation in `one-pr-at-a-time.md` and possibly
  this ADR's positive consequences).
- Native cross-repo or stack-PR support landing in GitHub Merge
  Queue, which would let the project drop the
  `one-pr-at-a-time.md` parallel-PR exception entirely.
