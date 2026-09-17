# Dependabot Review and Merge

Sequentially audit and merge every open Dependabot pull request in this
repository. For each PR, verify that the dependency upgrade does not
introduce a security vulnerability or hostile change, apply any required
code-side adaptation, confirm the full check rollup is green, and squash-merge.

The optional argument is a single PR number. If provided, process only
that PR; if omitted, process every open Dependabot PR: `$ARGUMENTS`

This command is the bot-driven merge path documented in
[ADR-0016](../../docs/adr/0016-dependabot-review-skill.md). Its invocation
counts as the per-session merge permission required by clause 1 of the
four-clause merge gate in `.claude/rules/pr-workflow.md` §"Bot-driven
merge: conditional permission" — the maintainer does NOT need to grant
verbal merge permission again for the PRs the skill processes in this
invocation.

## Preconditions

Before doing any per-PR work, confirm:

1. The current branch is `main` (or some other detached vantage point —
   the skill never operates on the maintainer's in-flight feature
   branches).
2. `gh auth status` reports an authenticated session.
3. The maintainer has not just said "stop" or "don't merge anything" —
   if the chat history contains such an instruction, halt and ask
   before proceeding.

## Step 1 — Enumerate open Dependabot PRs

```bash
gh pr list \
  --author "app/dependabot" \
  --state open \
  --limit 100 \
  --json number,title,headRefName,baseRefName,createdAt
```

A Dependabot PR has one of two shapes (ADR-0075, ADR-0077):

- **Single-dependency PR** — every major update and every security
  update. A cargo major or any security update has the title
  `fix(deps): bump <DEP> from <OLD> to <NEW>` and the head ref
  `dependabot/<ecosystem>/<DEP>-<NEW>`. A github-actions major comes
  through the `actions-major` group, which opens one PR per action
  covering every workflow and composite action that pins it: its title
  is `fix(deps): bump <DEP> in /` with no versions, its head ref is
  `dependabot/github_actions/github_actions-<hash>`, and its body
  carries the versions in an ``Updates `<DEP>` from <OLD> to <NEW>`` line.
- **Grouped PR** — the week's patch and minor updates for one
  ecosystem. Title `… bump the <GROUP> group with <N> updates`, or
  `… bump the <GROUP> group across <D> directories with <N> updates`
  when the updates touch more than one directory, head ref `dependabot/<ecosystem>/<GROUP>-<hash>`,
  where `<GROUP>` is `cargo-minor-patch` or `actions-minor-patch` (the
  group names in `.github/dependabot.yml`). Its body carries one
  ``Updates `<DEP>` from <OLD> to <NEW>`` section per dependency; a body
  spanning several directories repeats that section for each directory
  that pins the action and opens with one `Bumps the <GROUP> group …
  in the <DIR> directory` line per directory. The body may also open
  with a `| Package | From | To |` table listing every dependency.

If `$ARGUMENTS` is set, narrow the list to the matching PR number and
verify its author is `dependabot[bot]`. If the author is not Dependabot,
abort — this command does not merge non-Dependabot PRs.

Sort the working list by `createdAt` ascending (oldest first). This keeps
processing order stable across invocations and lets Dependabot's
auto-rebase finish on the older PRs before the newer ones come up.

Use `TodoWrite` to record one task per PR. Set the first task to
`in_progress` and the rest to `todo` — this is the maintainer's
visibility into how far the loop has progressed if the session is
interrupted.

## Step 2 — Per-PR audit (sequential)

For each PR in the list, in order:

### 2a. Spawn a subagent to perform the per-PR audit

Use the `Agent` tool with `subagent_type: general-purpose`. The subagent
inherits no chat context, so the prompt must include every detail it
needs. Use the following template, substituting `<PR>`, `<ECOSYSTEM>`,
`<HEAD_REF>`, and `<UPDATES>` from the PR metadata
(`gh pr view <PR> --json title,body,headRefName,labels,files`).
`<UPDATES>` is one `<DEP> <OLD> → <NEW>` line per dependency: the
single dependency of a single-dependency PR (from its title, or from
its `Updates` line when the title carries no versions), or every
dependency of a grouped PR — the rows of its `| Package | From | To |`
table when it has one, otherwise its `Updates` lines with the
per-directory repeats collapsed to one line each. Copy the rows as they
appear; do not drop rows for crates that look transitive.

