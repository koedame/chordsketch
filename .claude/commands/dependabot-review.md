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

## Environment note

This skill runs in a remote Claude Code environment. **The `gh` CLI is not
available.** All GitHub interactions use the GitHub MCP server tools
(`mcp__github__*`). Local shell commands (`git`, `cargo`, `cargo-audit`)
are still available for worktree operations and local builds.

**Critical: `mcp__github__add_issue_comment` sanitizes `@mentions`** by
inserting Unicode middle-dot characters (U+00B7) into the text — for
example, `@dependabot` becomes `·@·d·ependabot`. This silently breaks
any bot trigger. Never post `@dependabot` commands as comments. Instead,
use `mcp__github__update_pull_request_branch` to bring a branch up to
date programmatically.

## Preconditions

Before doing any per-PR work, confirm:

1. The current branch is `main`, or a vantage-point branch like
   `claude/...` — the skill never operates on the maintainer's in-flight
   feature branches. Verify with:
   ```bash
   git branch --show-current
   ```
2. The maintainer has not just said "stop" or "don't merge anything" —
   if the chat history contains such an instruction, halt and ask
   before proceeding.

## Step 1 — Enumerate open Dependabot PRs

Use `mcp__github__search_pull_requests` to find open Dependabot PRs:

```
mcp__github__search_pull_requests:
  owner: koedame
  repo: chordsketch
  query: "is:pr is:open author:app/dependabot"
```

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
needs. Use the following template, substituting `<PR>`, `<DEP>`,
`<OLD>`, `<NEW>`, `<ECOSYSTEM>`, and `<HEAD_REF>` from the PR metadata
(call `mcp__github__pull_request_read get` for the PR):

