# 0015. Disable GitHub Merge Queue (supersedes ADR-0003)

- **Status**: Accepted
- **Date**: 2026-05-03

## Context

[ADR-0003](0003-github-merge-queue.md) adopted GitHub Merge Queue
in #2123 to retire the `auto-update-branch.yml` cascade. The queue
solved the cascade's `O(open_PRs)` CI fan-out problem by serialising
merges through a single speculative-merge CI run per queued PR.

In the months since adoption, the principal cost shifted from CI
fan-out (gone) to **merge wall-clock latency**. The queue's
speculative merge commit re-runs the full required-check matrix on
top of the PR's pre-merge CI, so every merge pays the
`Test (matrix × 6)` cost twice: once as `pull_request:` on the head
commit, then again as `merge_group:` on the speculative merge
commit. Measured against the most recent 30 successful
`merge_group:` runs of `ci.yml`
(`gh run list --workflow=ci.yml --event=merge_group --limit 30`),
the second pass added a median of ~200 s (~3.3 min) and a 90th-
percentile of ~445 s (~7.5 min) to every merge — i.e., the
click-to-landed window typically grew by 3–8 minutes per PR, on
top of the original pre-merge CI duration.

The benefit of the second pass — catching semantic conflicts that
manifested only when the PR diff is composed against the current
tip of `main` — has been low at this repo's scale. The pre-merge CI
already runs against a recent base, contributors rebase before
opening the PR, and content conflicts (the only conflict class the
queue can detect) are caught earlier by the existing branch
protection's "Branch must be up to date before merging" rule when
that rule fires. The empirical record across the queue's active
period (sampled via
`gh run list --workflow=ci.yml --event=merge_group --status=failure --limit 100`)
returned exactly two `merge_group` failures, and inspection of
both runs (24845736567 — Format step `HTTP 500` from
`actions/checkout`; 24973252062 — non-required Desktop smoke job
flake) confirmed both were transient GitHub-infra failures, not
semantic conflicts a pre-merge CI run had missed. Zero
queue-only-detected regressions across the queue's active period
is the load-bearing data point for the cost-benefit shift.

The cost-benefit traded that motivated ADR-0003 was
"`O(open_PRs)` CI fan-out vs. one extra CI pass per merge." With
the cascade gone permanently and serial merge discipline already
encoded in `.claude/rules/one-pr-at-a-time.md`, the second pass is
no longer load-bearing.

## Decision

Disable GitHub Merge Queue on `main` and return to direct
squash-merges. Specifically:

- Branch protection on `main` removes the "Require merge queue"
  setting. The "Require status checks to pass before merging" and
  "Require branches to be up to date before merging" rules stay in
  place — those are what gate semantic-conflict cases under the new
  flow.
- All PRs continue to be **squash-merged** (merge commits and
  rebase merging remain disabled). Squash is enacted via
  `gh pr merge <N> --squash` or the GitHub UI's "Squash and merge"
  button.
- The `auto-update-branch.yml` cascade is **not** reintroduced.
  Authors rebase manually when `main` moves and their PR has fallen
  behind, per the existing rebase protocol in
  `.claude/rules/parallel-work.md`.
- `merge_group:` triggers in `.github/workflows/*.yml` may stay as
  cheap no-ops (they simply will not fire) or be cleaned up in
  follow-up PRs. They are NOT load-bearing under this ADR.
- Bot-driven merge under explicit per-session permission
  ([ADR-0013](0013-conditional-bot-driven-merge.md)) is preserved.
  Condition (4) of that ADR's four-clause gate becomes
  "**Direct squash merge.** Use `gh pr merge --squash` (or the
  equivalent `mergePullRequest` GraphQL mutation)." Auto-merge
  remains disabled at the repository level
  (`enablePullRequestAutoMerge: false`); the assistant's
  `--squash` invocation runs synchronously against the PR's
  current HEAD, not as a deferred trigger.

## Rationale

1. **Wall-clock cost was paid twice per merge for a benefit that
   never observably fired.** Required-check cells ran once on the
   PR's head commit and once on the speculative merge commit. Both
   passes covered the same code with the same `Cargo.lock`; the
   second pass differed only in being composed against the most
   recent `main`. The Context section records zero queue-only-
   detected regressions across the queue's active period; semantic
   conflicts that would survive both the author's local build and
   the PR's pre-merge CI are bounded by that empirical record.

2. **Branch protection's existing "must be up to date" rule
   covers the conflict class the queue detected.** GitHub blocks
   the merge button if `main` has moved since the PR's last
   rebase, which forces the author to rebase and re-run pre-merge
   CI before merging. That re-run is functionally equivalent to
   the queue's speculative merge commit for content-conflict
   purposes — the difference is that the rebase happens on the
   author's branch (visible in the PR's CI tab) rather than on a
   GitHub-internal `gh-readonly-queue/*` ref.

