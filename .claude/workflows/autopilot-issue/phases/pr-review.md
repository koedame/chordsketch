# Phase: pr-review

Commit, push, open the PR, wait for CI, drive the review loop to
convergence, and post a Ready-for-merge comment. Do NOT merge.

## Inputs

**Context fields read**:

- `selected_issue.number`, `selected_issue.title`, `selected_issue.url`
- `implementation.branch`, `implementation.worktree_path`,
  `implementation.diff_stat`, `implementation.sister_site_audit`

## Steps

Work inside `implementation.worktree_path` for every command in this
phase.

### 1. Commit + push

Commit using the project's neutral technical voice per
[`.claude/rules/pr-workflow.md`](../../../rules/pr-workflow.md)
§"PR Formatting and Commit Messages":

- Imperative mood subject line, ≤ 70 chars
- No session dates, no quoted messages, no `@handle` attributions
- Body explains *why*, not *what* (the diff already says what)

Before pushing, verify the remote branch does not already exist (a
stale ref from a previous failed run would cause a non-fast-forward
push or, worse, silently combine with someone else's commits):

```bash
if git ls-remote --exit-code origin "<implementation.branch>" >/dev/null 2>&1; then
  halt "remote branch <implementation.branch> already exists; manual cleanup required"
fi
git push -u origin "<implementation.branch>"
```

### 2. Open the PR

Use `gh`'s brace-substitution form so the PR-body block does not need
to know the owner/repo (gh fills these in from the current repo). Body
sections match `.claude/rules/pr-workflow.md` ("What", "Why", "Test
results", "Review summary"). The "Test plan" / "Test results" wording
matches the project's review template:

```bash
gh pr create \
  --title "<imperative-mood title, <=70 chars>" \
  --body "$(cat <<'BODY'
## What
<1-3 bullets describing the change>

## Why
<link to issue, 1-2 sentences naming the motivation>

## Test results
- cargo fmt --check — passed
- cargo clippy --workspace -- -D warnings — passed
- cargo test --workspace — passed
- <fixture-specific or scripts/* check, if applicable>

## Review summary
<one-line summary of what auto-review will be checking>

## Sister-site audit
<from context.implementation.sister_site_audit>

## Deferred
<none, or one-line justification per deferred item, linked to an existing tracker>

Closes #<selected_issue.number>
BODY
)"
```

Capture the new PR number into `context.json` (`pr.number`, `pr.url`).

### 3. Wait for CI

Bound the wait with the per-phase timeout. `gh pr checks --watch`
otherwise never returns if a required check fails to start (e.g. a
workflow YAML mismatch):

```bash
timeout 1800 gh pr checks <PR> --watch
```

Block until every check has a definite verdict. If `timeout` fires
(exit code 124), HALT with
`halt_reason: "CI did not settle within 30 minutes"`.

If CI ends with any non-pass status, surface the failing checks in
context.json (under `pr.ci_status`) and proceed to step 4 — auto-review
will see CI failures and decide whether to fix or HALT.

### 4. Review fan-out

Run the following review surfaces in parallel where possible (multiple
Agent tool uses in a single message) and aggregate the findings into a
single severity-ordered list (High → Medium → Low → Nit):

- A `general-purpose` sub-agent performing a code review against the PR diff.
- A `general-purpose` sub-agent performing a silent-failure / error-handling audit against the PR diff.
- A cross-check pass against every file in `.claude/rules/` — does the
  diff or PR body violate any rule?
- Collect existing inline review comments via `gh`'s brace form (no
  hard-coded owner/repo):
  ```bash
  gh api 'repos/{owner}/{repo}/pulls/<PR>/comments'
  ```
- If `/review` and `/security-review` are available as Skill
  invocations in this session, run those too.

### 5. Resolve loop

For each finding, in High → Nit order:

1. Push a fix commit that addresses the root cause (no `#[allow(...)]`
   on legitimate warnings, no `unwrap_or_default` to hide missing
   values, etc.). Each fix follows the same English-only / rule-bound
   discipline as the original implementation.
2. After each push, wait for CI (bounded `timeout`, same as step 3),
   then run a **delta review** that only examines the new commits.
   Findings from the original code that were not flagged previously
   are considered accepted; do not revive them.
3. Iterate until the delta review returns zero findings.

Hard cap: 3 review iterations per
[`.claude/rules/pr-workflow.md`](../../../rules/pr-workflow.md) step 7.
If the cap fires before convergence, HALT with
`halt_reason: "review iteration cap hit with <N> findings outstanding"`.
Leave the PR open; the maintainer takes over.

### 6. Ready-for-merge comment

When the delta review converges and CI is green on HEAD, post exactly
one comment on the PR:

```
Ready for merge.

- Full check rollup: green
- Auto-review: converged on HEAD
- Sister-site audit: <one line>

Merge is held for explicit maintainer action per ADR-0013.
```

Do NOT call `gh pr merge`. The four-clause merge gate in
[`.claude/rules/pr-workflow.md`](../../../rules/pr-workflow.md)
§"Bot-driven merge: conditional permission" requires per-session
permission this workflow does not assume.

## Forbidden actions

Per [`.claude/rules/workflow-discipline.md`](../../../rules/workflow-discipline.md)
§"Forbidden phase actions", this phase MUST NOT run any of:
`gh pr merge`, `git push --force` to `main`, `cargo publish`, `gh
release create`, `gh secret set`, `npm publish`. Posting the
Ready-for-merge comment is the workflow's terminal action; the human
holds the merge button.

## Output

Extend `context.json` with:

```json
{
  "pr": {
    "number": <int>,
    "url": "<https://github.com/.../pull/<N>>",
    "head_sha": "<git sha at Ready-for-merge>",
    "ci_status": "passed",
    "review_iterations": <int 0..=3>,
    "findings_resolved": {
      "high": <int>,
      "medium": <int>,
      "low": <int>,
      "nit": <int>
    },
    "ready_for_merge_comment_id": <int>
  }
}
```

(All prior context.json fields are preserved.)

Set the next phase (write to `<state-dir>/current-phase.txt`):

- `ready-for-merge` — Ready-for-merge comment posted.
- `HALT` — review iteration cap hit, CI cannot be made green, the remote
  branch already existed, the wait-for-CI timeout fired, or any rule
  violation surfaced that requires human judgement.

## HALT conditions (explicit enumeration)

- Remote branch already exists at push time.
- CI does not settle within the bounded wait (30 min default).
- Review iteration cap (3) is hit with findings outstanding.
- A finding requires human judgement (e.g. ADR needed, scope
  exceeded).
- A forbidden action would be required to complete the PR.

## Notes

- This workflow's contract ends at posting the Ready-for-merge comment.
  Cleanup (worktree removal, branch deletion, project-board flip to
  Done) is the maintainer's responsibility after the squash-merge — or
  a follow-up workflow's, not this one's.
- If you HALT after the PR is open, leave the PR open and the worktree
  intact. The maintainer can pick up either by hand.
