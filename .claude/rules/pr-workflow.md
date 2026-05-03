# Pull Request Workflow

## Automated Flow (default)

PRs are reviewed automatically; **merging defaults to a human
action**. An AI assistant MAY enqueue the merge under explicit
session permission and additional safeguards — see
[ADR-0013](../../docs/adr/0013-conditional-bot-driven-merge.md)
and the "Bot-driven merge: conditional permission" section
below.

1. **PR created** — author opens PR with code and tests.
2. **CI runs** (cargo fmt --check, cargo clippy -- -D warnings, cargo test, plus
   workflow-specific smoke jobs).
3. **Auto-review** — on CI success, `claude-review.yml` requests a Claude review
   with severity classification. Claude performs both code review and security review.
4. **All findings — every severity — resolved in-PR.** Every High / Medium / Low /
   Nit finding produces a fix commit on the PR branch. CI re-runs, then a **delta
   review** examines only the fix commits. The review loop iterates until the
   delta review surfaces nothing further (or the safety cap in step 6 fires).
5. **No follow-up issues for review findings.** Review bots MUST NOT call
   `gh issue create` during review. If a finding is genuinely out of the PR's
   scope (e.g. a pre-existing defect in an unrelated crate surfaced in passing),
   the PR body's "Deferred" section records it with a one-line justification
   and a link to an existing tracker. The default is "fix it in this PR."
6. **Ready for merge** — when the review converges to zero findings,
   Claude posts a single summary comment stating "Ready for merge." If the
   user has granted per-session merge permission and the four conditions in
   the "Bot-driven merge: conditional permission" section below are met,
   Claude squash-merges directly via `gh pr merge --squash`. Otherwise, a
   human inspects the full check rollup (not just the required checks
   listed in branch protection) and performs the squash merge.
7. **Safety cap** — after 3 auto-review iterations, the process stops and waits for
   human intervention.

Before merging, the author (or the human doing the merge) verifies there are no
open GitHub Issues authored by a review bot during this PR's lifetime. Per
step 5 this list should be empty; the check exists to catch rule violations —
a review bot that still calls `gh issue create` despite the prompt update is a
bug, not an expected flow. If any exist, close them as part of the PR —
either via a referencing fix commit or, for items judged genuinely out of
scope after discussion, by closing as `not planned` with a justification
that matches the PR body's "Deferred" entry.

### Why in-PR resolution of every severity

The previous rubric — Low/Nit → filed as issues and merge-not-blocked — created a
backlog that reviewer signal never caught up to. Each filed issue reset the
context for a future attempt: the reviewer's rationale, the surrounding diff,
and the reviewer's mental model all had to be reconstructed from a short issue
body weeks or months later. Fixing in-PR keeps the reviewer, author, and code
co-located.

The cost is a longer review cycle on each PR. The benefit is that merged PRs
are actually finished, and the review-findings pool stays at zero instead of
growing by ~3 items per PR.

**Pre-rule backlog.** 38 open issues in the #2180–#2234 range predate this
rule — most filed by review agents or the auto-review Claude bot as
"non-blocking follow-ups" against PRs that have since merged. They are
orphaned and do not need to be resolved before any specific PR merges.
Fold them into the next relevant PR when natural, or close as `not
planned` when stale.

Recent issues against code paths that are *still* in active flight (for
example, findings filed against a PR whose follow-up implementation is
already underway) should be folded into that in-flight PR rather than
orphaned — the rule's goal is that reviewer signal lands before context
rots, and context is freshest while the code is still being edited.

### Bot-driven merge: conditional permission

`gh pr merge --squash` MAY be executed by an AI assistant when
**all four** conditions hold. See
[ADR-0013](../../docs/adr/0013-conditional-bot-driven-merge.md) for
the bot-merge rationale and
[ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md) for
why condition (4) is a direct squash and not a merge-queue enqueue.

1. **Explicit, current-session permission.** The user has stated
   in the active session that the assistant may merge. Standing
   memory entries from earlier sessions do NOT count — the grant
   is per-session and explicit.

2. **Full check rollup green.** Every check on the PR — required
   AND non-required — is in the `pass` or `skipping` state.
   Verified by reading `gh pr checks <PR>` output (not just the
   required-status section). One `fail` or `pending` check
   blocks the merge.

3. **Auto-review converged.** The latest auto-review delta
   reported "No findings" / "Ready for merge" against the PR's
   HEAD commit. If the bot pushed its own fix commit, the
   resulting auto-review iteration must have completed and
   converged.

4. **Direct squash merge.** Use `gh pr merge <N> --squash` (or the
   equivalent `mergePullRequest` GraphQL mutation with
   `mergeMethod: SQUASH`). Auto-merge is disabled at the repo
   level (`enablePullRequestAutoMerge: false`); the assistant's
   `--squash` invocation runs synchronously against the PR's
   current HEAD. The merge queue is no longer in use
   ([ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md));
   `enqueuePullRequest` / `--merge-queue` paths are not available.

If any of (1)–(4) is not satisfied, post the "Ready for merge"
comment and wait for the human merger.

#### Historical rationale (superseded)