> You are auditing Dependabot PR #`<PR>` in the `<ECOSYSTEM>`
> ecosystem (head ref: `<HEAD_REF>`). It updates these dependencies:
>
> ```
> <UPDATES>
> ```
>
> **Goal.** Determine whether every one of these upgrades is safe to
> merge. Steps 3–5 run once per dependency in the list; steps 1, 2
> and 6–8 run once for the PR. Report a verdict of `SAFE`, `FIXED`, or
> `BLOCKED` for the PR plus a one-paragraph rationale. The PR is
> `BLOCKED` if any one dependency is; it is `FIXED` if any fix commit
> was pushed and nothing is blocked. If `FIXED`, push the fix commits
> to the PR's branch before reporting.
>
> **Steps:**
>
> 1. **Worktree.** Create an isolated worktree for this PR:
>    ```bash
>    git fetch origin pull/<PR>/head:dependabot-review-<PR>
>    git worktree add ../chordsketch-wt/dependabot-review-<PR> dependabot-review-<PR>
>    cd ../chordsketch-wt/dependabot-review-<PR>
>    ```
>    All subsequent commands run inside this worktree.
>
> 2. **Diff inspection.** Run `gh pr diff <PR>` and confirm the diff
>    only touches `Cargo.toml` / `Cargo.lock` (cargo bumps) or `uses:`
>    lines in files under `.github/workflows/` and `.github/actions/`
>    (github-actions bumps; one action is often pinned in several
>    workflows, so one bump can touch several files). Cargo bumps
>    routinely update transitive sub-crates in `Cargo.lock` (e.g.
>    bumping `serde` also moves `serde_derive`; bumping `tokio` also
>    moves `tokio-macros`); those entries are expected. A Dependabot
>    PR is suspicious when it touches anything else — source files,
>    additional manifests, `Cargo.lock` entries for packages whose
>    names do not share a common prefix with a listed dependency and
>    that are not reachable from a listed dependency's entry in
>    `Cargo.lock`, `uses:` lines naming an action that is not in the
>    list, or CI configuration other than `uses:` lines. A permitted
>    `uses:` line's trailing version-pin comment changing to name the
>    new version (e.g. `# v4.4.0` → `# v4.6.0`) is expected — every
>    action pin in this repo is a SHA plus that comment
>    (`.claude/rules/action-pin-provenance.md`), so Dependabot updates
>    it together with the SHA on every bump; flag it only if it does
>    NOT match that `uses:` line's own action's target version — the
>    `<NEW>` value in its `<DEP> <OLD> → <NEW>` row of `<UPDATES>` (a
>    grouped actions PR can bump several actions to different target
>    versions in one diff, so this step runs once per `uses:` line
>    against its own row, not against a single PR-wide `<NEW>`).
>    Report `BLOCKED` with a description of the unexpected change.
>
> 3. **Advisory check.** For `<ECOSYSTEM>`:
>    - **cargo**: install `cargo-audit` if not present (`cargo install
>      cargo-audit --locked`) and run `cargo audit`. If the new
>      version is named in any advisory's `patched_versions` or
>      `unaffected` list, the upgrade is the fix — note that and
>      proceed. If the new version itself is flagged, report `BLOCKED`.
>    - **github-actions**: query `gh api /repos/<dep_owner>/<dep_repo>/security-advisories`
>      (where `<dep_owner>/<dep_repo>` is parsed from the action
>      reference, e.g. `actions/checkout` → `owner=actions, repo=checkout`).
>      If the new version's tag falls inside any advisory's affected
>      range, report `BLOCKED`.
>
> 4. **CHANGELOG / release-notes read.** For each dependency, fetch its
>    release notes for every version between its `<OLD>` (exclusive)
>    and `<NEW>` (inclusive):
>    - **cargo**: `gh api /repos/<dep_owner>/<dep_repo>/releases` if
>      the crate's repository is on GitHub (most are; check
>      `cargo info <DEP>`). Otherwise read the published `CHANGELOG.md`
>      from `https://docs.rs/crate/<DEP>/<NEW>/source/CHANGELOG.md`.
>    - **github-actions**: `gh api /repos/<dep_owner>/<dep_repo>/releases`.
>    Read every entry and flag:
>    - Behaviour changes that are not listed as breaking but could
>      affect this codebase (e.g. default-value changes, new required
>      inputs, deprecation warnings that promote to errors next major).
>    - Anything labelled "security" — confirm the CVE is real, not a
>      typo'd advisory.
>    - Anything labelled "unstable" / "experimental" / "preview".
>
> 5. **Repository-activity sniff test.** For each dependency, pull its
>    commit list between the two version tags:
>    ```bash
>    gh api "/repos/<dep_owner>/<dep_repo>/compare/<OLD_TAG>...<NEW_TAG>"
>    ```
>    Skim the commit subjects. Flag (and report `BLOCKED` if any are
>    present):
>    - Commits authored by accounts that did not previously contribute
>      to this dependency (typosquat / supply-chain compromise
>      indicator).
>    - Force-pushed history (the `compare` payload's `merge_base_commit`
>      will not match expectations).
>    - Commits that touch authentication, network calls, file-system
>      writes, or environment-variable reads when the dependency's
>      stated purpose has nothing to do with those areas.
>
> 6. **Build / test / lint.** Run the appropriate verifier for the
>    ecosystem on the PR's branch:
>    - **cargo** (most cases):
>      ```bash
>      cargo fmt --check
>      cargo clippy --workspace --exclude chordsketch-desktop --all-targets -- -D warnings
>      cargo test --workspace --exclude chordsketch-desktop
>      ```
>      The `chordsketch-desktop` exclusion mirrors `claude-review.yml`'s
>      historical scope — that crate's transitive deps (webkit2gtk /
>      WebView2) are not installed on this machine and the
>      `desktop-smoke` job in `ci.yml` covers it on every PR.
>    - **cargo bumps to crates inside `apps/desktop/src-tauri/Cargo.toml`**:
>      ALSO run `cargo check -p chordsketch-desktop` if and only if
>      `apt list --installed 2>/dev/null | grep -q libwebkit2gtk`. If
>      the desktop libs are not installed, note that desktop-side
>      verification is deferred to CI and continue.
>    - **github-actions**: no local execution. Inspect every workflow
>      file the bump touches, read the action's release notes for any
>      input default-value changes, and rely on CI to surface
>      regressions.
>
> 7. **Diagnose & fix on failure.** If step 6 fails:
>    - Read the failure output and identify the root cause. Per
>      `.claude/rules/root-cause-fixes.md`, do NOT apply symptomatic
>      patches (catch-and-suppress, `#[allow(...)]`, version pin
>      downgrades, etc.).
>    - If the fix is small and clearly indicated by the dependency's
>      release notes (e.g. a renamed function, a removed deprecated
>      method, a new required argument with an obvious value), apply
>      it as a commit on the PR's branch with subject
>      `fix(deps): adapt to <DEP> <NEW>` and push:
>      ```bash
>      git add -p
>      git commit -m "fix(deps): adapt to <DEP> <NEW>"
>      git push origin HEAD:<HEAD_REF>
>      ```
>      Re-run step 6 after the push. If it now passes, report `FIXED`.
>    - If the fix is larger (touches multiple call sites, requires a
>      design choice, or the release notes do not describe the
>      breaking change), report `BLOCKED` with a description of what
>      breaks and what the fix would entail.
>
> 8. **Cleanup.** Remove the worktree:
>    ```bash
>    cd -
>    git worktree remove ../chordsketch-wt/dependabot-review-<PR>
>    git branch -D dependabot-review-<PR>
>    ```
>
> 9. **Verdict report.** For a grouped PR, first list every dependency
>    on its own line as `<DEP> <OLD> → <NEW>: SAFE | FIXED | BLOCKED —
>    <one sentence>`, so a blocked row can be dropped from the group
>    (step 2b). Then reply with EXACTLY one of:
>    - `VERDICT: SAFE — <one-paragraph rationale citing the CHANGELOG
>      entries reviewed and confirming build/test/clippy passed
>      cleanly>`
>    - `VERDICT: FIXED — <one-paragraph rationale describing the fix
>      commit, citing the CHANGELOG entry that motivated it>`
>    - `VERDICT: BLOCKED — <one-paragraph rationale describing what
>      blocked the merge and what a human would need to do>`
>
> Do NOT call `gh pr merge` or `gh pr review --approve` from inside
> the subagent. Merging is the caller's responsibility.

