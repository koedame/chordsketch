# 0019. Batch-mode autopilot-issue workflow

- **Status**: Accepted
- **Date**: 2026-05-17

## Context

The `autopilot-issue` workflow ([ADR-0018](0018-phase-based-shell-orchestrated-workflows.md))
shipped as a strictly per-issue handler: each run picked one
autonomous-eligible issue authored by `unchidev`, opened one PR for
it, drove that PR to Ready-for-merge, and stopped. A 5-round session
on 2026-05-16/17 produced PRs #2472, #2474, #2475, #2477, #2487, #2489
following that mode.

The observed cost per merged PR was ~45-90 min of wall-clock.
Breaking that down:

- Implementation phase: ~15-30 min (actual coding).
- Per-PR ceremony (worktree create, branch push, PR open): ~2 min.
- CI matrix on PR open: ~8-10 min (cross-platform builds dominate).
- Auto-review iteration: 5-15 min (one full review, often one delta).
- CI matrix re-run after each fix commit: ~8-10 min per iteration.
- Manual merge + cleanup: ~1 min.

For an issue whose actual code change is 20 lines, the per-PR fixed
cost (CI, auto-review ceremony, merge gate) dwarfs the implementation
time by 2-3x. Across the 5 rounds we observed this loop tax compound
into ~5 hours of wall-clock for ~6 merged PRs that collectively
changed ~600 lines of code.

## Decision

The `autopilot-issue` workflow now operates in **batch mode**:

1. `issue-selection` returns the array of all
   high-confidence autonomous-eligible candidates (4-axis triage min
   ≥ 80), capped at 10 per round.
2. `implementation` loops over the selected issues in dependency /
   simplicity order, applying each in turn within a single worktree
   and a single branch named `batch-YYYY-MM-DD-N1-N2-...`. One
   commit per issue (`feat(crate): subject (#N)` with `Closes #N` in
   the body) preserves issue-to-change attribution for in-PR
   review and `git bisect`.
3. `pr-review` opens **one PR** that aggregates every successful
   issue. PR body documents each issue separately under
   per-issue "What changed" sections, lists `Closes #N` once per
   issue, and emits one combined sister-site audit.
4. Per-issue failures during execution attempt a corrective-action
   retry loop (up to 3 attempts) before reverting the issue's
   commit and marking it as a Deferred entry in the PR body. The
   remainder of the batch continues.

Squash-merge to `main` collapses every issue's commit into one
landing commit per established practice
([pr-workflow.md](../../.claude/rules/pr-workflow.md)), but the
in-PR per-issue commits remain visible on the PR for review.

## Rationale

The fixed CI / auto-review / merge cost dominates per-PR wall-clock
when issues are small. Batching trades a smaller number of larger
PRs for a much larger number of smaller PRs at the same total work:

| Mode | PRs for 6 issues | CI matrix runs | Auto-review cycles |
|---|---|---|---|
| Per-issue (old) | 6 | ~12 (open + 1 fix-commit each) | 6 separate, ~12 total iterations |
| Batch (new) | 1 | ~2 (open + 1 fix-commit) | 1 review pass, ~2 delta cycles |

Even accounting for the larger diff in batched PRs (~600 lines vs
~100 lines per issue) increasing the auto-review compute cost
linearly, the ~6x reduction in CI matrix runs is the dominant saving.

**4-axis confidence floor raised to ≥80**: per-issue mode used a
floor of ≥70 for "autonomous-eligible". In batch mode, one issue's
failure can poison the whole batch (it consumes the worktree,
forces the fallback retry-loop, and risks polluting later issues'
context). Raising the bar to ≥80 picks fewer issues per round but
those that are picked succeed at a higher rate. Issues in the
70-79 band are not lost — they remain eligible for single-issue
mode (which we keep as a degenerate case: a batch of 1).