A previous iteration of this workflow had bots run `gh pr merge --squash --auto` after
review. That behaviour was removed after a PR was silently merged with two
`README Install Smoke Tests` jobs in FAILURE state, because those jobs were
not in the `required_status_checks.contexts` list of branch protection.
`gh pr merge --auto` only waits for *required* checks, so any check not in
the explicit list was ignored. The combination of "required-list drift" and
"no human gate" produced a silent regression.

Condition (2) above ("Full check rollup green") closed that gap by
turning "non-required check failing" into a blocking-by-rule case
rather than a silent skip — eliminating the required-list drift
class regardless of which merge mechanism is used.

A second structural protection — the merge queue's speculative-merge
CI re-run, originally from
[ADR-0003](../../docs/adr/0003-github-merge-queue.md) — was removed in
[ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md). The
queue's protection against red *required* checks landing on `main` is
now policy-only via condition (2), not policy + structural. ADR-0015
documents why the wall-clock cost of the queue's second CI pass no
longer justified its defence-in-depth value at this repo's scale.

The previous absolute ban on bot-driven merging traded condition (2)
for a single property — "the assistant cannot enqueue at all" — at
the cost of a per-PR ping on every green PR the user had already
authorised.
[ADR-0013](../../docs/adr/0013-conditional-bot-driven-merge.md)
records why the trade is no longer worth it.

## Manual Flow (optional)

For local review before pushing, or when the automated flow is not desired:

1. Run `/review` and/or `/security-review` locally.
2. Fix any blocking findings, then push.
3. The automated flow takes over from step 2 above.

## Rules

- All changes enter `main` via pull request — no direct pushes.
- All PRs are **squash-merged** (merge commits and rebase merging are disabled).
- Branch protection enforces that status checks pass on the HEAD
  commit before merging, and that the PR branch is up-to-date with
  `main` before merging — the latter rule forces a rebase-and-rerun
  whenever `main` has moved, which catches the content-conflict
  class the merge queue used to detect.
- The merge action is `gh pr merge <N> --squash` (or the GitHub UI's
  "Squash and merge" button). The merge queue is no longer in use
  ([ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md));
  `gh pr merge --merge-queue` and the `enqueuePullRequest` GraphQL
  mutation are not part of the flow.

### Workflow trigger expectations

- Workflows that produce `required_status_checks` MUST include
  `pull_request:` in their `on:` block. Required checks fire against
  the PR's head commit; branch protection's "must be up to date"
  rule forces re-run after rebase.
- `merge_group:` triggers are obsolete under
  [ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md).
  Existing `merge_group:` lines may stay as cheap no-ops (they will
  never fire) or be cleaned up in follow-up PRs; new workflows
  SHOULD NOT add `merge_group:`. There is no `merge_group` event to
  gate on.
- Non-required workflows (smoke jobs, language-binding builds, etc.)
  fire on `pull_request:` and `push:` to `main` as appropriate.

### Severity Definitions

Severity orders the fix commits (High first, Nit last) but NOT whether a
finding merges. Every severity is resolved in-PR per step 4 above.

| Severity | Definition |
|----------|------------|
| High | Security vulnerabilities, data corruption, crashes |
| Medium | Spec violations, logic bugs, incorrect output |
| Low | Defense-in-depth gaps, minor inconsistencies, portability |
| Nit | Style, naming, test coverage suggestions |

### Delta Review

When a review produces blocking findings and fixes are applied, the subsequent review
must only examine the new commits (the fix diff), not re-review the entire PR. This
ensures convergence: fix diffs are small and produce fewer findings, trending toward
zero.

Previously-reviewed code that was not flagged is considered accepted. A review
that delivered its verdict of "nothing outstanding" at iteration N cannot revive
findings in the same region at iteration N+1; if a defect was truly missed, it
goes into the next PR that touches the area, not the current delta review.

The in-PR-resolution rule (step 4) applies equally to delta review: if the
delta review surfaces a Nit that the prior iteration missed, the Nit gets a
fix commit too. The review loop keeps iterating until the delta review is
empty. This is the convergence criterion — not "no blocking findings" but
"no findings at all".

### PR Formatting and Commit Messages

- PR titles should be concise and written in imperative mood (e.g., "Add chord
  transposition support").
- PR descriptions must include What, Why, Test results, and Review summary sections.
- PR descriptions and commit messages must stay neutral and technical. The
  following are prohibited:
  - Verbatim quotes of user or reviewer messages.
  - Session dates, timestamps, or narrative framing such as
    "in the 2026-04-XX session the assistant said X and the user replied Y".
  - GitHub handles (`@user`) naming who said what. Linking an issue or PR
    number (`#1234`) is fine; naming a person's reaction is not.
  - Blow-by-blow reconstructions of how the PR came to exist.

  Write every PR body and commit message as if onboarding a future maintainer
  who has no access to the originating conversation. The change and its
  rationale stand on their own; the conversation that produced them does not.

  **Why:** PR history and commit messages are a permanent onboarding artefact
  that future maintainers and code-archaeology tools rely on. Conversational
  context rots — participants leave, quotes lose meaning, dates become
  noise — and embedding it in durable artefacts pollutes the signal. Keep
  conversations in chat, issues, or review threads; keep PR bodies and
  commit messages in the technical-record voice.
