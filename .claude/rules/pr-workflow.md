# Pull Request Workflow

## Automated Flow (default)

PRs are reviewed automatically; **merging is always a human action**.

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
6. **Ready for human merge** — when the review converges to zero findings,
   Claude posts a single summary comment stating "Ready for human merge." Bots
   **never** run `gh pr merge` in this repo. A human inspects the full check
   rollup (not just the required checks listed in branch protection) and
   performs the squash merge.
7. **Safety cap** — after 3 auto-review iterations, the process stops and waits for
   human intervention.

Before merging, the author (or the human doing the merge) verifies there are no
open GitHub Issues authored by a review bot during this PR's lifetime. If any
exist, close them as part of the PR — either via a referencing fix commit or,
for items judged genuinely out of scope after discussion, by closing as
`not planned` with a justification that matches the PR body's "Deferred" entry.

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

**Pre-rule backlog.** Review-bot-filed issues that predate this rule (e.g.
most issues in the #2180–#2234 range that were filed by review agents or the
auto-review Claude bot as "non-blocking follow-ups") are orphaned and do not
need to be resolved before any specific PR merges. Fold them into the next
relevant PR when natural, or close as `not planned` when stale.

### Why bots do not merge

A previous iteration of this workflow had bots run `gh pr merge --squash --auto` after
review. This was removed after a PR was silently merged with two `README Install Smoke
Tests` jobs in FAILURE state, because those jobs were not in the
`required_status_checks.contexts` list of branch protection. `gh pr merge --auto` only
waits for *required* checks, so any check not in the explicit list is ignored. The
combination of "required-list drift" and "no human gate" produced a silent
regression in coverage. Removing bot-driven merging closes the second hole and
turns the first one into "PR sits open with red checks until a human looks."

## Manual Flow (optional)

For local review before pushing, or when the automated flow is not desired:

1. Run `/review` and/or `/security-review` locally.
2. Fix any blocking findings, then push.
3. The automated flow takes over from step 2 above.

## Rules

- All changes enter `main` via pull request — no direct pushes.
- All PRs are **squash-merged** (merge commits and rebase merging are disabled).
- Branch protection enforces that status checks pass on the HEAD commit before merging.
- `main` is protected by **GitHub Merge Queue**
  (rationale: [ADR-0003](../../docs/adr/0003-github-merge-queue.md)).
  When a human clicks "Merge when ready" (or runs
  `gh pr merge --merge-queue`), the PR enters the queue; GitHub
  creates a speculative merge commit against the current tip of
  `main`, CI runs against that merge commit (the `merge_group:`
  trigger in `ci.yml`), and the PR lands only if CI passes on the
  merge commit. The queue replaces the old `auto-update-branch.yml`
  rebase-fan-out loop — there is no longer a per-merge cascade that
  re-runs CI on every open PR.

### Merge Queue expectations

- Workflows that produce `required_status_checks` MUST include
  `merge_group:` alongside `pull_request:` in their `on:` block. The
  queue's speculative merge commit runs against the `merge_group`
  event, and any required check that does not fire on that event
  blocks the queue indefinitely.
- Non-required workflows that compute on PR events (smoke jobs,
  language-binding builds, etc.) do NOT need `merge_group:` triggers
  — the queue does not wait on them. Adding them produces wasted CI
  runs on every queued merge.
- If CI fails against the speculative merge commit, GitHub removes
  the PR from the queue automatically. The author investigates,
  pushes a fix, and re-queues manually.

### Secret-access caveat for `merge_group:` events

Unlike `pull_request:` from forks (which run with restricted
permissions and no secret access), `merge_group:` events run on a
GitHub-built merge commit with **full repo-secret access** — the
same posture as `push:` to a protected branch. That means a queued
PR that touches `.github/workflows/`, `Cargo.toml`, or any other
file the speculative merge commit will execute in CI gains
secret-bearing CI on the queue's merge commit.

The "Merge when ready" click is the gate for this. Reviewers MUST
scrutinise diffs touching `.github/`, build scripts, or anything
that runs as a CI step before clicking. Treat workflow-file diffs
the same way you would treat a `push:` directly to `main`.

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
