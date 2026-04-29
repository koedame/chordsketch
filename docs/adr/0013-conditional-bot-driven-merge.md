# 0013. Bot-driven merge is allowed under explicit session permission

- **Status**: Accepted
- **Date**: 2026-04-29

## Context

Until this ADR, `.claude/rules/pr-workflow.md` carried an
absolute prohibition: "Bots **never** run `gh pr merge` in this
repo." `CLAUDE.md` echoed it as "merging is always a human
action." The rule was added after a regression where a previous
iteration of the workflow had bots run `gh pr merge --squash
--auto`. A PR was silently merged with two `README Install
Smoke Tests` jobs in FAILURE state because those jobs were not
in the `required_status_checks.contexts` list of branch
protection. `gh pr merge --auto` only waits for *required*
checks, so any check not in the explicit list is ignored. The
combination of "required-list drift" and "no human gate"
produced a silent regression.

Since that incident two structural changes have landed:

- **GitHub Merge Queue** ([ADR-0003](0003-github-merge-queue.md))
  protects `main`. Branch protection requires status checks to
  pass on the speculative merge commit, and the queue rejects PRs
  whose required checks fail on that commit. The required-list
  drift problem still exists, but it can no longer cause a merge
  with red required checks; it can only cause a merge with red
  *non-required* checks.

- **Auto-review convergence** (`.claude/rules/pr-workflow.md`
  step 4): every severity, including Nit, is resolved in-PR
  before the review loop converges. The "Ready for human merge"
  comment is only posted after the delta-review surfaces zero
  findings.

The remaining gap is the non-required-check class. Closing it by
inspection — i.e. by requiring the merging actor to read the
**full** check rollup, not just the required list — was already
the rule for human merges. The cost of bot-driven merging was
that the bot did not perform that inspection.

