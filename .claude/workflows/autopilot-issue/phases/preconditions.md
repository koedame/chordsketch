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

6. **Fetch + main freshness**: the autopilot must start from the
   latest `main`. The downstream `implementation` phase creates its
   worktree from `origin/main`, so a stale local fetch would silently
   base new work on an outdated tree. Fetch and verify in this phase
   so a network / auth failure halts fast — before any state-modifying
   work — and so the local `main` matches what `implementation` will
   branch from.
   ```bash
   git fetch origin main --tags
   local_main=$(git rev-parse main)
   origin_main=$(git rev-parse origin/main)
   if [[ "$local_main" != "$origin_main" ]]; then
     # Local main is behind or has diverged. Fast-forward if behind;
     # HALT if diverged (the maintainer may have local commits that
     # need to land in their own PR first).
     if git merge-base --is-ancestor "$local_main" "$origin_main"; then
       git merge --ff-only origin/main
     else
       # halt_reason rendered verbatim on the orchestrator terminal.
       printf 'local main (%s) has diverged from origin/main (%s); rebase or reset manually before retrying' \
         "$local_main" "$origin_main"
       exit 1  # HALT path; see "Required final actions" footer
     fi
   fi
   ```
   If `git fetch origin main --tags` itself exits non-zero, HALT with
   `halt_reason: "git fetch origin failed; check network / SSH auth"`.

7. **One-PR-at-a-time gate** per
   [`.claude/rules/one-pr-at-a-time.md`](../../../rules/one-pr-at-a-time.md).
   The rule applies to ALL maintainer-authored PRs against `main`,
   not just autopilot-driven ones; filter by author + base only:
   ```bash
   gh pr list --author "@me" --state open --base main \
     --json number,headRefName
   ```
   If the list is non-empty, HALT with
   `halt_reason: "another open PR by current user against main: #<N> (<branch>)"`.

8. **Plugin availability** per
   [`.claude/rules/workflow-discipline.md`](../../../rules/workflow-discipline.md)
   §"Required external dependencies". The `pr-review` phase depends
   on the `pr-review-toolkit` plugin for its specialist review
   sub-agents (`code-reviewer`, `silent-failure-hunter`,
   `pr-test-analyzer`, `comment-analyzer`, `type-design-analyzer`).
   Verify it is installed:
   ```bash
   claude plugins list
   ```
   If `pr-review-toolkit` does not appear in the output, HALT with
   `halt_reason: "pr-review-toolkit plugin is not installed; run 'claude plugins install pr-review-toolkit' and retry"`.
   The check runs in this phase rather than in `pr-review` so a
   missing plugin fails fast — before the workflow touches any
   remote state — instead of mid-review after a PR has been opened.

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
- `git fetch origin` fails.
- Local `main` has diverged from `origin/main` (cannot be
  fast-forwarded automatically — maintainer judgement required).
- Another open PR by the current user against `main` exists.
- Repository identity check fails (running from a worktree).
- `pr-review-toolkit` plugin is not installed.

## Notes

- This phase fetches from origin and may fast-forward the local
  `main` if it is behind `origin/main`. Other than that one
  fast-forward (which is non-destructive — only valid when local
  is an ancestor of origin), it is read-only against both the
  worktree and any remote state.
- If you cannot determine a value (e.g. `gh auth status` returns
  ambiguous output), HALT — guessing here cascades into worse decisions
  downstream.
