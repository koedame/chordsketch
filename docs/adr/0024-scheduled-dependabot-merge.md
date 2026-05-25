# 0024. Scheduled unattended Dependabot merge for patch/minor bumps

- **Status**: Accepted
- **Date**: 2026-05-26

## Context

[ADR-0013](0013-conditional-bot-driven-merge.md) permits a bot-initiated
`gh pr merge --squash` only when four conditions hold, the first of which is
**explicit, current-session human permission** — and it states plainly that
"standing memory entries from earlier sessions do NOT count — the grant is
per-session and explicit."

[ADR-0016](0016-dependabot-review-skill.md) builds on that: it deletes the
old CI auto-approval bot, un-suppresses major bumps so every update opens a
PR, and introduces the `/dependabot-review` skill. Its condition-1 mapping is
explicit — "the maintainer's invocation of `/dependabot-review` IS the
per-session grant." The whole model assumes a human is present at merge time,
invoking the skill by hand.

That assumption is the bottleneck this ADR addresses. Dependabot opens a steady
stream of patch and minor bumps (one PR per dependency per update type, weekly).
For that risk class the audit signal is fully mechanisable:

- the diff is confined to `Cargo.toml` / `Cargo.lock` (cargo) or a single
  workflow `uses:` line (github-actions);
- advisory exposure is checkable against the GitHub Advisory Database;
- behavioural deltas are readable from the dependency's release notes;
- and branch protection already runs the full matrix on every PR.

Requiring a human to invoke a skill by hand for each of these — when nothing in
the audit needs human judgement on a clean patch/minor result — is pure
latency. Major bumps are different: ADR-0016 deliberately surfaced them as PRs
precisely because their behavioural changes (e.g. `actions/checkout@v4 → @v5`
changing default `fetch-depth`) can pass a green test suite while still
altering behaviour, so a human reading the release notes remains the right
gate for majors.

## Decision

A **scheduled, maintainer-operated automation** MAY squash-merge a Dependabot
PR without a per-session human invocation when **all** of the following hold:

1. **Author is `dependabot[bot]`.** No other author qualifies for unattended
   merge under this ADR.
2. **The bump is patch or minor**, not major. Major-version bumps are always
   commented and left for a human merge (preserving ADR-0016's intent).
3. **The automated audit returns a clean (`SAFE`) verdict** — diff sanity
   (only the manifest/lockfile or a single `uses:` line), no GitHub Advisory
   Database hit against the new version, and release notes between the old and
   new version showing no breaking or undocumented behavioural change.
4. **Full check rollup is green** — every check, required AND non-required, in
   `pass` or `skipping` (ADR-0013 condition 2, unchanged).
5. **The merge is a direct squash** (`gh pr merge <N> --squash`; ADR-0013
   condition 4, unchanged).
6. **The audit posts its verdict as a PR comment before merging**, so the
   rationale is on the record. A PR that does not clear the audit
   (`BLOCKED` / `NEEDS_REVIEW`) is commented and left open for a human; it is
   never merged unattended.

For this narrow class, the scheduled automation's configured run **is** the
maintainer's standing authorization — it replaces ADR-0013 clause 1's
per-session human invocation. ADR-0013 clause 1 continues to govern every
**non-Dependabot** bot-initiated merge unchanged: those still require explicit,
current-session permission. This ADR does not widen bot-merge authority beyond
Dependabot patch/minor bumps.

ADR-0013 condition 3 (auto-review converged on HEAD) is satisfied as in
ADR-0016: the automation's own audit on the PR's latest commit is the converged
review.

## Rationale

The per-session-permission rule in ADR-0013 exists to stop an AI assistant from
merging on stale or assumed authority. The risk it guards against is a merge
decision made without a human having recently decided to allow it. This ADR
does not erode that guard for the general case — it carves out one narrow,
low-risk, fully-auditable class and replaces "a human invoked the skill this
session" with "the maintainer deliberately configured a recurring job to merge
exactly this class, under a gate that is at least as strict as the manual one."

The structural protection that actually keeps red checks off `main` —
ADR-0013 condition 2, full-rollup-green — is retained verbatim. The advisory
check, diff-sanity check, and verdict comment trail are all retained. The only
thing removed is the human keystroke at merge time, for the class where that
keystroke was rubber-stamping a mechanisable verdict.

Excluding majors keeps the one case where human judgement still pays for itself
(release-note reading for behavioural deltas) on the human path.

## Consequences

**Positive**

- Routine patch/minor bumps merge without waiting for a hand-driven session.
- The upgrade backlog stays small; security patches delivered as patch/minor
  bumps land promptly.
- Every unattended merge leaves a verdict comment, so the audit trail is
  richer than a silent native auto-merge would be.

**Negative / risks**

- A malicious or buggy patch/minor release that ships clean release notes, has
  no advisory filed yet, and passes the full check matrix could merge
  unattended. Mitigations: the diff-sanity gate rejects anything beyond the
  manifest/lockfile or single `uses:` line; the advisory check re-runs each
  scheduled pass (a later-filed advisory blocks a not-yet-merged PR); and the
  verdict comment makes the decision auditable after the fact.
- The audit verdict is only as good as the automation producing it. A wrong
  `SAFE` on a patch/minor merges without a human. This is the residual risk the
  maintainer accepts for this class; majors and any non-`SAFE` verdict remain
  on the human path.

## Alternatives considered

- **Status quo (human invokes `/dependabot-review`).** Rejected: it does not
  scale to unattended operation, which is the entire point of this change. The
  manual path remains available and is unchanged.
- **GitHub-native Dependabot auto-merge.** Rejected: it merges on check status
  alone, with no changelog/advisory audit and no verdict trail. This ADR's gate
  is strictly stronger.
- **Unattended auto-merge for all bumps including majors.** Rejected: majors
  carry the behavioural-change risk ADR-0016 deliberately routed through a
  human, and a green test suite does not rule that risk out.
- **Restrict to patch only.** Considered. Minor bumps under semver are additive
  and, combined with the full-rollup-green + advisory + changelog gate, carry
  acceptable risk; including them captures most of the backlog-reduction
  benefit. The maintainer may tighten to patch-only later if minor bumps prove
  troublesome — that would be a follow-up ADR.

## References

- [ADR-0013](0013-conditional-bot-driven-merge.md) — the four-clause
  bot-merge gate this ADR adapts clause 1 of, for Dependabot patch/minor only.
- [ADR-0015](0015-disable-github-merge-queue.md) — why condition 4 is a direct
  squash, not a merge-queue enqueue.
- [ADR-0016](0016-dependabot-review-skill.md) — the `/dependabot-review` skill
  and the major-bumps-are-not-suppressed decision this ADR keeps intact.
- `.claude/rules/pr-workflow.md` — operational rule updated alongside this ADR.
- `.claude/rules/branch-strategy.md` — Dependabot branch exception, updated to
  reference this ADR.
- **Watch signal**: if an unattended patch/minor merge ever lands a regression,
  revisit conditions 2–3 (tighten to patch-only, or add a soak window).
