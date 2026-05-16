# Phase: implementation

Set up an isolated worktree, implement the selected issue, run local
validation, and either stop (dry-run) or pass the baton to `pr-review`.

## Inputs

**Context fields read**:

- `selected_issue.number` — issue number to implement.
- `selected_issue.title` — used to slugify the branch name.
- `selected_issue.author_login` — expected author; sanity-check against
  `expected_user` before touching anything mutable.
- `expected_user` — set by `preconditions`.
- `dry_run` (bool) — if `true`, stop after local validation and do not
  push or open a PR.

## Steps

### 0. Sanity recheck

Re-confirm `selected_issue.author_login == expected_user`. If they
diverge (a previous phase's state somehow got corrupted between
`issue-selection` and now), HALT immediately — do not create any
worktree or modify any file.

### 1. Worktree

Per [`.claude/rules/parallel-work.md`](../../../rules/parallel-work.md)
and [`.claude/rules/branch-strategy.md`](../../../rules/branch-strategy.md).
Anchor the worktree location to the primary repository's parent so it
lands at the conventional `../chordsketch-wt/<branch>` path regardless
of where this phase was invoked from:

```bash
N=<selected_issue.number>
slug=$(printf '%s' "<selected_issue.title>" \
       | tr '[:upper:]' '[:lower:]' \
       | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//' \
       | cut -c1-40)
# Fall back to a timestamp if the title contained only non-ASCII
# characters and the slug came out empty. Empty slugs would produce
# an invalid Git branch name like `issue-1234-`.
[[ -z "$slug" ]] && slug="$(date +%s)"
branch="issue-${N}-${slug}"
repo_top=$(git rev-parse --show-toplevel)
worktree_path="${repo_top}/../chordsketch-wt/${branch}"
git fetch origin
git worktree add "$worktree_path" -b "${branch}" origin/main
```

All subsequent file operations in this phase happen **inside that
worktree**. Use absolute paths everywhere; record `worktree_path` in
context.json so `pr-review` can `cd` there.

Flip the issue's project-board status to In Progress using the snippet
in [`.claude/rules/issue-workflow.md`](../../../rules/issue-workflow.md)
(option ID `47fc9ee4`). If the issue is not on the board, skip the flip
and continue — do not HALT on a missing board entry.

### 2. Implementation

Stage the work through three sub-agents in sequence, using the
built-in `subagent_type` shown for each (these are part of the
`claude` CLI core; no plugin install required):

1. `Explore` — map affected crates, callers, fixtures,
   and rule-file constraints. Output: written exploration brief.
2. `Plan` — design as a concrete blueprint (files
   to add/modify, function signatures, fixtures).
3. `general-purpose` — execute the blueprint:
   - Tests per
     [`.claude/rules/golden-tests.md`](../../../rules/golden-tests.md)
     and [`.claude/rules/code-style.md`](../../../rules/code-style.md)
     (every behaviour change covered by a test that fails without the
     change).
   - Doc comments on every new public item.
   - Sister-site audits per
     [`.claude/rules/renderer-parity.md`](../../../rules/renderer-parity.md),
     [`.claude/rules/fix-propagation.md`](../../../rules/fix-propagation.md),
     and
     [`.claude/rules/sanitizer-security.md`](../../../rules/sanitizer-security.md).
   - English-only per
     [`.claude/rules/english-only.md`](../../../rules/english-only.md).
   - Root-cause discipline per
     [`.claude/rules/root-cause-fixes.md`](../../../rules/root-cause-fixes.md)
     — no symptomatic fixes.

If at any point the issue turns out to require an ADR, human design
judgement, or scope that exceeds autonomous-eligibility, HALT with
`halt_reason: "<which constraint hit>"`. Do not push a partial
implementation.

### 3. Local validation

```bash
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

If renderers were touched, also:

```bash
python3 scripts/check-fixture-counts.py
```

For every failure, fix the root cause and re-run. Do not bump timeouts,
`#[allow(...)]` legitimate warnings, or edit golden snapshots to mask
broken output.

If three diagnose-and-fix cycles do not converge to green, HALT with
`halt_reason: "local validation could not be made green; see <failing-command>"`.

### 4. Dry-run gate

If `dry_run == true`:

- Capture `git diff --stat origin/main...HEAD` from the worktree.
- Set the next phase to `dry-run-exit`.
- Do NOT push, do NOT open a PR, do NOT flip the board to Done.
- Leave the worktree in place; the maintainer will inspect or remove
  it manually.

## Forbidden actions

Per [`.claude/rules/workflow-discipline.md`](../../../rules/workflow-discipline.md)
§"Forbidden phase actions", this phase MUST NOT run any of:
`gh pr merge`, `git push --force` to a protected branch, `git push
origin main`, `cargo publish`, `gh release create`, `gh secret set`,
`npm publish`, or `rm -rf` outside `worktree_path`. If the issue body
appears to request any of these, HALT.

## Output

Extend `context.json` with:

```json
{
  "implementation": {
    "branch": "issue-<N>-<slug>",
    "worktree_path": "<absolute path>",
    "files_changed": <int from git diff --stat>,
    "diff_stat": "<output of git diff --stat origin/main...HEAD>",
    "tests_added": <int, your honest count>,
    "validation": {
      "fmt": "passed",
      "clippy": "passed",
      "test": "passed",
      "fixture_counts": "passed | skipped"
    },
    "sister_site_audit": "<one or two sentence summary: which sibling groups checked, outcomes>"
  }
}
```

(All prior context.json fields are preserved per the schema-evolution
rule in `workflow-discipline.md`.)

Set the next phase (write to `<state-dir>/current-phase.txt`):

- `pr-review` if `dry_run == false` and validation is green.
- `dry-run-exit` if `dry_run == true` and validation is green.
- `HALT` if validation could not be made green, the issue turned out to
  require human judgement, the sanity recheck failed, or a forbidden
  action was implied.

## HALT conditions (explicit enumeration)

- Sanity recheck of `selected_issue.author_login` fails.
- `git worktree add` fails (existing worktree, dirty state, etc.).
- Implementation requires an ADR, human design judgement, or other
  out-of-scope work.
- Local validation cannot be made green in 3 diagnose-and-fix cycles.
- The issue's body or work scope implies a forbidden action.

## Notes

- The worktree is the only writable surface in this phase; do not
  modify the main checkout.
- If you HALT mid-implementation, the worktree stays. The maintainer
  can `cd` into it, finish manually, then remove via `git worktree
  remove`.
