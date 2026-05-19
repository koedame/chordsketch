# Effort Is Not a Filter

When surveying candidate work — open issues, pending review-finding
follow-ups, proposals on the table — **do not exclude an item
because of its estimated effort or duration**. The
`size:small` / `size:medium` / `size:large` labels documented in
[`issue-workflow.md`](issue-workflow.md) and any analogous duration
estimate exist to help with **triage planning**, not with the
go / no-go decision on whether to pick up a piece of work.

## Rule

Filtering or de-prioritising candidate work on grounds like
"this is `size:large`, so it doesn't fit a single PR" or "this
looks like a multi-day task, so skip it" is prohibited. The
correct filtering criteria are:

- **Feasibility** — does the executor have the inputs, access,
  authority, and tools needed to complete the work as scoped?
- **Active blockers** — is something genuinely required from an
  external system, an upstream maintainer, or another party that
  has not arrived?
- **Value** — does landing this advance a stated project goal?

Effort estimates are a separate axis. A `size:large` candidate
that is feasible, unblocked, and valuable is selectable; the only
thing its size changes is *how the work is split into PRs*, not
*whether the work is taken on*.

## Why

Two structural failure modes motivate this rule:

1. **Effort estimates in this codebase are almost always
   fabricated.** [`evidence-based-claims.md`](evidence-based-claims.md)
   already prohibits stating fabricated durations as fact in PRs,
   comments, and decisions. Filtering on a fabricated number
   compounds the original error: a weakly-grounded guess
   ("this looks like 8 hours") becomes a binary go / no-go
   decision the guess never had the precision to support.

2. **The "single PR scope" framing conflates selection with PR
   splitting.** Survey-time selection ("do we pick this up?") is
   not the same question as implementation-time splitting
   ("does this ship as one PR or several?"). Large work routinely
   ships as one PR; large work that doesn't ship as one PR splits
   at the implementation layer when concrete coupling appears, not
   at the survey layer on the basis of a label.

The combined failure mode is silent and high-cost: a `/loop`
survey, an `autopilot-issue` round, or a manual `gh issue list`
triage discards otherwise-deliverable work and reports "no
actionable candidates" while the tracker still has real,
shippable issues in it.

## Required practice

When surveying candidate work:

1. **List all candidates without applying an effort filter.**
   `gh issue list --state open` (plus any project-relevant label
   filters that are *not* size labels) returns the survey set.
2. **For each candidate, evaluate feasibility and active blockers
   explicitly.** Effort is recorded as metadata but does not
   drive selection. If a candidate is feasible and unblocked,
   it is selectable.
3. **If a selected item is large, split at the implementation
   layer.** Open the work, identify a coherent first PR scope
   from the natural seams in the code, ship that, then continue.
   Do not pre-commit to a split plan from the survey-time view;
   the right split is usually only visible once the
   implementation has begun.
4. **If genuinely nothing is selectable, say so — but never use
   "looks long" as the reason.** Acceptable reasons are
   "every candidate is blocked on external state X", "every
   candidate requires access Y that the executor doesn't have",
   or "every candidate has no current value because of project
   state Z". "Every candidate looks like multi-day work" is not
   an acceptable reason.

## Scope

Applies to:

- Survey passes initiated by `/loop`, batch-mode `autopilot-issue`
  (see [ADR-0019](../../docs/adr/0019-batch-mode-autopilot-issue.md)),
  or manual `gh issue list` triage.
- PR scope decisions inside an active feature branch — a
  cross-cutting concern surfaced mid-PR is not deferred because
  "this PR is getting long." See
  [`pr-workflow.md`](pr-workflow.md) §"All findings, every
  severity, resolved in-PR" for the sibling rule that already
  forbids deferring review findings on similar grounds.

Does not apply to:

- **Genuine capacity signals from the user.** Effort framing the
  user themselves introduces ("I only have 20 minutes today; pick
  something tight") is a hard constraint, not an internal guess —
  honour it.
- **Sub-issue prioritisation inside an umbrella that is already
  selected.** That is sequencing within a chosen scope, not
  selection from the candidate pool.
- **Single-session capacity warnings about a clearly-bounded
  blocker** (e.g. "this needs a 30-minute external service call
  that the executor can't make right now"). The blocker, not the
  duration, is the operative reason.

## Cross-references

- [`evidence-based-claims.md`](evidence-based-claims.md) — the
  parent rule prohibiting fabricated durations and unverified
  quantitative claims in user-facing output. This rule is its
  selection-time corollary.
- [`issue-workflow.md`](issue-workflow.md) — defines the size
  labels and the rest of the issue-driven workflow. The size-label
  table cross-references back to this file.
- [`pr-workflow.md`](pr-workflow.md) — the in-PR-resolution rule
  is the implementation-time sibling: once work is selected,
  review findings on the resulting PR cannot be deferred on
  effort grounds either.
