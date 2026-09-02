# 0047. Merge authorization may be granted before the work begins

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

[ADR-0013](0013-conditional-bot-driven-merge.md) allows an AI assistant to
run `gh pr merge --squash` when four conditions hold. Condition (1) is
**explicit, current-session permission**: "the user has stated in the active
session that the assistant may merge", and standing grants from earlier
sessions do not count.

That wording assumes the shape of an attended session — a maintainer and an
assistant working the repository together, where "the active session" is a
conversation the maintainer can speak into at any moment. Work also arrives
in a second shape: a self-contained unit of work, handed over with its
instructions and its scope already written down, and executed in a single
unattended run. In that shape the maintainer's decision about merging is
made when they frame the work, before the run starts. The run itself has no
channel to ask, and there is no later session in which to ask — so under a
literal reading of condition (1) every PR the run opens stops at "Ready for
merge" and waits for a hand-back whose only content is the maintainer
repeating a decision they already made. Permission round trips of this kind
are a recurring share of the hand-backs such runs produce, and they carry no
information the maintainer did not already supply when they framed the work.

[ADR-0024](0024-scheduled-dependabot-merge.md) already made this move for
one case. For Dependabot PRs, "the scheduled automation's configured run
**is** the maintainer's standing authorization — it replaces ADR-0013 clause
1's per-session human invocation." Its argument for doing so — that the
human keystroke "adds no signal beyond launching that audit; it is pure
latency" — is not specific to Dependabot, or to a scheduled trigger. What
keeps an unsafe merge off `main` is conditions (2)–(4), not the moment at
which condition (1)'s grant was spoken.

## Decision

Condition (1) of ADR-0013 becomes **authorization to merge**, satisfied by
any one of three forms:

1. **Authorization granted with the work unit.** The maintainer granted merge
   authority when handing over a self-contained unit of work — including the
   configured run of a maintainer-operated automation. The grant covers the
   PRs the assistant opens as part of that work unit.
2. **A named PR.** The work unit names the PR to be merged.
3. **Explicit permission in the active session.** The maintainer states in
   the session that the assistant may merge.

Authorization is still never inferred and never carried over: a grant from an
earlier session, from a different work unit, or from a standing memory entry
does not authorize a merge, and permission to merge one PR says nothing about
any other PR. When no form applies, the assistant posts "Ready for merge" and
leaves the merge to the maintainer.

Conditions (2) full check rollup green, (3) auto-review converged on HEAD,
and (4) direct squash are unchanged, and every one of them applies to every
merge — including a PR the assistant opened itself under form 1.

ADR-0024's Dependabot gate is unaffected: it is now an instance of form 1
rather than an exception to condition (1), and its five-condition audit gate
continues to decide *which* Dependabot PRs merge.

## Rationale

Condition (1) protects against merging on **stale or assumed** authority — a
merge nobody decided to allow, or one authorized so long ago that the
maintainer no longer holds the context. Authorization given with a unit of
work is neither. It is current, because it was given for this work; it is
explicit, because the maintainer wrote it; and it is bounded, because it
expires with the work unit that carries it. The per-session framing was a
proxy for those properties, chosen when the only shape of work was an
attended conversation. Generalizing to "authorization, in a form the
maintainer actually gave" keeps the properties and drops the proxy.

The prohibitions that do the work are retained verbatim. Inference remains
banned, so nothing generalizes from one authorized merge to the next one.
Carry-over remains banned, so authority cannot outlive the unit it was given
for. What is removed is only the requirement that the grant be spoken inside
the same session as the merge.

Widening condition (1) also does not touch the guards that have actually
caught bad merges. Condition (2) is what closes the non-required-check drift
class that produced the incident behind ADR-0013, and condition (3) is what
stops a merge while a review is still in flight. Both apply unchanged to
self-opened PRs, which is the case form 1 newly authorizes.

Doing this generally, rather than by another Dependabot-shaped carve-out, is
the cheaper structure. Each new kind of unattended work would otherwise need
its own ADR restating the same argument, and the accumulated carve-outs would
drift apart from each other and from condition (1)'s text.

## Consequences

**Accepted**

- An assistant working a unit of work that carries merge authority may merge
  the PRs it opened for that work without a further hand-back. The blast
  radius is bounded by conditions (2)–(4), which are unchanged.
- A reader of the rule now checks *which* form of authorization applies
  instead of a single yes/no per session. The three forms are enumerated in
  `.claude/rules/pr-workflow.md` so the check stays mechanical.

**Gained**

- The round trip whose only content was re-stating an existing decision
  disappears from every authorized work unit, not just Dependabot runs.
- ADR-0024 stops being a special case grafted onto condition (1) and becomes
  an instance of it.

**Negative / risks**

- A work unit whose authorization is written more broadly than the maintainer
  intended authorizes more merges than intended. Mitigation: authorization is
  scoped to that work unit and expires with it, conditions (2)–(4) gate every
  individual merge, and each merge leaves a PR record to audit.
- Form 1 is the only form under which an assistant merges a PR it opened
  itself. Mitigation: condition (3) — auto-review converged on the PR's HEAD
  — is exactly the guard for that case and is unchanged.

## Alternatives considered

1. **Keep condition (1) as written.** Rejected. In unattended work the
   condition cannot be satisfied at all, so every PR ends in a hand-back that
   asks the maintainer to repeat a decision already made. That is the friction
   ADR-0013 itself set out to remove for attended sessions.
2. **Add another per-automation carve-out, as ADR-0024 did for Dependabot.**
   Rejected. The same argument recurs for every new kind of unattended work
   unit; one generalization is cheaper to maintain than a growing set of
   carve-outs, which would drift apart over time.
3. **Grant standing repo-level merge authority via a settings flag.**
   Rejected for the reason ADR-0013 rejected standing grants: authority would
   outlive the context in which it was given. Authorization tied to a work
   unit expires with that unit; a repo-level flag does not.
4. **Widen condition (1) and relax condition (3) for self-opened PRs.**
   Rejected. Condition (3) is the guard that catches merges made while a
   review is still in flight, which is precisely the risk of self-opened PRs.

## References

- [ADR-0013](0013-conditional-bot-driven-merge.md) — the four-condition
  bot-merge gate whose condition (1) this ADR generalizes.
- [ADR-0024](0024-scheduled-dependabot-merge.md) — the precedent: condition
  (1) replaced by a maintainer's standing authorization for Dependabot PRs.
- [ADR-0015](0015-disable-github-merge-queue.md) — why condition (4) is a
  direct squash.
- `.claude/rules/pr-workflow.md` — the operational rule updated alongside
  this ADR.
- `CLAUDE.md` — the workflow summary updated alongside this ADR.
- **Watch signal**: if a merge made under form 1 ever lands a regression,
  revisit the scope of the grant — e.g. exclude PRs the assistant opened
  itself, or require every merged PR to be named.
