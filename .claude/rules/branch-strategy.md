# Branch Strategy

- **All work requires a GitHub Issue first** — no branch without an issue.
- Branch naming: `issue-{number}-{short-kebab-case}` (e.g., `issue-5-chord-parser`)
  for single-issue branches.
- One branch per issue, one issue per branch — strict 1:1 mapping for
  human-authored branches and single-issue autopilot rounds.
- All branches are created from latest `main`.
- After merge, delete the remote branch (already configured via repo settings).

## Batched autopilot branches

The `autopilot-issue` workflow runs in batch mode per
[ADR-0019](../../docs/adr/0019-batch-mode-autopilot-issue.md): a
single round implements every high-confidence eligible issue (capped at
10) inside one worktree on one branch.

- Multi-issue batches use `batch-YYYY-MM-DD-N1-N2-...` (e.g.
  `batch-2026-05-17-2433-2436-2449`). The date prefix sorts batches
  chronologically; the issue-number suffix preserves issue-to-branch
  attribution from `git branch -a` output. Total length capped at
  ~60 chars; overflowing batches truncate to the first four numbers
  plus a `-plusN` suffix.
- Single-eligible-issue batches keep the `issue-{N}-{slug}` shape so
  single-issue rounds look unchanged on the PR list.
- The strict 1:1 issue-to-branch rule does NOT apply to multi-issue
  batch branches. The PR body documents each closed issue separately
  with one `Closes #N` line per applied issue so squash-merge closes
  every aggregated issue at once.

## Bot Branch Exceptions

- Dependabot branches (`dependabot/...`) are managed by GitHub's Dependabot service.
- These do NOT follow the `issue-{N}-{slug}` naming convention — this is expected.
- Dependabot PRs receive **no automated review**. The maintainer invokes
  the `/dependabot-review` slash command (`.claude/commands/dependabot-review.md`),
  which audits each open Dependabot PR — reading the dependency's CHANGELOG,
  checking for advisories, running build/test/clippy, applying any required
  code-side fixes — and squash-merges the safe ones. See [ADR-0016](../../docs/adr/0016-dependabot-review-skill.md)
  for the policy rationale and [Pull Request Workflow](pr-workflow.md) §"Bot-driven
  merge: conditional permission" for the four-clause merge gate the skill operates under.
