# 0024. Scheduled unattended Dependabot review-and-merge

- **Status**: Accepted
- **Date**: 2026-05-25

## Context

[ADR-0013](0013-conditional-bot-driven-merge.md) permits a bot-initiated
`gh pr merge --squash` only when four conditions hold, the first of which is
**explicit, current-session human permission** — and it states plainly that
"standing memory entries from earlier sessions do NOT count — the grant is
per-session and explicit."

[ADR-0016](0016-dependabot-review-skill.md) builds on that: it deletes the
old CI auto-approval bot, un-suppresses major bumps so every update opens a
PR, and introduces the `/dependabot-review` skill. The skill audits each open
Dependabot PR (CHANGELOG / release notes, advisory database, diff sanity),
**applies any required code-side adaptation as commits on the Dependabot
branch**, and squash-merges the ones it can clear — for every bump type,
patch through major. Its condition-1 mapping is explicit: "the maintainer's
invocation of `/dependabot-review` IS the per-session grant." The whole model
assumes a human is present at merge time, invoking the skill by hand.

That assumption is the bottleneck this ADR addresses. Dependabot opens a steady
stream of bumps (one PR per dependency per update type, weekly). The skill's
audit is the substantive work: it reads the release notes, checks advisories,
inspects the diff, and — for a bump that needs source changes to compile or
keep behaviour — writes those changes and lets the full check matrix validate
them. The human's `/dependabot-review` keystroke adds no signal beyond
launching that audit; it is pure latency.

Majors are not a special case here. ADR-0016 surfaced them as PRs precisely so
the skill's release-note reading + code-side adaptation could handle them
rather than having Dependabot silently suppress them. The release-note reading
that ADR-0016 wanted for majors is performed *by the audit*, attended or not —
it is not something the human keystroke contributes.

## Decision

A **scheduled, maintainer-operated automation** MAY run the
`/dependabot-review`-equivalent flow — audit, apply required code-side
adaptation, and squash-merge — **without a per-session human invocation**, for
Dependabot PRs of any bump type (patch, minor, or major), when **all** of the
following hold for a given PR:

1. **Author is `dependabot[bot]`.** No other author qualifies for unattended
   merge under this ADR.
2. **The audit clears the PR** with a `SAFE` verdict (no change needed) or a
   `FIXED` verdict (the automation applied the required code-side adaptation as
   commits on the Dependabot branch, and that adaptation is what makes the PR
   correct). The audit covers diff sanity, GitHub Advisory Database exposure,
   and release notes across every version between old and new.
3. **Full check rollup is green** on the final commit — every check, required
   AND non-required, in `pass` or `skipping` (ADR-0013 condition 2, unchanged).
   For a `FIXED` PR this is the rollup *after* the adaptation commits.
4. **The merge is a direct squash** (`gh pr merge <N> --squash`; ADR-0013
   condition 4, unchanged).
5. **The audit posts its verdict as a PR comment before merging**, so the
   rationale is on the record. A PR the audit cannot clear (`BLOCKED` /
   `NEEDS_REVIEW` — e.g. an advisory hit, an unexpected diff, or a behavioural
   change the automation cannot safely adapt to) is commented and left open for
   a human; it is never merged unattended.

For Dependabot PRs, the scheduled automation's configured run **is** the
maintainer's standing authorization — it replaces ADR-0013 clause 1's
per-session human invocation. ADR-0013 clause 1 continues to govern every
**non-Dependabot** bot-initiated merge unchanged: those still require explicit,
current-session permission. This ADR widens bot-merge authority only to
unattended operation on Dependabot PRs; the gate that decides *which* PRs merge
is the audit verdict + full rollup, exactly as in the attended skill.

ADR-0013 condition 3 (auto-review converged on HEAD) is satisfied as in
ADR-0016: the automation's own audit on the PR's final commit is the converged
review.

## Rationale

