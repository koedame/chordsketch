# One PR at a Time

Drive PRs to `main` through the merge pipeline **serially**. Do not
open a new PR against `main` until the previous one has merged and
the working tree (branch + worktree) is cleaned up.

## Rule

When a batch of independent issues is in scope, process them one at
a time:

1. Pick one issue.
2. Create a worktree and branch from the latest `origin/main`.
3. Implement, push, open the PR.
4. Wait for CI. Address blocking review findings.
5. Merge. Delete the branch. Remove the worktree.
6. Only **then** start the next issue.

Opening multiple PRs against `main` in parallel is prohibited unless
the exception criteria below are explicitly met and documented in the
PR body.

## Why

Two repository-level mechanics compound when multiple PRs are open
simultaneously, and neither is visible from looking at a single PR in
isolation:

1. **Runner concurrency cap.** GitHub-hosted runners cap concurrent
   jobs at the plan's limit. For this org's current plan the cap is
   20 total jobs and 5 macOS jobs (source:
   https://docs.github.com/en/actions/reference/actions-limits ).
   This repo has 9 workflows that run on macOS (`kotlin.yml`,
   `swift.yml`, `ruby.yml`, `napi.yml`, `python.yml`, `ci.yml`,
   `github-action-ci.yml`, `release.yml`, `post-release.yml`), so the
   macOS 5-job ceiling is the practical bottleneck long before the
   20-job total.
2. **Rebase churn after every merge.** Branch protection requires
   PR branches to be up to date with `main` before merging. When a
   PR lands, every other open PR's branch falls behind, and each
   author has to rebase + re-run pre-merge CI before that PR can be
   merged in turn. Holding multiple PRs open during this cycle
   means the same matrix runs repeatedly across all open branches,
   and macOS-bearing required cells are the bottleneck. (Direct
   squash merges replaced the merge queue in
   [ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md);
   the rebase-before-merge rule now carries the role the queue's
   speculative-merge CI used to play.)

Keeping the open-PR-against-main count at one eliminates the first
bottleneck and avoids cascading rebases, so a given PR's
wall-clock-to-merge does not grow with the number of drivers active
simultaneously.

## Exception criteria

Parallel PRs to `main` are permitted only when **all** of the
following hold, and the parallel window is called out in each PR's
body:

- The PRs modify strictly disjoint files. Overlapping files would
  force one PR's branch to be rebased after the other lands, and
  the rebase-and-rerun cycle is exactly what the serial-PR rule
  exists to avoid.
- There is a hard deadline that makes the parallel runner load
  acceptable — e.g. an active release freeze, a CVE patch, or an
  external registry timeout window.
- The author has verified the Actions queue is not already
  saturated (e.g. `gh run list --status queued --limit 100` is
  short) before opening the second PR.

Purely documentation changes that do not touch any Rust file or
`.github/workflows/` (such as adding a rule file under
`.claude/rules/`) may overlap in time with other in-flight PRs,
because they do not meaningfully contend for the same CI resources
and do not cause a content rebase on any other open PR.

Dependabot PRs are out of scope of this rule — they are managed by a
separate automation path per `branch-strategy.md`.

## How this interacts with `parallel-work.md`

`parallel-work.md` is about isolating **parallel human/agent
instances** into separate worktrees so they do not clobber each
other locally. It does not license opening multiple PRs
simultaneously against `main`.

Two agents may each have an in-flight worktree; the rule here still
caps the *merge pipeline* at one PR at a time. When two worktrees
are both ready to land, whichever one's PR is opened first goes
through the pipeline, and the other waits until it has merged
before pushing its branch.
