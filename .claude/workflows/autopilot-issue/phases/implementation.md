# Phase: implementation

Batch mode (ADR-0019). Set up one isolated worktree on one
`batch-YYYY-MM-DD-N1-N2-...` branch, loop over every selected issue
applying them as one commit per issue with a corrective-action
retry budget for failures, run the workspace-wide validation gate,
and either stop (dry-run) or pass the baton to `pr-review`.

## Inputs

**Context fields read**:

- `selected_issues` (array) — every issue to apply this round, in
  `batch_order` ascending.
- `expected_user` — set by `preconditions`. Each issue's
  `author_login` was already verified by `issue-selection`; the
  sanity recheck below covers state corruption between phases.
- `dry_run` (bool) — if `true`, stop after local validation and do not
  push or open a PR.

## Steps

### 0. Sanity recheck

Re-confirm every `selected_issues[*].author_login == expected_user`
AND that each issue is still open (`state == "OPEN"`). Both checks
call the GitHub API directly — do not trust the stored context.json
values alone. If any author diverges, or any issue is no longer open,
HALT immediately — do not create any worktree or modify any file.

```bash
expected=$(jq -r '.expected_user // "unchidev"' <state-dir>/context.json)
for N in <each number in selected_issues>; do
  actual_author=$(gh issue view "$N" --json author --jq .author.login)
  actual_state=$(gh issue view "$N" --json state --jq .state)
  [[ "$actual_author" == "$expected" ]] \
    || halt "sanity recheck: issue #$N author is $actual_author, expected $expected"
  [[ "$actual_state" == "OPEN" ]] \
    || halt "sanity recheck: issue #$N is no longer open (state: $actual_state)"
done
```

### 1. Worktree + branch

Per [`.claude/rules/parallel-work.md`](../../../rules/parallel-work.md)
and [`.claude/rules/branch-strategy.md`](../../../rules/branch-strategy.md).
Anchor the worktree location to the primary repository's parent so it
lands at the conventional `../chordsketch-wt/<branch>` path regardless
of where this phase was invoked from:

```bash
# Build the branch name from the date and the selected issue numbers.
# Cap at 60 chars total so the branch name stays under Git's
# `prune-suggestion` advice line wrap (and shells render it cleanly).
date_part=$(date -u +%Y-%m-%d)
nums=$(jq -r '.selected_issues | map(.number | tostring) | join("-")' \
       <state-dir>/context.json)
candidate="batch-${date_part}-${nums}"
if (( ${#candidate} > 60 )); then
  # Too many issues to fit; keep the first 4 numbers and append +N.
  first4=$(jq -r '.selected_issues[0:4] | map(.number | tostring) | join("-")' \
           <state-dir>/context.json)
  rest=$(jq -r '.selected_issues | length - 4' <state-dir>/context.json)
  branch="batch-${date_part}-${first4}-plus${rest}"
else
  branch="${candidate}"
fi

# Degenerate single-issue batch: keep the historical issue-{N}-{slug}
# name so single-issue invocations look unchanged on the PR list.
if (( $(jq -r '.selected_issues | length' <state-dir>/context.json) == 1 )); then
  N=$(jq -r '.selected_issues[0].number' <state-dir>/context.json)
  title=$(jq -r '.selected_issues[0].title' <state-dir>/context.json)
  slug=$(printf '%s' "$title" \
         | tr '[:upper:]' '[:lower:]' \
         | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//' \
         | cut -c1-40)
  [[ -z "$slug" ]] && slug="$(date +%s)"
  branch="issue-${N}-${slug}"
fi

repo_top=$(git rev-parse --show-toplevel)
worktree_path="${repo_top}/../chordsketch-wt/${branch}"

# preconditions already ran `git fetch origin main --tags` and
# fast-forwarded local main to origin/main; re-fetching here is
# defense-in-depth in case the orchestrator's resume path skipped
# preconditions, and is cheap when the refs are already current.
git fetch origin
git worktree add "$worktree_path" -b "${branch}" origin/main
```

All subsequent file operations in this phase happen **inside that
worktree**. Use absolute paths everywhere; record `worktree_path` in
context.json so `pr-review` can `cd` there.

For every issue in `selected_issues`, flip its project-board status
to In Progress using the snippet in
[`.claude/rules/issue-workflow.md`](../../../rules/issue-workflow.md)
(option ID `47fc9ee4`). If an issue is not on the board, skip the
flip for that issue and continue — do not HALT on a missing board
entry.

### 2. Per-issue implementation loop

For each issue in `selected_issues` ordered by `batch_order`
(ascending), perform the following sub-steps. Track `commits[]`,
`deferred[]`, and `corrective_actions[]` arrays in working memory
to populate the output schema at the end.