The per-session-permission rule in ADR-0013 exists to stop an AI assistant from
merging on stale or assumed authority — a merge decision made without a human
having recently decided to allow it. This ADR does not erode that guard for the
general case; it records the maintainer's deliberate, standing decision that a
recurring job may run the *same* audit-and-merge the attended skill already
runs, under the *same* gate.

The gate that decides what merges is unchanged from the attended skill: a
`SAFE`/`FIXED` audit verdict plus a green full rollup. The semver level of the
bump is not part of that gate, because it never was in the attended skill — the
skill handles majors by reading their release notes and adapting the code, and
the full check matrix validates the result. Carving majors out of the
unattended path would not match the attended behaviour the maintainer is
choosing to schedule; it would just reintroduce a human keystroke that adds no
signal the audit does not already produce.

The structural protection that actually keeps red checks off `main` —
ADR-0013 condition 2, full-rollup-green — is retained verbatim. The advisory
check, diff-sanity check, release-note reading, and verdict-comment trail are
all retained. The only thing removed is the human keystroke at launch time.

## Consequences

**Positive**

- Dependabot bumps the audit can clear merge without waiting for a hand-driven
  session, including majors that need a code-side adaptation.
- The upgrade backlog stays small; security patches land promptly regardless of
  whether they ship as a patch or a major.
- Every unattended merge leaves a verdict comment, so the audit trail is richer
  than a silent native auto-merge would be.

**Negative / risks**

- The audit verdict is only as good as the automation producing it. A wrong
  `SAFE`/`FIXED` merges without a human. This is the residual risk the
  maintainer accepts in exchange for unattended operation. It is bounded by the
  same controls as the attended skill: a malicious or buggy release that ships
  clean release notes and no filed advisory and passes the full matrix is the
  worst case, and the diff-sanity gate (only manifest/lockfile or a single
  `uses:` line for the dependency itself), the per-run advisory re-check (a
  later-filed advisory blocks a not-yet-merged PR), and the verdict comment are
  the mitigations.
- Majors that need code-side adaptation are the highest-judgement case. The
  automation merges them only on a `FIXED` verdict validated by a green full
  rollup; anything it is unsure about becomes `NEEDS_REVIEW` and waits for a
  human. The residual risk is that the automation is over-confident on a major
  adaptation; the full matrix is the backstop, and a regression that slips
  through is the watch signal below.

## Alternatives considered

- **Status quo (human invokes `/dependabot-review`).** Rejected: it does not
  scale to unattended operation, which is the entire point of this change. The
  manual path remains available and is unchanged.
- **GitHub-native Dependabot auto-merge.** Rejected: it merges on check status
  alone, with no changelog/advisory audit, no code-side adaptation, and no
  verdict trail. This ADR's gate is strictly stronger.
- **Restrict the unattended path to patch/minor, keep majors human.** Rejected:
  it does not match the attended skill (which handles majors), and the human
  keystroke it would preserve for majors adds no signal beyond the audit's own
  release-note reading. The real gate on a major is the same as on a patch — a
  cleared audit plus a green full rollup — so a semver carve-out would be an
  arbitrary restriction, not a safety control.

## References

- [ADR-0013](0013-conditional-bot-driven-merge.md) — the four-clause
  bot-merge gate this ADR adapts clause 1 of, for Dependabot PRs.
- [ADR-0015](0015-disable-github-merge-queue.md) — why condition 4 is a direct
  squash, not a merge-queue enqueue.
- [ADR-0016](0016-dependabot-review-skill.md) — the `/dependabot-review` skill
  whose audit-and-merge behaviour (all bump types) this ADR runs unattended.
- `.claude/rules/pr-workflow.md` — operational rule updated alongside this ADR.
- `.claude/rules/branch-strategy.md` — Dependabot branch exception, updated to
  reference this ADR.
- **Watch signal**: if an unattended merge ever lands a regression, revisit the
  gate — e.g. require a human verdict for majors, or add a soak window before
  the merge step.