### 2b. Act on the verdict

Parse the subagent's reply for the leading `VERDICT:` token:

- **`SAFE` or `FIXED`** — proceed to step 2c (merge).
- **`BLOCKED`** — post a comment on the PR with the subagent's
  rationale (no approval, no merge), then advance the task list and
  move on to the next PR. For a grouped PR whose other rows are all
  `SAFE` / `FIXED`, drop the blocked rows from the group afterwards
  (see "Dropping a dependency from a grouped PR" below) instead of
  leaving the whole group waiting on a human. The comment template:
  ```bash
  gh pr comment <PR> --body "$(cat <<'EOF'
  /dependabot-review verdict: BLOCKED

  <subagent rationale>

  This PR was not auto-merged. A human needs to decide how to proceed.
  EOF
  )"
  ```

#### Dropping a dependency from a grouped PR

A grouped PR cannot be merged with one row removed, and editing its
branch by hand stops Dependabot from maintaining it. Dependabot's
grouped-update comment command removes the dependency from the group:

```
@dependabot ignore <DEP>
```

Dependabot closes the grouped PR and stores an ignore condition that
stops it updating `<DEP>`. The remaining rows come
back as a new grouped PR on the ecosystem's next update run (weekly,
or at once via Insights → Dependency graph → Dependabot → "Check for
updates"); audit that PR from step 2a like any other.

