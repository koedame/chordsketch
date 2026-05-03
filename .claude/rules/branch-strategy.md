# Branch Strategy

- **All work requires a GitHub Issue first** — no branch without an issue.
- Branch naming: `issue-{number}-{short-kebab-case}` (e.g., `issue-5-chord-parser`).
- One branch per issue, one issue per branch — strict 1:1 mapping.
- All branches are created from latest `main`.
- After merge, delete the remote branch (already configured via repo settings).

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
