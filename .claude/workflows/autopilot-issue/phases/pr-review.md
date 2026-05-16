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

Run the following review surfaces in parallel — issue all Agent tool
uses and the `Skill` invocations in a single message — and aggregate
the findings into a single severity-ordered list
(High → Medium → Low → Nit):

- `Skill` invocation of `review` (the project's `/review` slash
  command). REQUIRED — covers the project-specific review checklist.
- `Skill` invocation of `security-review` (the project's
  `/security-review` slash command). REQUIRED — covers the
  sanitizer / asymmetry / blocklist completeness rules in
  `.claude/rules/sanitizer-security.md`.
- Agent invocation `subagent_type: "pr-review-toolkit:code-reviewer"`
  against the PR diff — adherence to project guidelines and CLAUDE.md
  style. Specify the diff scope explicitly (`gh pr diff <PR>` or the
  branch range).
- Agent invocation
  `subagent_type: "pr-review-toolkit:silent-failure-hunter"` —
  silent failures, inadequate error handling, fallbacks that hide
  bugs.
- Agent invocation
  `subagent_type: "pr-review-toolkit:pr-test-analyzer"` — test
  coverage of the new functionality and edge cases.
- Agent invocation
  `subagent_type: "pr-review-toolkit:comment-analyzer"` — accuracy of
  added or modified comments versus the code they describe.
- Agent invocation
  `subagent_type: "pr-review-toolkit:type-design-analyzer"` — only
  when the PR introduces or refactors a public type (struct / enum /
  trait surface). Skip otherwise to avoid noise.
- Agent invocation `subagent_type: "general-purpose"` performing a
  cross-check against every file in `.claude/rules/` — does the diff
  or PR body violate any rule? The specialists above do not own this
  surface, so the generic agent stays in the fan-out for it.
- Collect existing inline review comments via `gh`'s brace form (no
  hard-coded owner/repo) and feed them into the aggregation:
  ```bash
  gh api 'repos/{owner}/{repo}/pulls/<PR>/comments'
  gh api 'repos/{owner}/{repo}/issues/<PR>/comments'
  ```

If `Skill` resolution fails for `review` or `security-review` in this
session (the skill is not registered, or the tool errors), HALT with
`halt_reason: "required review skill <name> unavailable in this
session"`. Do NOT silently proceed without those two surfaces — the
security-review path in particular is load-bearing for the
`sanitizer-security.md` invariants.

### 5. Resolve loop

**Every finding is resolved in this PR, regardless of severity, and
regardless of whether the finding falls inside the original issue's
scope.** This restates
[`.claude/rules/pr-workflow.md`](../../../rules/pr-workflow.md)
step 4 ("All findings, every severity, resolved in-PR") and step 5
("No follow-up issues for review findings") inline so the phase
prompt is self-contained:

- A finding that lives outside the original issue's scope is still
  fixed in this PR — quality takes precedence over scope locality.
- Do NOT call `gh issue create` from this phase to defer a finding.
- The PR body's `## Deferred` section is for pre-existing defects in
  unrelated crates linked to an existing tracker, not for review
  findings against the current diff.

For each finding, in High → Nit order:

1. Push a fix commit that addresses the **root cause** per
   [`.claude/rules/root-cause-fixes.md`](../../../rules/root-cause-fixes.md)
   (no `#[allow(...)]` on legitimate warnings, no
   `unwrap_or_default` to hide missing values, no test edits to mask
   a regression, no timeout bumps to mask intermittency). Each fix
   follows the same English-only / rule-bound discipline as the
   original implementation. If a finding cannot be addressed at the
   root level within this PR (e.g. it requires an ADR or
   cross-team coordination), HALT with a `halt_reason` naming the
   specific blocker — do NOT push a symptomatic patch.
2. After each push, wait for CI (bounded `timeout`, same as step 3),
   then run the **same parallel fan-out as step 4** but scoped to the
   new commits only (delta review). Findings from the original code
   that were not flagged previously are considered accepted; do not
   revive them.
3. Iterate until the delta review returns zero findings across every
   surface in the fan-out (skills + specialist agents + rules
   cross-check + inline comments). "Zero findings" is the
   convergence criterion, not "no blocking findings".

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
- `Skill` resolution for `review` or `security-review` fails — the
  fan-out's two required surfaces are non-optional.
- A forbidden action would be required to complete the PR.

## Notes

- This workflow's contract ends at posting the Ready-for-merge comment.
  Cleanup (worktree removal, branch deletion, project-board flip to
  Done) is the maintainer's responsibility after the squash-merge — or
  a follow-up workflow's, not this one's.
- If you HALT after the PR is open, leave the PR open and the worktree
  intact. The maintainer can pick up either by hand.
