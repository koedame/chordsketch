# Pull Request Workflow

## Automated Flow (default)

PRs are reviewed automatically; **merging defaults to a human
action**. An AI assistant MAY perform the merge under maintainer
authorization and additional safeguards — see
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
   delta review surfaces nothing further (or the safety cap in step 7 fires).
5. **No follow-up issues for review findings.** Review bots MUST NOT call
   `gh issue create` during review. If a finding is genuinely out of the PR's
   scope (e.g. a pre-existing defect in an unrelated crate surfaced in passing),
   the PR body's "Deferred" section records it with a one-line justification
   and a link to an existing tracker. The default is "fix it in this PR."
6. **Ready for merge** — when the review converges to zero findings,
   Claude posts a single summary comment stating "Ready for merge." If the
   four conditions in the "Bot-driven merge: conditional permission"
   section below are met — the first of them being maintainer authorization —
   Claude adds the PR to the merge queue (condition 4). Otherwise, a
   human inspects the full check rollup (not just the required checks
   listed in branch protection) and clicks "Merge when ready". The queue
   runs the required checks, including every publish check, on the commit
   that will become `main`, and squash-merges it
   ([ADR-0079](../../docs/adr/0079-merges-go-through-the-queue-which-runs-the-publish-checks.md)).
7. **Safety cap** — after 10 auto-review iterations, the process stops and waits for
   human intervention. The cap was raised from 3 to 10 because the
   typical convergence trajectory observed on real PRs (~10 → ~5 →
   ~1 → 0 findings) needs about four iterations and a cap of 3
   forced otherwise-clean convergence into a human handoff that was
   not actually needed; 10 still bounds runaway loops (ADR-needed
   cases, contested design judgement) without burning the human
   handoff on routine docs / refactor PRs.

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

An AI assistant MAY add a PR to the merge queue when
**all four** conditions hold. See
[ADR-0013](../../docs/adr/0013-conditional-bot-driven-merge.md) for
the bot-merge rationale and
[ADR-0079](../../docs/adr/0079-merges-go-through-the-queue-which-runs-the-publish-checks.md)
for why condition (4) is the merge queue.

1. **Authorization to merge.** The maintainer has authorized the
   merge in one of three forms:

   - **Authorization granted with the work unit.** The maintainer
     granted merge authority when handing over a self-contained
     unit of work — including the configured run of a
     maintainer-operated automation. The grant covers the PRs the
     assistant opens as part of that work unit.
   - **A named PR.** The work unit names the PR to be merged.
   - **Explicit permission in the active session.** The maintainer
     states in the session that the assistant may merge.

   Authorization is never inferred and never carried over.
   A grant from an earlier session, from a different work unit, or
   from a standing memory entry does NOT authorize this merge, and
   permission to merge one PR says nothing about any other PR.
   When no form applies, post "Ready for merge" and leave the
   merge to the maintainer.

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

4. **Merge through the queue.** Once (1)–(3) hold, enqueue the PR at
   the HEAD they were checked on; the queue decides the squash:

   ```bash
   gh api graphql \
     -f query='mutation($id: ID!, $oid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid}) { mergeQueueEntry { position } } }' \
     -f id="$(gh pr view <N> --json id --jq .id)" \
     -f oid=<HEAD checked by (2) and (3)>
   ```

   `gh pr merge <N>` is not a safe substitute here. Per its own
   `--help` text, on a queue-protected branch it enqueues directly
   only once GitHub already reports the PR's required checks as
   passed; otherwise it falls back to enabling auto-merge instead —
   which is disabled at the repository level
   (`enablePullRequestAutoMerge: false`) and fails with
   `Auto merge is not allowed for this repository`. Whether GitHub's
   own required-check state matches what (2) just verified is a race
   the explicit mutation avoids entirely: pinning `expectedHeadOid` to
   the HEAD (2) and (3) were checked on enqueues that exact commit or
   fails cleanly, never falling back to auto-merge. Never pass
   `--admin`: it merges past the queue and past the publish checks a
   pull request may have skipped. The
   merge is done when the PR is `MERGED`, not when the command
   returns. If the queue removes the PR, read the failing
   `merge_group` run, fix and push (a GitHub-side transient failure
   may be re-queued as is), meet (2) and (3) on the new HEAD, and
   enqueue again.

If any of (1)–(4) is not satisfied, post the "Ready for merge"
comment and wait for the human merger.

### Scheduled unattended Dependabot review-and-merge (ADR-0024)

Clause 1 above ("authorization to merge") is satisfied without any
per-run maintainer action — **for Dependabot PRs** — by
[ADR-0024](../../docs/adr/0024-scheduled-dependabot-merge.md). A
scheduled, maintainer-operated automation MAY run the
`/dependabot-review`-equivalent flow (audit, apply required code-side
adaptation, squash-merge) without a per-session human invocation, for
any bump type (patch, minor, or major), when **all** of the following
hold for a PR:

