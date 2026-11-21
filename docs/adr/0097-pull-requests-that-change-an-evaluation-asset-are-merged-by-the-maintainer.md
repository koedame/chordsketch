# 0097. Pull requests that change an evaluation asset are merged by the maintainer

- **Status**: Proposed
- **Date**: 2026-11-20
- **Amends**: [ADR-0013](0013-conditional-bot-driven-merge.md) (adds condition 5),
  [ADR-0024](0024-scheduled-dependabot-merge.md) (the Dependabot path meets
  the same condition)

## Context

Some files say what "correct" means: the expected output of a golden test, the
corpus, the coverage thresholds, the manifests and allowlists CI compares the
repository with, and the check scripts themselves. A change to one of them is a
change to the test, not to the code under test, and the failure mode is quiet:
the expectation is rewritten to match a behaviour that is wrong, and CI turns
green.

What stops that today is prose. `.claude/rules/golden-tests.md` says a pull
request that drops below the minimum fixture counts "blocks on human review", but
the minimums live in the `MINIMUMS` dict of `scripts/check-fixture-counts.py`.
A pull request that lowers a floor in the same diff that deletes the fixtures
passes the check, passes the rollup, and meets the four conditions of
[ADR-0013](0013-conditional-bot-driven-merge.md): authorization, a green
rollup, a converged auto-review, the queue. Branch protection requires the
named checks and the queue; it has no required review, no CODEOWNERS and no
per-path rule.

Measured on the 133 pull requests merged between 2026-09-20 and 2026-11-19
(each is one squash commit on `main`, diffed against its parent), 12 changed an
existing file in the list below: 8 touched `deny.toml`, `codecov.yml` or a
`ci/*.toml` manifest, 4 touched a `scripts/check-*.py`, 3 touched fixtures or
snapshots (some touched more than one kind). None of the 22 Dependabot and
release pull requests among the 133 was one of them.

## Decision

A pull request that changes an evaluation asset is merged by the maintainer, not
by an AI assistant. This is condition 5 of the bot-merge rule in
`.claude/rules/pr-workflow.md`, and the Dependabot path of
[ADR-0024](0024-scheduled-dependabot-merge.md) meets it too: the audit does not
satisfy it, and the adaptation commits of a `FIXED` verdict are part of the diff
it covers.

The condition is checked by `.github/workflows/eval-assets.yml`, whose job is
`Eval assets (maintainer merge required)`, running `scripts/check-eval-assets.py`
on `git diff <base>...<head>` with renames disabled:

1. **Registry.** `ci/eval-assets.toml` lists globs, each with a reason. An
   existing file matched by one of them that is modified, deleted or changed in
   type is a hit. Adding a file is not; a rename is the deletion of the old path.
   The registry lists `crates/*/tests/fixtures/**`, `tests/corpus/**`,
   `.github/snapshots/**`, `.github/fixtures/**`, `codecov.yml`, `deny.toml`,
   `ci/*.toml` and `scripts/check-*.py`, and the files of this detection:
   the registry, the script, its test and the workflow.
2. **Content.** Patterns that cannot be listed as paths:
   - a net deletion (deleted minus added lines) of 10 or more in one file under
     `.github/workflows/` or in a `scripts/_*.py` helper;
   - fewer references to a `scripts/check-*` script in one workflow file, so
     that removing the `Fixture counts` step of `ci.yml` is a hit although it is
     six lines;
   - fewer assertion or test-declaration lines in one Rust file (`assert!`,
     `assert_eq!`, `assert_ne!`, `#[test]` and attribute forms such as
     `#[tokio::test]`) or one `*.test.*` / `*.spec.*` file under `packages/`
     (`expect(`, `it(`, `test(`);
   - an added `#[ignore]` in a Rust file, or an added `.skip(`, `xit(`,
     `xdescribe(` or `xtest(` in such a test file.

A hit labels the pull request `eval-assets`, writes the files in one comment
that later pushes rewrite (a pull request that stops matching loses the label and
the comment is collapsed), and fails the job. The check is **not** a required
check, so the maintainer can still merge. Condition 2 of the bot-merge rule
(every check `pass` or `skipping`) therefore keeps the assistant out, and
condition 5 states the reason and covers a run that was skipped or has not
finished. An assistant never enqueues a flagged pull request, whatever form of
authorization condition 1 took, and there is no label or comment with which
anyone tells it to.

