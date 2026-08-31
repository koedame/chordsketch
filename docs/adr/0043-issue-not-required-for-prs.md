# 0043. A GitHub Issue is not a prerequisite for a change

- **Status**: Accepted
- **Date**: 2026-08-30

## Context

Four documents stated the same mandate in four different voices:

| File | Wording |
|---|---|
| `CONTRIBUTING.md` §"Submitting Pull Requests" | "**Open an issue first.** Every change needs a corresponding GitHub issue." |
| `CLAUDE.md` §"Ticket-Driven Development" | "No code changes without a corresponding GitHub Issue." |
| `.claude/rules/issue-workflow.md` §"Issue Requirements" | "Every piece of work starts with a GitHub Issue." |
| `.claude/rules/branch-strategy.md` | "**All work requires a GitHub Issue first** — no branch without an issue." |

The rule was written when an issue was the only place a change could be
described before it existed. In practice it now produces two costs and buys
little:

1. **Placeholder issues.** For a self-contained change — a lint fix, a doc
   correction, a version bump follow-up — the issue is filed and closed by the
   same author inside the same PR round, and its body says what the PR body
   already says. It records nothing that outlives the PR, but it does add a
   number that every later reader has to dereference to discover there was
   nothing there.
2. **A barrier at the front door.** An outside contributor who already has a
   two-line fix must first open an issue, wait for it to be acknowledged, and
   only then send the change. The repository is public and accepts drive-by
   contributions; the mandate taxes exactly the contributions that are cheapest
   to review.

Nothing else in the workflow actually depends on the mandate. CI does not check
branch names or `Closes` lines. Branch protection gates on status checks, not on
issue linkage. The `autopilot-issue` workflow consumes issues that already
exist; it never required that *every* change have one.

## Decision

**A GitHub Issue is optional.** A change may go straight to a pull request.

What stays unchanged:

- Issues remain the place for user bug reports and feature requests, for
  planning and discussion of work not yet written, and for `type:tracking`
  umbrellas. The issue templates, labels, duplicate-prevention rule, and project
  board are untouched.
- When a change *does* have an issue, the existing conventions still apply: the
  branch is named `issue-{N}-{slug}`, the PR body carries `Closes #N`, and the
  1:1 issue-to-branch mapping holds.
- The `autopilot-issue` workflow is unaffected — it operates on filed issues and
  keeps its batched-branch shape (ADR-0019).

What changes:

- Branches with no issue use `{type}/{short-kebab-case}` instead of
  `issue-{N}-{slug}`.
- A PR body without a `Closes #N` line is no longer a defect.

## Rationale

The mandate's structural benefit — giving every change a thread for discussion
before code is written — is already served by the PR body for self-contained
changes. A PR body carries the change, its rationale, and its review thread in
one place; a linked placeholder issue adds a layer of indirection whose only
content is a copy of that same PR body. Meanwhile, nothing in CI or branch
protection enforces the mandate: there is no branch-name check and no `Closes`
check. A convention that costs contributor friction without producing a
structural guarantee is the right candidate for relaxation.

Making issues optional does not weaken the value they produce for their genuine
use cases. A bug report, a feature proposal, or a planning discussion needs a
thread that can exist before any code is written, and the PR does not serve
that role. Issueless branches are specifically those where the change is already
clear — a lint fix, a doc correction, a version-bump follow-up — and the PR is
the appropriate single record.

## Consequences

- Small self-contained changes reach review in one step instead of two.
- Issue numbers become a weaker index of project history: some merged work is
  reachable only through the PR list. This is accepted — the PR is the artefact
  that actually contains the change, its body, its review, and its commits, and
  a placeholder issue was never a real second record of it.
- Reviewers can no longer assume "there is an issue explaining why". The PR body
  must therefore carry its own `## Why` — already a section in
  `.github/PULL_REQUEST_TEMPLATE.md`, and now load-bearing rather than a place
  to paste an issue link.
- Rules that assume issue-shaped work stay valid but become conditional; each of
  the four files above now says "when the change has an issue".

## Alternatives considered

1. **Keep the mandate as written.** Rejected: it produces placeholder issues for
   self-contained changes and a friction barrier for drive-by contributors —
   both costs documented in §Context — with no structural enforcement to justify
   those costs. A rule that has no CI backing and requires ceremony-for-ceremony's-sake
   is a credibility liability.
2. **Require issues only for code changes, not documentation.** Rejected: the
   "code vs. documentation" boundary is hard to articulate consistently (this PR
   itself touches `.claude/rules/` files — tooling? documentation? process?),
   and the underlying costs apply equally to a small code fix as to a small doc
   fix. A blanket "self-contained change can go straight to a PR" is cleaner and
   easier to follow.
3. **Keep the mandate but enforce it structurally (branch-name CI check, required
   `Closes` check in branch protection).** Rejected: structural enforcement would
   make the barrier harder to cross, which is the wrong direction. The goal is
   to lower friction for small improvements, not to create a more rigidly
   enforced version of the existing rule.

## References

- ADR-0013 — conditional bot-driven merge; the four-clause gate checks CI and
  review convergence, not issue linkage; unchanged by this decision.
- ADR-0019 — batch autopilot issue; the `autopilot-issue` workflow operates
  on already-filed issues and is unaffected.
- `.claude/rules/branch-strategy.md` — updated first bullet and branch-naming
  convention; now describes both `issue-{N}-{slug}` and `{type}/{short-kebab-case}` forms.
- `.claude/rules/issue-workflow.md` — updated § "Issue Requirements" first
  bullet; the rest of the file becomes conditional ("when an issue exists").
- `CLAUDE.md` § "Issue-Linked Development" — renamed from § "Ticket-Driven
  Development" and updated.
- `CONTRIBUTING.md` § "Submitting Pull Requests" — updated steps 1, 2, and 5.