1. **Author is `dependabot[bot]`.**
2. **The audit clears the PR** with a `SAFE` verdict (no change needed)
   or a `FIXED` verdict (the automation applied the required code-side
   adaptation as commits on the Dependabot branch). The audit covers
   diff sanity, GitHub Advisory Database exposure, and release notes
   across every version between old and new — for every dependency the
   PR updates, so a grouped PR is cleared only when each of its rows is
   ([ADR-0075](../../docs/adr/0075-dependabot-groups-patch-and-minor-updates.md)).
3. **Full check rollup green** on the final commit (clause 2 above,
   unchanged — required AND non-required; for a `FIXED` PR, the rollup
   *after* the adaptation commits).
4. **Direct squash** (clause 4 above, unchanged).
5. **The audit posts its verdict as a PR comment before merging.** A PR
   the audit cannot clear (`BLOCKED` / `NEEDS_REVIEW`) is commented and
   left open for a human; it is never merged unattended.

**Clause 3** (auto-review converged on HEAD) is satisfied by the
automation's own audit pass — analogous to ADR-0016's mapping where the
skill's audit cycle IS the converged review. Clauses 2 and 4 are
unchanged and must be met verbatim.

The semver level is not part of the gate — majors are handled the same
way the attended skill handles them (read release notes, adapt the code,
let the full matrix validate). The scheduled run is the maintainer's
standing authorization for Dependabot PRs, so no separate grant is
needed at merge time. Every **non-Dependabot** bot-initiated merge
still needs authorization in one of clause 1's three forms.

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
CI run, originally from
[ADR-0003](../../docs/adr/0003-github-merge-queue.md) — was removed in
[ADR-0015](../../docs/adr/0015-disable-github-merge-queue.md) and
restored in
[ADR-0079](../../docs/adr/0079-merges-go-through-the-queue-which-runs-the-publish-checks.md),
which moved the publish checks into the queue so that pull requests
that reach no package can skip them.

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
- Branch protection requires the status checks to pass on the HEAD
  commit, and `main` requires the merge queue, which runs them again
  on the commit that will land. A PR does not have to be up to date
  with `main`: the queue composes it with the current `main`, so a
  catch-up rebase is only needed for a conflict.
- The merge action is the GitHub UI's "Merge when ready" button or
  the `enqueuePullRequest` mutation in condition (4), both of which
  add the PR to the queue
  ([ADR-0079](../../docs/adr/0079-merges-go-through-the-queue-which-runs-the-publish-checks.md)).
  `--admin` bypasses the queue and is not part of the flow.

### Workflow trigger expectations

- Workflows that produce `required_status_checks` MUST include both
  `pull_request:` and `merge_group:` in their `on:` block. A required
  check that does not run on `merge_group` leaves every queued PR
  waiting until the queue times out.
- A required check that should not run in full on every PR still
  reports on every PR: decide inside the workflow and let the
  aggregate job pass, as `publishable.yml`'s `scope` job does. A
  `paths:` filter would leave the check pending.
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

### Batched-PR formatting (autopilot-issue, ADR-0019)

The `autopilot-issue` workflow can aggregate multiple
high-confidence eligible issues into one PR per round. Multi-issue
PR bodies follow this shape so each closed issue stays traceable:

- **Title**: `batch(autopilot): <K> issues — <YYYY-MM-DD>` for
  multi-issue batches; the historical `<scope>: <subject> (#<N>)`
  shape for single-issue batches.
- **Per-issue section**: under `## Per-issue changes`, one
  `### #<N>: <title>` block per applied issue. Each block names the
  closed issue, its commit SHA + subject (autopilot writes one
  commit per issue inside the PR — see
  [branch-strategy.md](branch-strategy.md) §"Batched autopilot
  branches"), a 1-3 bullet "what changed", the touched file list,
  and the sister-site spot-check that issue triggered.
- **Aggregated sister-site audit**: one `## Aggregated sister-site
  audit` block summarising the cross-issue audit conclusions the
  per-issue spot-checks accumulate into.
- **Deferred section**: any issue the implementation phase
  attempted but reverted (3-attempt corrective-action loop
  exhausted) appears under `## Deferred` with its number, reason,
  and last-error tail. Deferred items remain open as issues — they
  are NOT absorbed by this PR and not closed by squash-merge.
- **Closes lines**: one `Closes #N` line per **applied** issue
  (NOT per deferred issue), each on its own line so GitHub closes
  every aggregated issue on squash-merge.

Single-issue batches use the unchanged single-issue body shape (one
`## What` / `## Why` / `## Test results` / `## Review summary` /
`## Sister-site audit` / `## Deferred` block with one `Closes #N`).