The ignore condition persists until it is removed, so record it: the
BLOCKED comment names every ignored dependency and the command that
lifts it, and the Step 4 summary lists them. Once the reason for the
block is gone (a fixed release, or a code-side change merged to
`main`), comment on any open Dependabot PR in the same ecosystem:

```
@dependabot unignore <DEP>
```

which closes that PR and opens a new one that includes `<DEP>` again.
`@dependabot show <DEP> ignore conditions` lists what is stored for a
dependency. Post every one of these commands the way Step 3 spells out
(`--body-file`, then read the posted comment back) — a defanged
`ignore` does nothing, and a defanged `unignore` leaves the dependency
silently ignored.

### 2c. Merge gate (only on SAFE / FIXED)

The four conditions of [ADR-0013](../../docs/adr/0013-conditional-bot-driven-merge.md)
apply per merge:

1. **Per-session permission**: satisfied by this command's invocation.
2. **Full check rollup green**: verify with
   ```bash
   gh pr checks <PR>
   ```
   Every line must report `pass` or `skipping`. If any line is
   `pending`, wait — Dependabot may have just rebased the PR after a
   prior merge and CI is still re-running. Use `Monitor` to stream check-status
   events (preferred); if `Monitor` is unavailable, fall back to
   repeated `gh pr checks` polls until everything is green or a
   check fails. If a check fails, revisit step 2a
   for that PR (the failure may be a regression the prior audit
   missed).
3. **Auto-review converged on HEAD**: the audit subagent that just
   returned IS the converged review. If the subagent pushed a fix
   commit (verdict `FIXED`), CI will be re-running on the new HEAD;
   wait for it per (2) before merging.
4. **Merge through the queue** (ADR-0079; never `--admin`):
   ```bash
   gh pr merge <PR>
   ```
   Wait until `gh pr view <PR> --json state` reports `MERGED`. If the
   queue removes the PR, read the failing `merge_group` run and treat
   it as a failed check under (2).

Mark the task `completed`. Move on to the next PR.

## Step 3 — Inter-PR rebase wait

After merging any PR, Dependabot will auto-rebase its other open PRs
in the same ecosystem (because their branch's lock file or workflow
file is now behind `main`). Before starting the next PR's audit,
fetch fresh PR metadata:

```bash
gh pr view <NEXT_PR> --json headRefOid,statusCheckRollup
```

If `statusCheckRollup` shows checks in `IN_PROGRESS` or `QUEUED`,
the rebase has fired — wait for it to settle before invoking the
subagent for that PR. The subagent will re-do its own checks
anyway, but starting it before CI begins on the rebased commit
risks the subagent reading stale state.

If Dependabot has not rebased a PR within 5 minutes of the previous
merge, nudge it with a `rebase` command comment.

Do NOT pass the command through `--body`: some comment-posting
clients defang bot commands by inserting `U+00B7` (MIDDLE DOT)
characters into them. The comment posts successfully and looks
almost normal, but Dependabot does not recognise it, so the nudge
silently does nothing. Write the command to a file instead, so the
literal command text never travels through the client as a command
argument. Use a freshly generated temp path (`mktemp`), not a fixed
name — a predictable path under `/tmp` is a symlink/race target on a
shared host:

