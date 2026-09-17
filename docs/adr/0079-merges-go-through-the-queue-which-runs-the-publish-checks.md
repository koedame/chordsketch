# 0079. Merges go through the merge queue, which runs the publish checks; pull requests run them only when they touch packaging

- **Status**: Accepted
- **Date**: 2026-09-17
- **Supersedes**: [ADR-0015](0015-disable-github-merge-queue.md)
- **Amends**: [ADR-0070](0070-publishability-is-checked-on-every-pull-request.md),
  [ADR-0013](0013-conditional-bot-driven-merge.md) (condition 4),
  [ADR-0024](0024-scheduled-dependabot-merge.md) (condition 4)

## Context

[ADR-0070](0070-publishability-is-checked-on-every-pull-request.md) made
`Publishable` a required check on every pull request with no `paths:`
filter. It is now the slowest thing a pull request waits for. On the three
most recent pull requests measured (#2931, #2932, #2934) `ci.yml` finished
in 28–40 minutes and `publishable.yml` in 86–108, so each pull request
waited about an hour for the publish checks alone. Branch protection also
required a pull request to be up to date with `main`, so every catch-up
after another merge ran that hour again.

The publish checks rarely fail on a change that does not touch packaging.
Between 2026-09-15 and 2026-09-17, 113 pull-request runs of
`publishable.yml` failed 8 times, on 4 pull requests; 2 of those pull
requests were building packaging (the Flathub package and the publish
checks themselves).

[ADR-0015](0015-disable-github-merge-queue.md) turned the merge queue off
because its second pass cost 3–8 minutes per merge and caught nothing a
rebased pull request had not. That trade assumed the queue re-ran checks
the pull request had already run. Here the queue would run the one check
the pull request can skip.

## Decision

1. **`main` requires the merge queue** (a repository ruleset). The queue
   squash-merges, builds up to 2 groups at a time, merges up to 5 entries
   per group, requires every entry of a group to pass (`ALLGREEN`), and
   waits up to 180 minutes for the required checks, which the full
   `publishable.yml` needs. Branch protection keeps the same required
   checks and no longer requires a pull request to be up to date: the
   queue tests each change on top of the `main` it will land on.
2. **`publishable.yml` runs every job in the merge queue, on pushes to
   `main`, nightly and on dispatch.** On a pull request, a `scope` job runs
   the publish jobs only if the change touches a path in
   `PACKAGING_PATHS` or adds a file over 1 MiB (`packaging_reasons` in
   `scripts/_publish_checks.py`). Otherwise they are skipped and the
   required `Publishable` job passes, saying why. `scope` and the checks'
   self-test always run, and `Publishable` fails if either fails. A job
   skipped when `scope` asked for it to run also fails `Publishable`.
3. **The path list is checked against the tree.** Every pattern has to
   match a tracked file. Every workflow and composite action reachable
   from `publishable.yml` through `uses: ./…` has to be on the list.
4. **Condition (4) of ADR-0013 and ADR-0024 becomes "merge through the
   queue".** The assistant enqueues the pull request with the
   `enqueuePullRequest` mutation at the HEAD conditions (2) and (3) were
   checked on (the queue decides the method), pinning `expectedHeadOid`
   so the enqueue targets that exact commit or fails cleanly. `gh pr
   merge <N>` was tried first. On #2940, with every check passed, gh
   2.100.0 enqueued through auto-merge, which stays disabled at the
   repository level, and was refused. Never pass `--admin`, which merges
   past the queue. A merge is done when the pull request is `MERGED`, not
   when the command returns. If the queue removes the pull request, fix
   the cause, push, meet conditions (2) and (3) on the new HEAD again,
   and enqueue again. Conditions (1)–(3) are unchanged.

## Rationale

The guarantee ADR-0070 exists for, that nothing reaches `main` unless it
can still be published, depends on where the check runs, not on how often.
The merge queue is the one place every change passes through, on the
commit that will become `main`, so the guarantee holds with one run per
merge instead of one per push and per catch-up.

Running the checks on pull requests that touch packaging keeps the early
signal where it pays off. Those are the pull requests that fail, and their
authors are the ones who need to iterate on the failure. For every other
pull request, the cost of a late failure is one trip back from the queue,
which the failure record above says is rare.

The path list is a guess, and ADR-0070 rejected a `paths:` filter because
a guess like it let v0.6.0 reach release day unpublishable. Here the guess
only decides whether the author hears early, because the queue always runs
every check. The tests keep the list in step with the files the checks
read. The large-file rule covers the one failure that came from outside
any packaging file: the crate that outgrew crates.io's limit through test
fixtures.

## Consequences

Positive:

- A pull request that touches no packaging waits only for `ci.yml`
  (28–40 minutes in the measurements above), and a catch-up with `main`
  no longer re-runs anything, because nothing needs to be up to date.
- Semantic conflicts between concurrent pull requests are tested before
  they land, which ADR-0015 left to the rebase-before-merge rule.

Negative:

- Clicking merge no longer merges. A merge lands after the queue's run,
  about as long as `publishable.yml` plus `ci.yml`, and later if groups
  ahead of it are still building.
- A pull request that skipped the publish checks learns about a
  publishing failure from the queue, after merge was requested. It then
  needs a fix, a pull-request CI run and a second queue run.
- A group that fails is rebuilt without the failing entry, so one failure
  delays the entries behind it.
- Automation that merged synchronously has to wait for `MERGED` and handle
  a removal from the queue.

## Alternatives considered

- **Keep the checks on every pull request and wait for the cache work.**
  Faster individual jobs leave the structure unchanged: an hour per push
  and per catch-up.
- **Run the publish checks only in the queue, skipping them on every pull
  request.** This is simpler, but pull requests that change packaging
  would learn about failures only after merge was requested. Those are
  the pull requests that fail, and their authors iterate on the failure.
- **A `paths:` filter on the workflow.** A required check has to report on
  every pull request. A filtered workflow leaves the check pending forever
  on the pull requests it skips.
- **Larger GitHub-hosted runners.** They cost money and keep the hour per
  push. Left open as a separate decision.

## References

- [ADR-0015](0015-disable-github-merge-queue.md) — the queue turned off,
  superseded here.
- [ADR-0070](0070-publishability-is-checked-on-every-pull-request.md) —
  the publish checks, now run on pull requests only when they can reach a
  package.
- [ADR-0013](0013-conditional-bot-driven-merge.md) and
  [ADR-0024](0024-scheduled-dependabot-merge.md) — condition (4) is the
  queue again.
- GitHub docs, "Managing a merge queue":
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
