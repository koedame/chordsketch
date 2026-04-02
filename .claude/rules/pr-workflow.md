# Pull Request Workflow

## Automated Flow (default)

PRs are reviewed and merged automatically via CI:

1. **PR created** — author opens PR with code and tests.
2. **CI runs** (cargo fmt --check, cargo clippy -- -D warnings, cargo test).
3. **Auto-review** — on CI success, `claude-review.yml` requests a Claude review
   with severity classification. Claude performs both code review and security review.
4. **Blocking findings** (High, Medium) — Claude pushes fix commits directly.
   CI re-runs, then a **delta review** examines only the fix commits.
5. **Non-blocking findings** (Low, Nit) — Claude creates GitHub Issues. These do
   **not** block the PR from merging.
6. **Auto-merge** — when there are no blocking findings, Claude enables auto-merge
   (`gh pr merge --squash --auto`). The PR merges once CI passes on the final commit.
7. **Safety cap** — after 3 auto-review iterations, the process stops and waits for
   human intervention.

## Manual Flow (optional)

For local review before pushing, or when the automated flow is not desired:

1. Run `/review` and/or `/security-review` locally.
2. Fix any blocking findings, then push.
3. The automated flow takes over from step 2 above.

## Rules

- All changes enter `main` via pull request — no direct pushes.
- All PRs are **squash-merged** (merge commits and rebase merging are disabled).
- Branch protection enforces that status checks pass on the HEAD commit before merging.

### Severity Definitions

| Severity | Blocks PR/Phase | Definition |
|----------|-----------------|------------|
| High | Yes | Security vulnerabilities, data corruption, crashes |
| Medium | Yes | Spec violations, logic bugs, incorrect output |
| Low | No | Defense-in-depth gaps, minor inconsistencies, portability |
| Nit | No | Style, naming, test coverage suggestions |

### Delta Review

When a review produces blocking findings and fixes are applied, the subsequent review
must only examine the new commits (the fix diff), not re-review the entire PR. This
ensures convergence: fix diffs are small and produce fewer findings, trending toward
zero.

Previously-reviewed code that was not flagged is considered accepted. If a reviewer
later discovers a blocking issue in previously-accepted code, it should be filed as a
separate issue — not raised in the delta review.

### PR Formatting

- PR titles should be concise and written in imperative mood (e.g., "Add chord
  transposition support").
- PR descriptions must include What, Why, Test results, and Review summary sections.