> You are auditing Dependabot PR #`<PR>` which bumps `<DEP>` from
> `<OLD>` to `<NEW>` in the `<ECOSYSTEM>` ecosystem (head ref:
> `<HEAD_REF>`).
>
> **Environment.** You are running in a remote Claude Code environment.
> The `gh` CLI is NOT available. Use `mcp__github__*` MCP tools for all
> GitHub API interactions. Local tools (`git`, `cargo`, `cargo-audit`)
> work normally.
>
> **Goal.** Determine whether the upgrade is safe to merge. Report a
> verdict of `SAFE`, `FIXED`, or `BLOCKED` plus a one-paragraph
> rationale. If `FIXED`, push the fix commits to the PR's branch
> before reporting.
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
> 2. **Diff inspection.** Call `mcp__github__pull_request_read` with
>    `method: get_diff` for PR `<PR>` and confirm the diff only touches
>    `Cargo.toml` / `Cargo.lock` (cargo bumps) or a single workflow
>    file's `uses:` line (github-actions bumps).
>    Cargo bumps routinely update transitive sub-crates in `Cargo.lock`
>    (e.g. bumping `serde` also moves `serde_derive`; bumping `tokio`
>    also moves `tokio-macros`); those entries are expected. A Dependabot
>    PR is suspicious when it touches anything else — source files,
>    additional manifests, `Cargo.lock` entries for packages whose names
>    do not share a common prefix with the named dependency and that are
>    not reachable from its entry in `Cargo.lock`, or CI configuration
>    beyond the single `uses:` line. Report `BLOCKED` with a description
>    of the unexpected change.
>
> 3. **Advisory check.** For `<ECOSYSTEM>`:
>    - **cargo**: install `cargo-audit` if not present (`cargo install
>      cargo-audit --locked`) and run `cargo audit`. If the new
>      version is named in any advisory's `patched_versions` or
>      `unaffected` list, the upgrade is the fix — note that and
>      proceed. If the new version itself is flagged, report `BLOCKED`.
>      If `cargo install cargo-audit` fails (offline / network error),
>      note the advisory check was skipped and continue — do not BLOCK
>      on missing tooling.
>    - **github-actions**: fetch the action's security advisories using
>      `WebFetch` to call the GitHub API:
>      ```
>      URL: https://api.github.com/repos/<dep_owner>/<dep_repo>/security-advisories
>      ```
>      (where `<dep_owner>/<dep_repo>` is parsed from the action
>      reference, e.g. `actions/checkout` → `owner=actions,
>      repo=checkout`). If the new version's tag falls inside any
>      advisory's affected range, report `BLOCKED`.
>
> 4. **CHANGELOG / release-notes read.** Fetch the dependency's release
>    notes for every version between `<OLD>` (exclusive) and `<NEW>`
>    (inclusive):
>    - **cargo**: call `mcp__github__list_releases` for the crate's
>      GitHub repo if it is on GitHub (check `cargo info <DEP>` for the
>      repository URL). Otherwise fetch the published `CHANGELOG.md`
>      using `WebFetch`:
>      `https://docs.rs/crate/<DEP>/<NEW>/source/CHANGELOG.md`
>    - **github-actions**: call `mcp__github__list_releases` for
>      `<dep_owner>/<dep_repo>`.
>    Read every entry and flag:
>    - Behaviour changes that are not listed as breaking but could
>      affect this codebase (e.g. default-value changes, new required
>      inputs, deprecation warnings that promote to errors next major).
>    - Anything labelled "security" — confirm the CVE is real, not a
>      typo'd advisory.
>    - Anything labelled "unstable" / "experimental" / "preview".
>
> 5. **Repository-activity sniff test.** Fetch the dependency's commit
>    list between the two version tags using `WebFetch`:
>    ```
>    URL: https://api.github.com/repos/<dep_owner>/<dep_repo>/compare/<OLD_TAG>...<NEW_TAG>
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
>    - **github-actions**: no local execution. Inspect the workflow
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
> 9. **Verdict report.** Reply with EXACTLY one of:
>    - `VERDICT: SAFE — <one-paragraph rationale citing the CHANGELOG
>      entries reviewed and confirming build/test/clippy passed
>      cleanly>`
>    - `VERDICT: FIXED — <one-paragraph rationale describing the fix
>      commit, citing the CHANGELOG entry that motivated it>`
>    - `VERDICT: BLOCKED — <one-paragraph rationale describing what
>      blocked the merge and what a human would need to do>`
>
> Do NOT call `mcp__github__merge_pull_request` or post an approval
> review from inside the subagent. Merging is the caller's
> responsibility.

### 2b. Act on the verdict

Parse the subagent's reply for the leading `VERDICT:` token:

- **`SAFE` or `FIXED`** — proceed to step 2c (merge).
- **`BLOCKED`** — post a comment on the PR using
  `mcp__github__add_issue_comment` with the subagent's rationale (no
  approval, no merge), then advance the task list and move on to the
  next PR. Comment body template:
  ```
  /dependabot-review verdict: BLOCKED

  <subagent rationale>

  This PR was not auto-merged. A human needs to decide how to proceed.
  ```
  **Do NOT include `@dependabot` in the comment body** — the MCP tool
  will corrupt it with middle-dot characters, making it inert.

### 2c. Merge gate (only on SAFE / FIXED)

The four conditions of [ADR-0013](../../docs/adr/0013-conditional-bot-driven-merge.md)
apply per merge:

1. **Per-session permission**: satisfied by this command's invocation.
2. **Full check rollup green**: verify by calling
   `mcp__github__pull_request_read` with `method: get_check_runs` and
   `perPage: 100` for the PR. Every check must have `status: completed`
   and `conclusion: success` or `conclusion: skipped`. If any check has
   `status: queued` or `status: in_progress`, wait for it to settle
   (poll by re-calling `get_check_runs` after a delay). If any check has
   `conclusion: failure`, revisit step 2a for that PR (the failure may
   be a regression the prior audit missed, or a transient network error
   — see "Failure modes" below for the transient-failure recovery path).
3. **Auto-review converged on HEAD**: the audit subagent that just
   returned IS the converged review. If the subagent pushed a fix
   commit (verdict `FIXED`), CI will be re-running on the new HEAD;
   wait for it per (2) before merging.
4. **Direct squash merge**: call `mcp__github__merge_pull_request` with:
   ```
   owner: koedame
   repo: chordsketch
   pullNumber: <PR>
   merge_method: squash
   ```

Mark the task `completed`. Move on to the next PR.

## Step 3 — Inter-PR branch-update wait

After merging any PR, Dependabot will auto-rebase its other open PRs
in the same ecosystem (because their branch's lock file or workflow
file is now behind `main`). Before starting the next PR's audit,
fetch fresh PR metadata by calling `mcp__github__pull_request_read`
with `method: get` for the next PR. Check the `mergeable_state` field:

- `mergeable_state: "behind"` — the branch needs to be updated. Call
  `mcp__github__update_pull_request_branch`:
  ```
  owner: koedame
  repo: chordsketch
  pullNumber: <NEXT_PR>
  ```
  This brings the branch up to date and triggers fresh CI. Wait for CI
  to settle (poll `get_check_runs` with `perPage: 100` until no
  `queued` / `in_progress` checks remain) before invoking the subagent.

- `mergeable_state: "blocked"` with pending checks — CI is running;
  wait for it to settle.

- `mergeable_state: "clean"` — ready to audit.

**Never post `@dependabot rebase` as a comment.** The GitHub MCP tool
sanitizes `@mentions` and the comment will arrive corrupted and inert.
Use `mcp__github__update_pull_request_branch` instead.

If Dependabot has not auto-rebased and `mcp__github__update_pull_request_branch`
also fails (e.g. merge conflict it cannot resolve automatically), leave
a plain comment (without `@mention`) explaining the situation and mark
the PR as BLOCKED for human resolution.

## Step 4 — Final summary

After every PR in the working list has been processed, post a
summary to the chat (NOT as a GitHub comment). Format:

```
Processed N Dependabot PRs:
  - Merged: <count> (#<PR>, #<PR>, ...)
  - Blocked (need human): <count> (#<PR>: <one-line reason>, ...)
  - Skipped (CI failed even after fix): <count> (#<PR>: <one-line reason>, ...)
```

If any PR is in the BLOCKED bucket, end the summary with:
"See the comment on each blocked PR for the full audit rationale."

Also send a push notification via `PushNotification` with a summary so
the maintainer is informed even if they are not watching the session.

## Failure modes to watch for

- **`mcp__github__merge_pull_request` fails with "Pull request is not
  mergeable"**: the branch is behind `main`. Call
  `mcp__github__update_pull_request_branch` to update it, wait for CI
  to settle (poll `get_check_runs` with `perPage: 100`), then retry the
  merge once. If it fails again, mark BLOCKED and move on.

- **Transient CI failure (network error during a CI run)**: if
  `get_check_runs` shows a `conclusion: failure` on a job like "Test
  action" whose sibling variants all passed and whose timing coincides
  with a network outage window (all failed jobs started within the same
  ~60-second span), the failure is likely transient. Recover by pushing
  an empty commit to the PR's branch to trigger fresh CI:
  ```bash
  git fetch origin <HEAD_REF>
  git worktree add ../chordsketch-wt/retrigger-<PR> <HEAD_REF>
  cd ../chordsketch-wt/retrigger-<PR>
  git commit --allow-empty -m "ci: retrigger CI after transient network failure"
  git push origin <HEAD_REF>
  cd -
  git worktree remove ../chordsketch-wt/retrigger-<PR>
  ```
  Do NOT use `mcp__github__actions_run_trigger` with `rerun_failed_jobs`
  — this returns `403 Resource not accessible by integration` in this
  environment (the integration token lacks `actions:write` permission).

- **Subagent's worktree create fails because the path already exists**:
  a previous interrupted invocation left a stale worktree. Run:
  ```bash
  git worktree remove --force ../chordsketch-wt/dependabot-review-<PR>
  git branch -D dependabot-review-<PR>
  ```
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
  abort that PR's processing with a comment (using
  `mcp__github__add_issue_comment`) explaining that this command only
  operates on PRs against `main`.

- **`mcp__github__add_issue_comment` corrupts bot commands**: the MCP
  tool inserts U+00B7 middle-dot characters into `@mentions`. This makes
  `@dependabot rebase` arrive as `·@·d·ependabot r·ebase` which does
  not trigger Dependabot. Never post bot trigger strings as comments —
  use `mcp__github__update_pull_request_branch` instead.

## Notes

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