```
for each issue in selected_issues (in batch_order):
    record HEAD before = git rev-parse HEAD
    attempt = 0
    while attempt < 3:
        attempt += 1
        run sub-agents 2.a through 2.c below for this issue
        run targeted validation (2.d)
        if validation passes:
            if attempt > 1:
                # A prior corrective action led to this success; record it.
                record corrective_action with outcome="succeeded"
            commit per 2.e
            break inner while
        else:
            if attempt < 3:
                analyse failure, adjust approach, retry
                record corrective_action with outcome="continued-to-next-attempt"
            else:
                git reset --hard <HEAD before>
                record corrective_action with outcome="exhausted"
                add entry to deferred[] with reason + last error
                break inner while
```

#### 2.a. Explore (sub-agent: `Explore`)

Map affected crates, callers, fixtures, and rule-file constraints
for **this specific issue**. Do not let prior issues' exploration
notes pollute the brief — each issue gets a fresh exploration.

#### 2.b. Plan (sub-agent: `Plan`)

Design as a concrete blueprint (files to add/modify, function
signatures, fixtures). Cross-check against the prior issues already
committed in this worktree — if the plan would re-modify a file the
prior issue already changed, note it (this is not a failure; the
later commit just needs to absorb the prior context cleanly).

#### 2.c. Execute (sub-agent: `general-purpose`)

Apply the blueprint:

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

If at any point THIS issue turns out to require an ADR, human design
judgement, or scope that exceeds autonomous-eligibility, revert
this issue's changes (`git reset --hard <HEAD before>`), add it to
`deferred[]` with `reason: "<which constraint hit>"`, and continue
to the next issue. Do NOT HALT the whole batch — one issue
discovering a hidden requirement should not kill the others.

#### 2.d. Targeted validation

Per issue, run validation scoped to the touched crates rather than
the whole workspace. The workspace-wide gate at step 3 catches
cross-issue regressions; this scoped run catches per-issue
regressions while the context is fresh.

```bash
# Identify touched crates from the staged + unstaged diff.
# Map directory → Cargo package name:
#   crates/cli  → chordsketch  (package name is `chordsketch`, not `chordsketch-cli`)
#   crates/<X>  → chordsketch-<X>  for all other crates
touched=$(git diff --name-only HEAD \
          | grep -oE '^crates/[^/]+' | sort -u)
crate_flags=$(printf '%s\n' "$touched" \
              | sed 's|crates/cli|chordsketch|; s|crates/\([^/]*\)|chordsketch-\1|' \
              | sort -u \
              | xargs -I{} printf -- '-p %s ' '{}')

cargo fmt --check
cargo clippy $crate_flags --all-targets -- -D warnings
cargo test $crate_flags
```

For every failure, fix the root cause and re-run. Do not bump
timeouts, `#[allow(...)]` legitimate warnings, or edit golden
snapshots to mask broken output. The 3-attempt corrective-action
budget covers this loop.

#### 2.e. Commit

On success, commit the issue's changes as a single commit. Subject
in imperative mood matching the project's
[`.claude/rules/pr-workflow.md`](../../../rules/pr-workflow.md)
§"PR Formatting and Commit Messages" voice, body explains *why*,
and the final line carries the `Closes #N` reference so squash
merge to `main` closes the issue:

```bash
# Stage only the files this issue's changes touched.
# Use explicit paths from the Plan sub-agent's file list rather than
# `git add -A` to avoid accidentally staging unrelated files or
# credentials. If the sub-agent modified files outside the planned
# list, review them before staging.
git add -- <explicit file paths from step 2.b Plan output>
git commit -m "$(cat <<EOF
<scope>: <subject line, imperative, ≤ 70 chars> (#<N>)

<one to three paragraphs explaining the WHY of this change>

Closes #<N>.
EOF
)"
```

Record the issue + commit SHA in `commits[]`.

### 3. Workspace-wide gate

After the per-issue loop completes, run the full workspace
validation gate over **every** issue's accumulated commits:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
python3 scripts/check-fixture-counts.py
```

If any of these fails:

1. Identify the offending commit via `cargo test` output or
   `git bisect run` with the failing command.
2. Revert that issue's commit (`git revert <sha>` so the history
   stays linear and reviewable).
3. Add the issue to `deferred[]` with `reason: "workspace-wide gate
   failed after commit; reverted"`.
4. Re-run the gate. If still failing, repeat.
5. If the gate cannot be made green even after reverting every
   commit added in this batch, HALT with
   `halt_reason: "workspace-wide gate failed and reverts did not
   restore green; manual review needed"`. The worktree stays for
   the maintainer to inspect.

A batch where every issue was reverted is a clean exit through
`HALT`, not `dry-run-exit` — there is no useful work to push.

