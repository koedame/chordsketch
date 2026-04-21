# Issue-Driven Workflow

## Issue Requirements

- Every piece of work starts with a GitHub Issue.
- Issue title: imperative mood, concise (e.g., "Implement chord directive parser").
- Issue body must include:
  - **Goal**: What should be achieved
  - **Acceptance Criteria**: Checkboxes for done-ness

## Duplicate Prevention

Before creating a new issue, search existing open and closed issues for the same
root cause:

```bash
gh issue list -R koedame/chordsketch --state all --search "<keyword>"
```

If a duplicate exists:
- If it is **open**: add a comment linking the new reproduction case; do not create a
  new issue.
- If it is **closed**: reopen with a comment describing the regression, or create a new
  issue that explicitly references the closed one and explains why it is a distinct
  recurrence.

Duplicate issues waste triage time and fragment the discussion. The PR that fixes a
bug should close all linked issues.

## Issue Labels

| Category | Labels |
|---|---|
| Type | `type:feature`, `type:bug`, `type:docs`, `type:refactor`, `type:ci`, `type:tracking` |
| Size | `size:small` (< 1 hour), `size:medium` (1-4 hours), `size:large` (4+ hours) |
| Priority | `priority:high`, `priority:medium`, `priority:low` |
| Status | `blocked` (waiting on another issue) |

## Workflow Lifecycle

1. Create Issue with labels.
2. Create worktree + branch from latest `main`.
3. Implement (commits reference issue: `Part of #N` or `Closes #N`).
4. Open PR (title references issue, body has `Closes #N`).
5. CI -> auto-review (severity classification) -> human merge.
   See [Pull Request Workflow](pr-workflow.md) for details. Bots do not merge in
   this repo; a human inspects the check rollup and performs the squash merge.
6. Cleanup worktree.

## Closing an Issue Without Implementing It

When closing an issue because the work is being declined (upstream-blocked,
no longer wanted, superseded, or rejected on its merits) rather than because
a PR implemented it, **first check whether an ADR is warranted** per
[`adr-discipline.md`](adr-discipline.md). If yes, write the ADR and link it
from the closing comment so the rationale outlives the issue tracker.

The ADR PR must be **merged to `main`** before the issue is closed — opening
the PR is not sufficient. If the close happens first, the closing comment
will link to a path that does not yet exist on `main`, and the rationale
will be invisible to anyone reading the issue between the close and the
ADR merge.

## Tracking Issues & Sub-Issues

The `type:tracking` label marks **umbrella issues** that group related
work — manually created multi-step features, version-skew trackers in
`docs/releasing.md`, and the upstream-watch trackers auto-created by
`.github/workflows/upstream-watch.yml`. Sub-issues follow the same
lifecycle rules as regular issues. A tracking issue is closed once
every sub-issue is closed and any in-flight PRs from those sub-issues
have merged. There is no separate gate review.

Code and security review still happens at PR level (per
[`pr-workflow.md`](pr-workflow.md)); review findings are filed as
their own issues and tracked independently of the umbrella.

### Creating Sub-Issue Relationships

```bash
# Get node ID of an issue
gh issue view NUMBER --json id -q .id -R koedame/chordsketch

# Link child to parent
gh api graphql -f query='
  mutation {
    addSubIssue(input: {issueId: "PARENT_NODE_ID", subIssueId: "CHILD_NODE_ID"}) {
      subIssue { id number }
    }
  }'
```
