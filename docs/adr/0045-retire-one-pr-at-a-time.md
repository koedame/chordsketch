# 0045. Retire the one-PR-at-a-time serialisation rule

- **Status**: Accepted
- **Date**: 2026-09-01

## Context

`.claude/rules/one-pr-at-a-time.md` capped the number of open
maintainer-authored PRs against `main` at one: a new PR could not be
opened until the previous one had merged and its branch (and worktree)
was cleaned up. The rule rested on two premises:

1. **Runner concurrency cap.** GitHub-hosted runners cap concurrent
   macOS jobs at 5 on the Free / Pro / Team plans
   (https://docs.github.com/en/actions/reference/actions-limits), and
   this repo has many macOS-bearing workflows, so the macOS ceiling —
   not the 20-job total — is the practical bottleneck. This fact is
   also recorded in
   [`ci-parallelization.md`](../../.claude/rules/ci-parallelization.md)
   §5, which is where it survives this ADR.
2. **Rebase churn after every merge.** Branch protection requires PR
   branches to be up to date with `main` before merging, so every
   landed PR pushes every other open PR into a rebase + CI re-run.

The rule's standing has been narrowing since it was written.
[ADR-0003](0003-github-merge-queue.md) already downgraded it from a
hard correctness requirement to "a soft load-management policy";
[ADR-0015](0015-disable-github-merge-queue.md) rationale 3 then leaned
on it when retiring the merge queue. The rule itself carved out
Dependabot PRs entirely, allowed documentation-only PRs to overlap,
and admitted an exception clause for disjoint-file parallel PRs.

Three facts moved the balance.

**The contention is real, but it is largely produced by the classes the
rule does not govern.** Sampling every `ci.yml` job from
2026-08-30 15:54 UTC to 2026-08-31 17:46 UTC (120 macOS jobs across 24
branches) via

```bash
gh run list -R koedame/chordsketch --workflow ci.yml --limit 80 \
  --json databaseId,headBranch
gh api "repos/koedame/chordsketch/actions/runs/<id>/jobs?per_page=100" \
  --jq '.jobs[] | select(.started_at != null)
        | [.name, .created_at, .started_at, (.labels[0] // "?")] | @tsv'
```

and computing `started_at - created_at` per job:

| macOS jobs | n | median | p90 | max |
|---|---|---|---|---|
| Only one branch had macOS jobs within ±10 min | 28 | 12 s | 394 s | 563 s |
| Two or more branches within ±10 min | 92 | 25 s | 997 s | 1567 s |

So parallel branches do cost queue latency. But 28 of the 120 macOS
jobs were on `dependabot/*` branches, which the rule exempted; 12 of
the 30 jobs that waited longer than 300 s were Dependabot's own; 13 of
the 20 longest waits fell in windows that contained a Dependabot
branch; and pushes to `main` occupy the same slots (one `main` macOS
job in the sample waited 1209 s). Serialising maintainer PRs alone does
not remove the bottleneck the rule was written to remove.

**The mechanised form of the rule was stricter than its text.** The
`autopilot-issue` workflow's `preconditions` phase HALTed a whole round
when `gh pr list --author "@me" --state open --base main` returned
anything — including the documentation-only PRs the rule's own
exception clause explicitly permits to overlap. With three PRs open on
2026-08-31 (#2802, #2804, #2805 — one workflow file, one packaging
script, one release-notes fix), the batching workflow
[ADR-0019](0019-batch-mode-autopilot-issue.md) adopted *for throughput*
could not start at all.

**Practice had already diverged from the rule.** Those three PRs were
open simultaneously against `main`, outside the documented exception
criteria (no hard deadline, no recorded parallel-window note in the PR
bodies), and all of their checks passed.

## Decision

Retire the serial-PR rule.

- Delete `.claude/rules/one-pr-at-a-time.md`. There is no cap on the
  number of PRs open against `main`, and no exception clause to
  document in a PR body.
- Remove the one-PR-at-a-time HALT gate from the `autopilot-issue`
  workflow's `preconditions` phase and from the workflow's HALT-trigger
  list. The remaining precondition checks are renumbered; none of them
  change.
- Update the pointer in
  [`workflow-discipline.md`](../../.claude/rules/workflow-discipline.md)
  and the rationale comment in `.github/workflows/desktop-build.yml`,
  which now cite `ci-parallelization.md` §5 for the macOS ceiling.
- Record the cost of parallelism where the ceiling already lives:
  `ci-parallelization.md` §5 gains an advisory note that concurrent PRs
  contend for the 5-job macOS ceiling, with the measured numbers above.
  It is advice for choosing how much to have in flight, not a
  prohibition, and nothing gates on it.

Unchanged by this ADR:

- Branch protection: status checks green on HEAD, branch up to date
  with `main` before merging, squash merge only.
- [ADR-0013](0013-conditional-bot-driven-merge.md)'s four-condition
  bot-merge gate, including condition (2) (full check rollup green).
- The shared-files policy in
  [`parallel-work.md`](../../.claude/rules/parallel-work.md):
  `CLAUDE.md`, `.claude/rules/`, `.github/`, and workspace
  `Cargo.toml` changes still go through dedicated PRs.
- The rebase protocol and the worktree isolation rules for concurrent
  instances.

## Rationale

1. **Serialisation was never a correctness gate, and retiring it
   removes none.** What keeps a bad merge out of `main` is branch
   protection (checks green, branch up to date) plus ADR-0013
   condition (2). The serial-PR cap only shaped *when* work entered the
   pipeline. ADR-0003 already said as much when it demoted the rule to
   load management.

2. **It constrained the wrong population.** The measurements above show
   the queue pressure is spread across Dependabot branches (exempt),
   `main` pushes (out of scope), and maintainer PRs (governed). A
   policy that can only serialise the third of those buys a fraction of
   the latency it costs in throughput.

3. **Its enforcement point blocked the throughput mechanism this repo
   deliberately adopted.** ADR-0019 chose batching precisely because
   per-PR fixed cost dominates wall clock. Gating each batch round on
   "zero open maintainer PRs" makes autopilot's availability a function
   of unrelated review latency.

4. **The cost of dropping it is bounded and already mitigated.** The
   worst observed macOS queue wait in the sample was 1567 s (26 min),
   on a Dependabot branch, in a window this rule would not have
   affected. `ci-parallelization.md` §5's concurrency groups cancel
   superseded PR runs, and [ADR-0041](0041-readme-smoke-scoped-to-readme-prs.md)
   keeps the most expensive macOS-bearing workflow off PRs that do not
   touch the README system.

5. **A rule that practice contradicts is worse than no rule.** Three
   PRs were open against `main` while the rule said one. Leaving the
   text in place would keep an unenforced prohibition that future
   sessions must reason about and then violate.

## Consequences

Positive:

- `autopilot-issue` rounds can start whenever eligible issues exist,
  instead of waiting on unrelated open PRs.
- Independent small changes (docs, CI, chore) can be in flight
  together, which is what already happens in practice.
- One rule and one HALT condition fewer to teach and to keep in sync
  with the ADR record.

Negative:

- macOS queue latency grows with the number of PRs in flight — p90
  394 s → 997 s between the one-branch and multi-branch windows
  sampled above. Mitigation: the concurrency groups in
  `ci-parallelization.md` §5 cancel superseded runs; ADR-0041 keeps
  `readme-smoke.yml` off unrelated PRs; the advisory note in §5 tells
  an author what a large batch of Rust-touching PRs costs, so the
  trade-off is a judgement call at the point of opening rather than a
  blanket ban.
- More rebases: branch protection still requires each PR branch to be
  up to date before merging, so a merge still pushes every other open
  PR into a rebase + re-run. Mitigation: the rebase protocol in
  `parallel-work.md` and `auto-rebase.yml`, which already exist for
  exactly this path.
- **This fires ADR-0015's watch signal** — "the repo's serial-PR policy
  becoming impractical … would re-introduce the queue's serialisation
  benefit". The merge queue is deliberately **not** re-enabled. The
  queue's cost was a second full required-check pass per merge (median
  ~200 s, p90 ~445 s, measured in ADR-0015) and its benefit was
  semantic-conflict detection, which is unrelated to runner contention;
  serialising merges would raise the wall-clock cost of more parallel
  PRs, not lower it. ADR-0015 rationale 3 ("serial-PR discipline
  already prevents the queue's worst case") no longer holds, but its
  rationales 1, 2 and 4 — zero queue-only-detected regressions, branch
  protection's up-to-date rule, and the safety condition living in
  ADR-0013 (b) — carry the decision on their own.

## Alternatives considered

- **Keep the rule and raise the cap to N open PRs.** Rejected. Any N is
  arbitrary: the real constraint is macOS runner slots, and a PR's slot
  cost is not one-per-PR. After ADR-0041 a docs PR can start zero
  macOS-bearing smoke jobs while a Rust PR starts the two `Test`
  macOS cells. Counting PRs does not measure the thing that queues.
- **Keep the rule but scope it to PRs that touch Rust or
  `.github/workflows/`.** Closer to the real cost model, but the gate
  that implements it (`gh pr list --author --base`) cannot see file
  paths without another API round trip per PR, and the largest single
  contributor to the measured contention — Dependabot — would still be
  exempt. The remaining benefit did not justify keeping a rule with an
  exception clause, a carve-out list, and a workflow HALT.
- **Delete only the autopilot HALT gate and keep the rule as written
  guidance.** Rejected. That leaves a documented prohibition that
  current practice already contradicts, which is the state this ADR
  exists to end. Guidance about the cost belongs in
  `ci-parallelization.md` §5, next to the ceiling it derives from.
- **Do nothing.** Rejected: the gate blocks `autopilot-issue` whenever
  any maintainer PR is open, including the docs-only PRs the rule's own
  text permits to overlap.

## References

- [ADR-0003](0003-github-merge-queue.md) — demoted the serial-PR rule
  to load management (superseded by ADR-0015).
- [ADR-0015](0015-disable-github-merge-queue.md) — retired the merge
  queue; its rationale 3 and one of its watch signals reference the
  rule this ADR retires.
- [ADR-0019](0019-batch-mode-autopilot-issue.md) — batch-mode autopilot;
  its "parallel single-issue PRs" alternative cited the rule's
  exception clause.
- [ADR-0041](0041-readme-smoke-scoped-to-readme-prs.md) — cites the
  macOS ceiling; that citation now resolves to
  `ci-parallelization.md` §5.
- [ADR-0013](0013-conditional-bot-driven-merge.md) — the merge gate
  that is unchanged by this ADR.
- [`ci-parallelization.md`](../../.claude/rules/ci-parallelization.md)
  §5 — the macOS 5-job ceiling and the concurrency groups that absorb
  superseded runs.
- Actions runner limits:
  https://docs.github.com/en/actions/reference/actions-limits

Watch signals that should prompt revisiting this decision:

- macOS queue waits on `ci.yml` PR runs rising to the point that the
  p90 exceeds the job's own runtime, measured with the commands in the
  Context section — would mean the advisory note in §5 is not enough
  and some form of admission control is needed.
- A `main` CI failure spike traceable to semantic conflicts between
  PRs that landed close together — would indicate the rebase-before-
  merge contract is no longer sufficient without serialisation, and
  would reopen ADR-0015's watch signal on its own terms.