The 2026-04-29 PR #2328 cycle made the friction concrete: the
user verbally granted "session-wide merge permission" twice,
both times the hook denied the bot's enqueue with the rule text
quoted as the rationale, and the user performed the merge by
hand each cycle. The rule was correct in spirit ("we want a
human eye on the rollup") but wrong in mechanism ("the bot
literally cannot enqueue, even when explicitly authorised by the
human who would otherwise click the button").

## Decision

`gh pr merge` (or the equivalent `enqueuePullRequest` GraphQL
mutation) MAY be executed by an AI assistant when **all** of the
following hold:

1. **Explicit, current-session permission.** The user has stated
   in the active session that the assistant may merge. Standing
   memory entries from earlier sessions do NOT count — the grant
   is per-session and explicit.

2. **Full check rollup green.** Every check on the PR — required
   AND non-required — is in the `pass` or `skipping` state. A
   single `fail` or `pending` check blocks the merge. The
   assistant verifies this by reading
   `gh pr checks <PR>` (not just the required-status section).
   This is the same inspection a human merger would perform per
   the existing "inspects the full check rollup" clause.

3. **Auto-review converged.** The latest auto-review delta
   reported "No findings" / "Ready for human merge" against the
   PR's HEAD commit. If the bot's own most recent fix commit
   produced a new auto-review iteration, that iteration must
   have completed and converged.

4. **Merge queue path only.** The assistant uses
   `enqueuePullRequest` (the merge queue's GraphQL mutation) or
   `gh pr merge --merge-queue`. Direct merges via
   `gh pr merge --squash` (without `--merge-queue`) bypass the
   speculative-merge CI run and are still prohibited.

If any of (1)–(4) is not satisfied, the assistant posts the
existing "Ready for human merge" comment and waits.

## Rationale

### Why allow it at all?

The original incident's root cause was unverified non-required
checks, not bot-driven merging in general. Conditioning the
permission on full-rollup inspection (clause 2) addresses the
root cause directly. With the merge queue (ADR-0003) and
auto-review convergence (pr-workflow.md step 4) layered on top,
the "silent merge with red checks" failure mode requires three
independent guard failures — branch protection drift AND
non-required check failure AND assistant skipping the rollup
read. The rule's previous absoluteness paid for protection
against a single guard failure, which the queue and convergence
already eliminate.

### Why per-session, not standing?

A standing grant would let an assistant inherit merge capability
from a session months earlier whose context the user has
forgotten. The friction of re-asserting permission once per
session is small (one sentence) and serves as a deliberate
checkpoint — the user reaffirms that they intend automation to
land merges in this specific working window.

### Why merge queue only?

The queue's speculative-merge commit re-runs CI against the
exact merge commit that will land on `main`. A direct
`--squash` (without `--merge-queue`) merges the PR's HEAD
commit, which CI ran against a now-stale `main`. The queue is
the only path that proves the post-merge tree is green; bypassing
it would re-introduce a class of regression (mid-air collisions
between mergeable PRs) the queue was specifically chosen to
prevent.

### Why does the previous absolute rule's "Why bots do not merge" rationale not apply anymore?

Reproducing the original failure mode under the new rule would
require:

- A non-required check failing (still possible — required-list
  drift is unsolved).
- The assistant skipping clause 2's full-rollup inspection
  (rule violation, not silent miss).
- The user granting per-session permission while the failing
  check is in plain sight (clause 2 makes that a contradiction).

The original failure was structural ("`gh pr merge --auto`
ignores non-required checks by design"); the new rule's
structural property is "the assistant reads `gh pr checks`
output before enqueueing." Different mechanism, different
failure surface.

## Consequences

**Accepted:**

- The assistant now bears responsibility for full-rollup
  inspection. A bug in clause 2's verification step produces
  the same failure class the original rule was guarding
  against. Mitigation: the inspection is mechanical (`gh pr
  checks` text grep for `fail|pending`) and easier to audit
  retroactively than a human's "I looked at the page" claim.
- A user who grants per-session permission has effectively
  pre-authorised the merge of any PR that subsequently meets
  clauses 2–4 in that session. They retain veto by withdrawing
  permission ("don't merge yet") at any time.

**Gained:**

- The "Ready for human merge → user enqueues by hand" handoff
  becomes "Ready for human merge → if pre-authorised, the
  assistant enqueues; otherwise, comment and wait." Removes a
  per-PR ping for green PRs the user has already authorised.
- The hook denial flow that triggered this ADR no longer fires
  on grants the user actually intended.

**Negative:**

- Future contributors reading
  `.claude/rules/pr-workflow.md` see "merging defaults to a
  human action; bots may merge under explicit session
  permission" instead of a flat ban. Slightly more cognitive
  load to remember the four clauses than to remember "never."
  Mitigation: the four clauses are spelled out in the rule, and
  a violation surfaces as either a bot enqueueing without
  permission (visible in chat history) or a merge of a PR with
  red non-required checks (visible in the check rollup).

## Alternatives considered

1. **Keep the absolute prohibition.** Rejected. The 2026-04-29
   PR #2328 cycle showed the rule's friction (per-PR ping for
   green PRs the user already authorised) outweighs its
   protection benefit now that the merge queue exists.

2. **Allow standing per-repo grant via a settings flag.**
   Rejected. A standing grant would let an assistant inherit
   merge capability from a session whose context the user has
   forgotten. Per-session is the deliberate checkpoint.

3. **Allow direct `gh pr merge --squash` without
   `--merge-queue`.** Rejected. Direct merge bypasses the
   speculative-merge CI run that ADR-0003 chose the queue for;
   this would reintroduce a class of regression the queue
   prevents.

4. **Allow bot merge only on docs-only PRs.** Considered.
   Rejected because the criterion is hard to define
   mechanically (a docs PR can still touch `.github/` and
   change CI) and the merge-queue + full-rollup-inspection
   safeguards already cover the underlying concern. A
   docs-only carve-out would also fail to address the original
   incident's class — README Install Smoke Tests fail on docs
   changes too.

## References

- Issue #2329 — this ADR's tracking issue.
- PR #2328 — the live cycle that produced the rule's friction
  on 2026-04-29.
- [ADR-0003](0003-github-merge-queue.md) — Merge Queue, the
  structural change that made conditional bot-merge safe.
- `.claude/rules/pr-workflow.md` "Why bots do not merge"
  section — superseded by the conditional clauses introduced
  in this ADR.
- Memory `feedback_no_bot_merge` — superseded; the persistent
  memory will be updated to reflect the new policy in a
  later session.
