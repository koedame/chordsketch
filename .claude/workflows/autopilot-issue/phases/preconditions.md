# Phase: preconditions

Verify the repository and environment are in a state where the autopilot
can begin a new iteration. If any check fails, halt cleanly so the
maintainer can address it before retrying.

## Inputs

**Environment variables** (optional, read directly):

- `AUTOPILOT_DRY_RUN` — if set to `1`, downstream phases must skip the
  push and PR steps.
- `AUTOPILOT_ISSUE_NUMBER` — if set to an integer, the `issue-selection`
  phase must skip scoring and target this specific issue.

**Context fields read**: none on first run. (The orchestrator initialises
`context.json` to `{}`.)

## Steps

Run each check; record the result. Stop at the first failure and HALT.

1. **GitHub CLI authentication**:
   ```bash
   gh auth status
   ```
   If non-zero exit, HALT with `halt_reason: "gh is not authenticated"`.

2. **Branch check**: current branch MUST be `main`.
   ```bash
   git rev-parse --abbrev-ref HEAD
   ```
   If not `main`, HALT with `halt_reason: "must run from main; current branch is <X>"`.

3. **Clean tree**: no staged or unstaged changes.
   ```bash
   git status --porcelain
   ```
   If non-empty, HALT with `halt_reason: "working tree is dirty"`.

4. **One-PR-at-a-time gate** per
   [`.claude/rules/one-pr-at-a-time.md`](../../../rules/one-pr-at-a-time.md):
   ```bash
   gh pr list --author "@me" --state open \
     --search 'head:issue-' --json number,headRefName
   ```
   If the list is non-empty, HALT with
   `halt_reason: "another autopilot PR is still open: #<N> (<branch>)"`.

5. **Maintainer veto**: if the active chat history (in this `claude -p`
   invocation, you only see the prompt — so this check reduces to "no
   explicit veto in the prompt context"). Treat this as informational
   only; do not HALT on it.

## Output

Write `context.json` with **exactly** this shape (preserve any keys
that were already present):

```json
{
  "started_at": "<UTC ISO 8601 with Z suffix>",
  "dry_run": <true|false>,
  "target_issue": <integer or null>
}
```

- `dry_run` ← `true` iff `AUTOPILOT_DRY_RUN == "1"`.
- `target_issue` ← integer if `AUTOPILOT_ISSUE_NUMBER` is set and parses
  as a positive integer; otherwise `null`.

Set `next_phase`:

- `"issue-selection"` if every check above passed.
- `"HALT"` otherwise (with `halt_reason` populated as described).

Write the matching identifier to `<state-dir>/current-phase.txt`.

## Notes

- This phase never touches the worktree or any remote state. It is
  pure read-only sanity.
- If you cannot determine a value (e.g. `gh auth status` returns
  ambiguous output), HALT — guessing here cascades into worse decisions
  downstream.
