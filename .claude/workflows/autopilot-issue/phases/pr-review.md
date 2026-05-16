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

Push:

```bash
git push -u origin "<implementation.branch>"
```

### 2. Open the PR

```bash
gh pr create \
  --title "<imperative-mood title, <=70 chars>" \
  --body "$(cat <<'BODY'
## What
<1-3 bullets describing the change>

## Why
<link to issue, 1-2 sentences naming the motivation>

## Test plan
- cargo fmt --check
- cargo clippy --workspace -- -D warnings
- cargo test --workspace
- <fixture-specific or scripts/* check, if applicable>

## Sister-site audit
<from context.implementation.sister_site_audit>

## Deferred
<none, or one-line justification per deferred item, linked to an existing tracker>

Closes #<selected_issue.number>
BODY
)"
```

Capture the new PR number into `context.json`.

### 3. Wait for CI

```bash
gh pr checks <PR> --watch
```

Block until every check has a definite verdict. If CI ends with any
non-pass status, surface the failing checks in context.json and
proceed to step 4 — auto-review will see CI failures and decide
whether to fix or HALT.

### 4. Review fan-out

Run the following review surfaces and aggregate the findings into a
single severity-ordered list (High → Medium → Low → Nit):

- A `general-purpose` sub-agent performing a code review against the PR diff
- A `general-purpose` sub-agent performing a silent-failure / error-handling audit against the PR diff
- A cross-check pass against every file in `.claude/rules/` — does the
  diff or PR body violate any rule?
- Collect existing inline review comments:
  ```bash
  gh api "repos/<owner>/<repo>/pulls/<PR>/comments"
  ```
- If `/review` and `/security-review` are available as Skill
  invocations in this session, run those too.

### 5. Resolve loop

For each finding, in High → Nit order:

1. Push a fix commit that addresses the root cause (no `#[allow(...)]`
   on legitimate warnings, no `unwrap_or_default` to hide missing
   values, etc.). Each fix follows the same English-only / rule-bound
   discipline as the original implementation.
2. After each push, wait for CI, then run a **delta review** that only
   examines the new commits. Findings from the original code that were
   not flagged previously are considered accepted; do not revive them.
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

## Output

Extend `context.json` with:

```json
{
  ...prior fields...,
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

Set `next_phase`:

- `"ready-for-merge"` — Ready-for-merge comment posted.
- `"HALT"` — review iteration cap hit, CI cannot be made green, or any
  rule violation surfaced that requires human judgement.

## Notes

- This workflow's contract ends at posting the Ready-for-merge comment.
  Cleanup (worktree removal, branch deletion, project-board flip to
  Done) is the maintainer's responsibility after the squash-merge — or
  a follow-up workflow's, not this one's.
- If you HALT after the PR is open, leave the PR open and the worktree
  intact. The maintainer can pick up either by hand.