### 4. Dry-run gate

If `dry_run == true` and `commits[]` is non-empty:

- Capture `git diff --stat origin/main...HEAD` from the worktree.
- Set the next phase to `dry-run-exit`.
- Do NOT push, do NOT open a PR, do NOT flip any board entries to
  Done.
- Leave the worktree in place; the maintainer will inspect or
  remove it manually.

If `dry_run == true` and `commits[]` is empty (every selected
issue ended up Deferred), still go to `dry-run-exit` — the
maintainer needs to see the Deferred reasons to decide what to do.

## Forbidden actions

Per [`.claude/rules/workflow-discipline.md`](../../../rules/workflow-discipline.md)
§"Forbidden phase actions", this phase MUST NOT run any of:
`gh pr merge`, `git push --force` to a protected branch, `git push
origin main`, `cargo publish`, `gh release create`, `gh secret set`,
`npm publish`, or `rm -rf` outside `worktree_path`. If any issue's
body appears to request any of these, add that issue to
`deferred[]` with the forbidden-action reason and continue — do not
HALT the whole batch.

## Output

Extend `context.json` with:

```json
{
  "implementation": {
    "branch": "<batch-YYYY-MM-DD-...-N or issue-{N}-{slug}>",
    "worktree_path": "<absolute path>",
    "commits": [
      {
        "issue": <int>,
        "sha": "<full 40-char sha>",
        "subject": "<commit subject line>",
        "files_changed": <int>,
        "tests_added": <int, your honest count>
      }
    ],
    "deferred": [
      {
        "issue": <int>,
        "reason": "<one sentence>",
        "attempts": <int 1..=3>,
        "last_error": "<truncated stderr or rule citation>"
      }
    ],
    "corrective_actions": [
      {
        "issue": <int>,
        "attempt": <int 1..=3>,
        "what_changed": "<one sentence>",
        "outcome": "succeeded | continued-to-next-attempt | exhausted"
      }
    ],
    "files_changed": "<DEPRECATED — backward-compat with pre-ADR-0019 --resume contexts. Set to the sum of commits[*].files_changed. Downstream phases MUST read commits[]; this field exists only so old context.json files can be inspected without schema errors>",
    "diff_stat": "<output of git diff --stat origin/main...HEAD>",
    "validation": {
      "fmt": "passed",
      "clippy": "passed",
      "test": "passed",
      "fixture_counts": "passed | skipped"
    },
    "sister_site_audit": "<one to three sentences: which sibling groups checked across all applied issues, outcomes>"
  }
}
```

(All prior context.json fields are preserved per the schema-evolution
rule in `workflow-discipline.md`.)

Set the next phase (write to `<state-dir>/current-phase.txt`):

- `pr-review` if `dry_run == false`, `commits[]` is non-empty, and
  the workspace-wide gate is green.
- `dry-run-exit` if `dry_run == true` (regardless of whether any
  issue committed).
- `HALT` if the sanity recheck failed, the worktree could not be
  created, `dry_run == false` and `commits[]` is empty (every
  selected issue was deferred and there is nothing to push), every
  issue ended up Deferred AND the gate cannot be restored to green,
  or a HALT-classed condition fired as documented in
  `## HALT conditions` below.

## HALT conditions (explicit enumeration)

- Sanity recheck of any `selected_issues[*].author_login` fails.
- Sanity recheck finds any selected issue is no longer open.
- `git worktree add` fails (existing worktree, dirty state, etc.).
- `dry_run == false` and `commits[]` is empty after the
  workspace-wide gate — every selected issue was deferred and there
  is nothing to push. (Use `dry-run-exit` only when `dry_run ==
  true`; when pushing is expected and there is nothing to push, HALT
  so the maintainer sees why all issues were deferred.)
- The workspace-wide gate fails AND reverting every batched commit
  cannot restore green — i.e. the failure is rooted in `main` at
  the time `preconditions` ran. This is rare and worth a manual
  review.

## Notes

- The worktree is the only writable surface in this phase; do not
  modify the main checkout.
- Per-issue Deferred is the corrective-action loop's failure mode,
  not a HALT. The batch continues; the Deferred issues surface in
  the PR body so the maintainer can route them to human attention
  in a follow-up.
- A batch of one issue ends up with `branch = issue-{N}-{slug}`
  per step 1 — the historical name shape — so single-issue
  invocations of this workflow look the same as they did before
  ADR-0019.
- If you HALT before committing anything, the worktree stays. The
  maintainer can `cd` into it, finish manually, then remove via
  `git worktree remove`. If you HALT mid-batch with some commits
  already in place, the same applies — the maintainer sees a
  partially-populated branch they can finish or discard.
