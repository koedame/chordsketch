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
- `AUTOPILOT_EXPECTED_USER` — if set, this phase verifies the `gh`
  CLI is authenticated as that user. Defaults to `unchidev` since the
  workflow's selection criteria are scoped to `unchidev`-authored
  issues (see `issue-selection.md`).

**Context fields read**: none on first run. (The orchestrator initialises
`context.json` to `{}`.)

## Steps

Run each check; record the result. Stop at the first failure and HALT.

1. **GitHub CLI authentication**:
   ```bash
   gh auth status
   ```
   If non-zero exit, HALT with `halt_reason: "gh is not authenticated"`.

2. **Authenticated user matches expected**:
   ```bash
   gh api user --jq .login
   ```
   If the returned login does not match `${AUTOPILOT_EXPECTED_USER:-unchidev}`,
   HALT with `halt_reason: "gh authed as <login>, expected <expected>"`.
   This guards against a maintainer running the autopilot from a
   different shell session whose `gh` is logged in elsewhere.

3. **Branch check**: current branch MUST be `main`.
   ```bash
   git rev-parse --abbrev-ref HEAD
   ```
   If not `main`, HALT with `halt_reason: "must run from main; current branch is <X>"`.

4. **Repository identity**: confirm we are in the chordsketch checkout
   (not a worktree of one):
   ```bash
   git rev-parse --show-toplevel
   ```
   If the resulting path does not match the orchestrator-anchored repo
   root, HALT with `halt_reason: "must run from primary checkout, not a worktree"`.

5. **Clean tree**: no staged or unstaged changes.
   ```bash
   git status --porcelain
   ```
   If non-empty, HALT with `halt_reason: "working tree is dirty"`.

6. **One-PR-at-a-time gate** per
   [`.claude/rules/one-pr-at-a-time.md`](../../../rules/one-pr-at-a-time.md).
   The rule applies to ALL maintainer-authored PRs against `main`,
   not just autopilot-driven ones; filter by author + base only:
   ```bash
   gh pr list --author "@me" --state open --base main \
     --json number,headRefName
   ```
   If the list is non-empty, HALT with
   `halt_reason: "another open PR by current user against main: #<N> (<branch>)"`.

## Output

Write `context.json` with **exactly** this shape (preserve any keys
that were already present):

```json
{
  "started_at": "<UTC ISO 8601 with Z suffix>",
  "dry_run": <true|false>,
  "target_issue": <integer or null>,
  "expected_user": "<string>"
}
```

- `dry_run` ← `true` iff `AUTOPILOT_DRY_RUN == "1"`.
- `target_issue` ← integer if `AUTOPILOT_ISSUE_NUMBER` is set and parses
  as a positive integer; otherwise `null`.
- `expected_user` ← value of `AUTOPILOT_EXPECTED_USER` or the default
  `"unchidev"`. Recorded so `issue-selection` can re-verify without
  re-reading env (per `workflow-discipline.md` §"Phase file contract"
  Inputs guidance: read env in the entry phase only, persist to
  context.json).

Set `next_phase`:

- `"issue-selection"` if every check above passed.
- `"HALT"` otherwise (with `halt_reason` populated as described).

Write the matching identifier to `<state-dir>/current-phase.txt`.

## HALT conditions (explicit enumeration)

- `gh auth status` fails or the authed user does not match.
- Current branch is not `main`.
- Working tree is dirty.
- Another open PR by the current user against `main` exists.
- Repository identity check fails (running from a worktree).

## Notes

- This phase never touches the worktree or any remote state. It is
  pure read-only sanity.
- If you cannot determine a value (e.g. `gh auth status` returns
  ambiguous output), HALT — guessing here cascades into worse decisions
  downstream.
