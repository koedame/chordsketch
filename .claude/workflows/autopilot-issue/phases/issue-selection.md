# Phase: issue-selection

Pick exactly one open issue authored by `unchidev` that Claude Code can
autonomously implement, or exit cleanly with `no-candidate` if nothing
qualifies.

## Inputs

**Context fields read**:

- `dry_run` (bool) — informational; does not affect selection.
- `target_issue` (int or null) — if set, skip discovery and use this
  issue directly (still validate it).

## Steps

### If `target_issue` is non-null

1. Fetch the single issue:
   ```bash
   gh issue view <target_issue> \
     --json number,title,body,labels,assignees,author,url,closedByPullRequestsReferences
   ```
2. Verify `author.login == "unchidev"`. If not, HALT with
   `halt_reason: "target issue #<N> is not authored by unchidev"`.
3. Verify the issue is open. If `state != "open"`, HALT with
   `halt_reason: "target issue #<N> is closed"`.
4. Skip the discovery, filter, and scoring sub-steps; jump straight to
   "Output" using this issue.

### Otherwise: discover + filter + score

1. **Discover** every open issue authored by `unchidev`:
   ```bash
   gh issue list --author unchidev --state open --limit 200 \
     --json number,title,body,labels,assignees,url,createdAt,closedByPullRequestsReferences
   ```

2. **Mechanical filter** — exclude any issue that matches any of:
   - Has label `blocked`, `type:tracking`, or `priority:high`.
   - `closedByPullRequestsReferences` contains an open PR, OR
     `gh issue view <N> --json timelineItems` shows a
     `CrossReferencedEvent` to an open PR.
   - Has an assignee whose `login != "unchidev"`.
   - Body has zero unchecked acceptance-criteria checkboxes
     (`grep -c '^- \[ \]' <body-text>` returns 0).

   If zero issues survive, set `next_phase: "no-candidate"`, record the
   pre-filter count in context.json, and exit. (This is a clean exit,
   not HALT.)

3. **Triage scoring** — score each surviving candidate on 0–100 across
   four axes. Use your own judgement informed by the issue body, labels,
   and the project's rules in `.claude/rules/`. Mark
   `autonomous_eligible = true` only when ALL four are ≥ 70.

   | Axis | Question |
   |------|----------|
   | `clarity` | Is the desired end state unambiguous from the issue? |
   | `scope` | Bounded change? `size:small`/`size:medium` positive; single-crate positive; cross-cutting refactors negative. |
   | `verifiability` | Can `cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace` confirm success? |
   | `independence` | Avoids secrets, human design judgement, new ADRs per [`.claude/rules/adr-discipline.md`](../../../rules/adr-discipline.md), and cross-team coordination? |

4. **Pick the top scorer.** Tiebreak by oldest `createdAt` (FIFO). If
   zero candidates have `autonomous_eligible = true`, set
   `next_phase: "no-candidate"` and include the per-issue scores in
   context.json so the maintainer can see why.

## Output

Write `context.json` with:

```json
{
  "started_at": "...",
  "dry_run": <bool>,
  "target_issue": <int or null>,
  "selected_issue": {
    "number": <int>,
    "title": "<string>",
    "url": "<https://github.com/...>",
    "labels": ["<label>", ...],
    "createdAt": "<ISO 8601>"
  },
  "triage": {
    "considered_count": <int, total open issues authored by unchidev>,
    "post_filter_count": <int>,
    "scores": [
      {
        "number": <int>,
        "clarity": <0-100>,
        "scope": <0-100>,
        "verifiability": <0-100>,
        "independence": <0-100>,
        "autonomous_eligible": <bool>,
        "rationale": "<one sentence>"
      },
      ...
    ]
  }
}
```

When `next_phase = "no-candidate"`, omit `selected_issue` and ensure the
`triage` block explains why every candidate was rejected.

Set `next_phase`:

- `"implementation"` — selected an autonomous-eligible candidate.
- `"no-candidate"` — clean exit, nothing to do.
- `"HALT"` — `target_issue` validation failed, or `gh` queries errored.

## Notes

- Sister-site / fix-propagation / golden-test rules are NOT enforced
  during scoring — they apply during implementation. Scoring only
  predicts whether the issue is *amenable* to autonomous work.
- Treat `priority:high` as out-of-scope by policy, not because the
  issue is too hard. The maintainer has earmarked high-priority work
  for human attention.
