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
2. Move the issue to **In Progress** on the [chordsketch project board](https://github.com/orgs/koedame/projects/1)
   at the moment work actually starts — i.e. the first commit or worktree
   creation, not at planning time. Issues still sitting in Todo while a
   PR exists against them are a signal that this step was skipped.
3. Create worktree + branch from latest `main`.
4. Implement (commits reference issue: `Part of #N` or `Closes #N`).
5. Open PR (title references issue, body has `Closes #N`).
6. CI -> auto-review (severity classification) -> human merge.
   See [Pull Request Workflow](pr-workflow.md) for details. Bots do not merge in
   this repo; a human inspects the check rollup and performs the squash merge.
7. After merge, either the project-board's built-in
   "Auto-add PR / Auto-close" workflow moves the issue to Done via the
   linked `Closes #N`, or — if that workflow is not enabled — flip the
   Status to Done manually with the same `gh` snippet below, using
   option ID `98236657`.
8. Cleanup worktree.

### Updating Project Board Status

The board's Status field has three options: **Todo**, **In Progress**, **Done**.

Flip an issue (`$N` is the issue number) to In Progress:

```bash
# 1. Resolve the issue's project-item ID via a GraphQL variable
#    (no shell interpolation into the query string, so $N can be
#    validated once and then passed safely).
ITEM_ID=$(gh api graphql -F number="$N" -f query='
  query($number: Int!) {
    repository(owner: "koedame", name: "chordsketch") {
      issue(number: $number) { projectItems(first: 5) { nodes { id } } }
    }
  }' --jq '.data.repository.issue.projectItems.nodes[0].id // empty')

# 2. Guard against issues not yet added to the board — otherwise the
#    mutation below fails with an opaque "Variable $itemId got invalid
#    value null" message.
if [ -z "$ITEM_ID" ]; then
  echo "Issue #$N is not on the chordsketch project board; add it first." >&2
  exit 1
fi

# 3. Set Status = In Progress (option ID 47fc9ee4).
#    Use `-f` (not `-F`) for the option ID so numeric-looking values
#    like "98236657" are forced to GraphQL String and not inferred as
#    Int by gh's typed-field parser.
gh api graphql \
  -f itemId="$ITEM_ID" \
  -f optionId="47fc9ee4" \
  -f query='
    mutation($itemId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: "PVT_kwDOBCeHxM4BTI0L"
        itemId: $itemId
        fieldId: "PVTSSF_lADOBCeHxM4BTI0LzhAd1Rw"
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }'
```

To flip the issue to **Done** after merge (when the board's
auto-close workflow is not enabled), run the step-3 mutation again
with `optionId="98236657"`; the lookup in step 1 and the guard in
step 2 are unchanged.

The single-select option IDs are stable: `f75ad846` = Todo,
`47fc9ee4` = In Progress, `98236657` = Done. Batch multiple issues by
iterating over a list of numbers and re-running steps 1–3 per entry.

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