```bash
attempt=1
while [ "$attempt" -le 3 ]; do
  CMD_FILE=$(mktemp)
  python3 -c "import pathlib, sys; pathlib.Path(sys.argv[1]).write_text(chr(64) + 'dependabot rebase')" "$CMD_FILE"
  COMMENT_URL=$(gh pr comment <NEXT_PR> --body-file "$CMD_FILE")
  rm -f "$CMD_FILE"

  # Posting is not proof the command was accepted. Read back the
  # exact comment just created, by ID — do NOT list-and-take-last:
  # the issue-comments endpoint defaults to the oldest 30 comments
  # in ascending order with no pagination, so on a PR that has
  # accumulated 30+ comments over its review lifetime, `--jq
  # '.[-1].body'` would silently read a stale unrelated comment
  # instead of the one just posted.
  COMMENT_ID="${COMMENT_URL##*#issuecomment-}"
  BODY=$(gh api "repos/koedame/chordsketch/issues/comments/$COMMENT_ID" --jq '.body')

  case "$BODY" in
    *$'\xc2\xb7'*) attempt=$((attempt + 1)) ;;  # U+00B7 present — defanged, retry
    *) break ;;                                 # clean
  esac
done

# $BODY dies with this shell once the tool call returns — print the
# outcome explicitly so it survives into the next command's context.
if [ "$attempt" -gt 3 ]; then
  echo "BLOCKED: rebase nudge defanged after 3 attempts"
else
  echo "OK: $BODY"
fi
```

The final line must read `OK: ` followed by the two-word rebase
command and nothing else. A `U+00B7` anywhere inside the read-back
means the comment was defanged in transit and Dependabot will ignore
it. Cap retries at 3 attempts — if the third read-back is still
defanged, the script prints the `BLOCKED:` line instead; stop nudging
this PR, report it in the BLOCKED bucket with "rebase nudge defanged
after 3 attempts", and move on. Do not loop indefinitely.

## Step 4 — Final summary

After every PR in the working list has been processed, post a
summary to the chat (NOT as a GitHub comment). Format:

```
Processed N Dependabot PRs:
  - Merged: <count> (#<PR>, #<PR>, ...)
  - Blocked (need human): <count> (#<PR>: <one-line reason>, ...)
  - Dropped from a group (ignored until unignored): <count> (<DEP> in #<PR>: <one-line reason>, ...)
  - Skipped (CI failed even after fix): <count> (#<PR>: <one-line reason>, ...)
```

If any PR is in the BLOCKED bucket, end the summary with:
"Run `gh pr view <PR>` for the full audit comment on each."

## Failure modes to watch for

- **`gh pr merge` fails with `Pull request is not mergeable`**:
  the PR conflicts with `main` because Dependabot has not yet rebased it.
  Post the `rebase` command comment exactly the way step 3 spells
  it out (`--body-file`, then read the posted comment back), wait
  for the rebase + CI, retry once.
  If it fails again, report BLOCKED with the failure reason and move
  on.
- **Subagent's worktree create fails because the path already exists**:
  a previous interrupted invocation left a stale worktree. Run
  `git worktree remove --force ../chordsketch-wt/dependabot-review-<PR>`
  and retry.
- **`cargo audit` reports an advisory against the OLD version that
  the NEW version fixes**: this is the upgrade doing its job. Note
  the advisory in the verdict and treat as `SAFE` / `FIXED`, not
  `BLOCKED`.
- **`cargo install cargo-audit` fails offline**: `cargo audit` is
  best-effort — if the install fails, note that advisory check was
  skipped in the verdict and continue. Do not BLOCK on missing
  tooling.
- **PR was opened against a base branch other than `main`**:
  abort that PR's processing with a comment explaining that this
  command only operates on PRs against `main`.

## Notes

- An unmerged grouped PR is refreshed by the ecosystem's next update
  run. If the same dependencies still move to the same versions,
  Dependabot updates that PR; if a row was added, removed, or now moves
  to a different version, it closes the PR and opens a replacement. A
  grouped PR that closes mid-audit is abandoned — audit its replacement
  from step 2a.
- This skill processes PRs **sequentially** by design. Parallel
  processing would race against Dependabot's auto-rebase on
  intra-ecosystem peers and produce noisy CI runs that the
  maintainer would have to disambiguate after the fact.
- The skill is **idempotent**: invoking it again after a partial run
  picks up wherever the previous run stopped, because every step's
  state lives in GitHub (PR open/closed, merge status, comments).
- The skill does NOT delete the underlying `dependabot/...` branch
  after merge — Dependabot manages those branches itself and squash
  merges already trigger its branch cleanup.
- The skill does NOT touch any non-Dependabot PR. If a maintainer
  rebased their own feature branch onto a Dependabot branch (rare,
  not recommended), this command will not see it.