**Cap at 10**: PRs of arbitrary size exist (legitimate sweeping
refactors, generated-code bumps), but autopilot-produced batches
should remain reviewable by a human as a unit. 10 small issues is
~600 lines of curated diff plus tests — at the upper end of
practical single-sitting review.

**Branch naming `batch-YYYY-MM-DD-N1-N2-...`**: keeps the
established `issue-{N}-{slug}` convention for the degenerate
single-issue batch case (a 1-issue batch is still
`issue-{N}-{slug}`), while making multi-issue batches discoverable
in `git branch -a` output. The date prefix sorts batches
chronologically and avoids ambiguity with reissued issue numbers.

## Consequences

**Positive**:

- ~6x fewer CI matrix runs and ~6x fewer auto-review cycles for
  the same merged-issue throughput.
- Sister-site audit happens once per batch instead of N times,
  catching cross-issue interactions that per-PR audits miss by
  construction.
- Larger PRs invite more rigorous human review on the merge
  button, which is healthy for a workflow where the PR contents
  were produced autonomously.

**Negative**:

- Larger PRs are harder to review at one sitting. Mitigated by the
  one-commit-per-issue convention so reviewers can step through
  the diff issue-by-issue.
- A batch failure (e.g. CI red after step 8 of 10) requires more
  context to disentangle than a per-issue PR. Mitigated by the
  per-issue commit history: a reviewer can `git log` to find which
  commit introduced the regression and ask autopilot to revert
  that one in a fix commit.
- If two issues edit the same file with different intents, the
  second one's commit may have to absorb the first's changes into
  its context. The triage filter already prefers file-disjoint
  candidates; the implementation phase's per-issue cargo test
  catches conflicts before the batch commits compound.

## Alternatives considered

- **Keep per-issue mode**: rejected — the observed 45-90 min/PR
  wall-clock is dominated by per-PR fixed cost, and that cost
  doesn't shrink with codebase familiarity. The structural problem
  is structural; only batching addresses it.
- **Stack multiple PRs (one per issue, but as a chain)**: rejected —
  GitHub does not first-class PR stacks. Tools like `git town` /
  `Graphite` could simulate this but introduce a hard dependency
  this repo does not currently take. The CI re-run cost on each
  PR in the stack also doesn't shrink (each stacked PR still
  triggers its own CI matrix).
- **Parallel single-issue PRs via the existing one-pr-at-a-time
  exception clause**: rejected — the exception requires strictly
  disjoint files, which is unenforceable across autopilot-eligible
  issues whose surface areas overlap (iReal parser issues, for
  instance, all touch `crates/ireal/src/parser.rs`). Even where
  files are disjoint, the cap on macOS runner concurrency in
  `.claude/rules/ci-parallelization.md` §5 makes 5+ parallel PRs
  saturate the runner pool and queue.

## References

- [ADR-0013](0013-conditional-bot-driven-merge.md) — bot-merge
  conditions still apply to batched PRs (per-session permission,
  full check rollup, auto-review converged, direct squash).
- [ADR-0018](0018-phase-based-shell-orchestrated-workflows.md) — the
  phase-based orchestrator this decision rides on.
- `.claude/rules/branch-strategy.md` — updated in the same PR to
  recognise `batch-*` branch names.
- `.claude/rules/issue-workflow.md` — updated to note that batched
  PRs autopilot-produced are the expected shape.
- `.claude/rules/pr-workflow.md` — updated to describe the
  multi-issue PR-body convention.

## Watch signals

Revisit if any of these surface:

- A single batch produces a PR diff > ~1500 lines or > ~25 files
  consistently (cap was set assuming ~60 lines / 3 files per
  batched issue average; reality may differ).
- Auto-review's full-review pass exceeds its 30-minute timeout
  budget more often than not.
- Maintainer review-button reaction time grows because batched PRs
  are harder to context-switch into than per-issue PRs.
- A specific sister-site class (e.g. iReal parser) repeatedly has
  intra-batch conflicts that the per-issue cargo test catches but
  the corrective-action loop can't unwind cleanly.