The workflow uses `pull_request_target`, so that the workflow file, the script
and the registry that run are the base branch's and a pull request cannot edit
the check that reads it. The pull request's commits are fetched as git objects
and read with `git diff`; nothing from them is checked out, built or executed.
The token has `contents: read` and `pull-requests: write`. The registry lists its
own files, so a pull request cannot rewrite the detection without being flagged.
On `merge_group` the job passes without running a step.

`scripts/check-fixture-counts.py` is unchanged. Listing it as an evaluation asset
is what closes the way of lowering `MINIMUMS` with the fixtures, and deleting its
step in `ci.yml` is a content hit.

## Rationale

[ADR-0013](0013-conditional-bot-driven-merge.md) considered allowing bot merges
only on docs-only pull requests and rejected it because "the criterion is hard to
define mechanically". This decision is the reverse and does not meet that
objection:

- That alternative was an **allow list** of the pull requests an assistant may
  merge; a miss let a risky change through. This is a **deny list** of the
  differences an assistant must not land. A miss leaves things as they are today;
  a false hit costs the maintainer one click.
- No pull request has to be classified as docs, code or CI. A file in the registry
  and a change of kind M, D or T decide the registry hits, and a line count decides
  the content hits.
- The incident behind ADR-0013 (a non-required check red at merge) is closed by
  condition 2, and condition 5 does not replace it: it makes an extra check red
  on purpose, and condition 2 turns that into a stop.
- Nothing the pull request carries decides the outcome: the registry, the script
  and the workflow come from the base branch, and the registry covers itself.

Rewriting an expectation in place (`assert_eq!(x, 5)` to `6`) cannot be told from a
refactor by line counts, so it is **not** detected. What remains for that case is
the auto-review, mutation testing, and
[`root-cause-fixes.md`](../../.claude/rules/root-cause-fixes.md).

## Consequences

- Of the 133 pull requests above, the rule flags 13 (10%): the 12 registry hits and
  one more from the content patterns (`81e6926f`, a security fix whose diff leaves
  90 fewer assertion lines in one Rust file). That is about 6 or 7 maintainer merges a
  month. Three of the 12 registry hits are also content hits (`5cbd5493`,
  `8e4c2a52`, `9fccd46b`). The other 120 are not flagged, `41dff80c` (a change to a
  `scripts/_*.py` helper and its tests that adds more than it removes) among them.
- A flagged pull request waits for the maintainer even when it is a clean change
  (a threshold raised, a manifest entry added). That is the price of not having to
  decide mechanically which edits are harmless.
- The detection is only as good as its list. When a new kind of expected value or
  threshold appears (a baseline file, a snapshot directory), add its glob to
  `ci/eval-assets.toml` in the pull request that introduces it; that pull request
  is flagged itself.
- `pull_request_target` runs with a write token in a repository that does not take
  outside pull requests ([ADR-0087](0087-outside-pull-requests-are-not-accepted.md)).
  The job reads git objects only and runs no code from the pull request.

## Alternatives considered

1. **CODEOWNERS with required review.** Rejected. A pull request an assistant opens
   is authored under the maintainer's own account, and GitHub does not let an author
   approve their own pull request, so the maintainer could not satisfy the review.
2. **Make the check a required check.** Rejected. A required red check stops the
   maintainer's merge as well; the point is that only the maintainer merges.
3. **Flag everything under `.github/workflows/**`.** Rejected. 40 of the 133
   pull requests (30%) change a workflow, and most are routine; the content
   patterns catch the deletions that matter.
4. **A label or comment that lets an assistant merge a flagged pull request.**
   Rejected. Anything an assistant can add is something it can add to itself.
5. **Detect rewritten assertions.** Rejected as not decidable without running the
   tests against the old and the new expectation; see Rationale.

## References

- [ADR-0013](0013-conditional-bot-driven-merge.md), [ADR-0024](0024-scheduled-dependabot-merge.md),
  [ADR-0079](0079-merges-go-through-the-queue-which-runs-the-publish-checks.md)
- `.claude/rules/pr-workflow.md` (condition 5), `.claude/rules/golden-tests.md`
- `ci/eval-assets.toml`, `scripts/check-eval-assets.py`,
  `.github/workflows/eval-assets.yml`