3. **Serial-PR discipline already prevents the queue's worst
   case.** `.claude/rules/one-pr-at-a-time.md` caps the open-PR-
   against-`main` count at 1. The queue's serialisation was
   redundant on top of that policy: there was rarely more than one
   PR queued at a time, so the queue's "wait your turn" semantic
   added no ordering the policy did not already provide.

4. **The bot-driven merge gate's protection is not in the queue.**
   ADR-0013's four conditions check (a) explicit per-session
   permission, (b) full check rollup green, (c) auto-review
   converged, and (d) merge-queue path. The protection against the
   "silent merge with non-required check failing" failure mode that
   originally banned bot-driven merging lives in condition (b),
   not (d). Replacing (d) with "direct squash merge" preserves the
   structural safety condition (b) provides while dropping the
   queue dependency.

## Consequences

Positive:

- Click-to-landed wall-clock drops by one full required-check
  matrix run per merge. Sampled across the most recent 30
  successful `merge_group:` runs, the second pass added a median
  of ~200 s (~3.3 min) and a 90th-percentile of ~445 s (~7.5 min)
  per merge; that range is the expected wall-clock saving.
- One fewer infrastructural concept (`merge_group:` events,
  `gh-readonly-queue/*` refs, queue position UI) to teach new
  contributors and to track in `.claude/rules/`.
- `gh pr merge --squash` is the canonical merge command across
  CI-using sessions, including assistant-driven merges, eliminating
  the special-case `enqueuePullRequest` / `--merge-queue` paths.

Negative:

- Semantic conflicts that the queue's speculative CI would have
  caught now surface as `main` CI failures after the merge lands.
  Mitigation: the "must be up to date before merging" rule forces a
  rebase before merge whenever `main` has moved; that rebase
  re-runs pre-merge CI against the same composition the queue's
  speculative merge would have. The narrow remaining window — `main`
  moving between rebase and click — is structurally identical to
  the rebase-before-merge requirement and acceptable at this repo's
  pace.
- The historical guard documented in
  `pr-workflow.md` §"Historical rationale (superseded)" — that the
  queue prevents a bot from silently merging with red required
  checks — moves entirely onto ADR-0013 condition (b) (full check
  rollup green). That condition is still a hard pre-merge gate, so
  the protection is preserved, but it is now policy-only rather
  than policy + structural.

## Alternatives considered

- **Keep the queue with a leaner required-check matrix.** Removing
  Windows / macOS cells from the required set would shorten queue
  CI but trade away the very coverage the queue was meant to
  enforce on the speculative commit. Rejected: the wait-time
  problem stems from the queue's serialisation shape, not just its
  required-check breadth.
- **Keep the queue with a per-PR opt-out for trivial diffs.**
  GitHub Merge Queue does not support per-PR bypass cleanly; the
  closest equivalent (admin-merge) defeats the queue's purpose
  whenever it is used. Rejected.
- **Adopt a third-party merge-train (Mergify, Bors, etc.)** that
  exposes finer queue controls. Rejected for the same reasons
  ADR-0003 rejected this option: vendor lock-in, additional
  secrets, and additional hosted-service availability without
  addressing the wall-clock concern this ADR is fixing.
- **Re-enable `auto-update-branch.yml`.** Rejected. The cascade's
  `O(open_PRs)` CI fan-out is precisely what ADR-0003 retired. No
  serialisation is needed under the existing serial-PR policy; the
  rebase-before-merge contract handles the rare case where a PR
  has fallen behind `main`.

## References

- [ADR-0003](0003-github-merge-queue.md) — adopted the merge queue
  (this ADR supersedes it).
- [ADR-0013](0013-conditional-bot-driven-merge.md) — bot-driven
  merge gate; condition (4) is updated by this ADR.
- Issue #2386 — tracker for this change.
- GitHub docs on merge queue (for re-evaluation):
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue

Watch signals that should prompt revisiting this decision:

- A `main` CI failure rate spike traceable to semantic conflicts
  that a rebase-before-merge did not catch — would indicate the
  queue's second CI pass was load-bearing in a class of conflicts
  not covered by branch protection's "must be up to date" rule.
- The repo's serial-PR policy in
  `.claude/rules/one-pr-at-a-time.md` becoming impractical (e.g. a
  push toward parallel feature delivery), which would re-introduce
  the queue's serialisation benefit.
- A regression where bot-driven merges land with red non-required
  checks — would indicate ADR-0013 condition (b) drifted, in which
  case the queue's structural protection should be reconsidered as
  defence in depth.
