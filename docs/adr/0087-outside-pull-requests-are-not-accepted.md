# 0087. Outside pull requests are not accepted

- **Status**: Accepted
- **Date**: 2026-10-02

## Context

`CONTRIBUTING.md` invited pull requests and said "By contributing, you agree
that your contributions will be licensed under the MIT License". The
repository is under two licences split by directory (MIT, and AGPL-3.0-only
for `apps/desktop/` and two packages), no inbound agreement (DCO or CLA)
existed, and most of the code is written with an AI tool, so the rights in
anything taken from an outside author were undefined.

No outside pull request had been opened.

## Decision

ChordSketch does not accept outside contributions. The source is public to be
read, built, used and forked under its licences. Pull requests from anyone
other than the maintainers are not reviewed or merged.

- `CONTRIBUTING.md` says so first, and describes the maintainers' workflow and
  the build and style guide for forks.
- The pull request template carries the same notice.
- Issues stay open for bug reports and questions, with no promise of an answer.
- No DCO or CLA is introduced: with no outside contributions there is nothing
  to certify or assign.
- A fix from someone else is never taken over as a commit or credited as a
  co-author; an idea from an issue is reimplemented by a maintainer.

## Rationale

An inbound agreement (DCO or CLA) only resolves whose signature is needed
before accepting a change; it does not resolve what the rights in that change
*are* when the surrounding repository is split MIT / AGPL-3.0-only by
directory and much of the existing code was written with an AI tool. Refusing
outside pull requests sidesteps the question entirely rather than picking an
agreement to fit a case that has not actually occurred — no outside pull
request had been opened at the time of this decision. The cost is small: the
project is young enough that no contributor workflow or community expectation
has to be unwound.

## Consequences

- Every line in the repository has a maintainer as its author, so relicensing
  or dual licensing the AGPL parts later needs nobody's consent.
- [ADR-0043](0043-issue-not-required-for-prs.md) still holds for the
  maintainers (an issue is optional); its second reason, the barrier for
  outside contributors, no longer applies.
- If outside contributions are ever accepted, this ADR is superseded by one
  that chooses DCO or CLA first.

## Alternatives considered

- **DCO** (`Signed-off-by`, with a check on pull requests): keeps contributors'
  copyright, so the AGPL parts could not be relicensed without them.
- **CLA**: allows relicensing but needs a signing service and raises the bar
  for contributors, for contributions nobody wants to take.

## References

- PR #2979, which introduced this ADR alongside the `CONTRIBUTING.md` and
  `.github/PULL_REQUEST_TEMPLATE.md` wording changes.
- `CLAUDE.md` §License Policy — the MIT / AGPL-3.0-only split by directory
  referenced in Context.
- Watch signal: revisit if a maintainer wants to accept outside contributions
  — pick DCO or CLA first, per Consequences.
