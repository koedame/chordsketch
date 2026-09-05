# 0058. The name is protected separately from the code

- **Status**: Accepted
- **Date**: 2026-09-05

## Context

The code is deliberately easy to take: the SDK crates are MIT, the
application layer is AGPL-3.0-only, and pre-1.0 the project actively wants
other people building on it ([ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md)).
Neither licence says anything useful about the name. MIT predates the
question; AGPL-3.0 §7(e) explicitly declines to grant trademark rights but
does not reserve them either, so "what may I call my fork?" currently has no
answer anywhere in the repository.

That gap has a cost in both directions. A downstream author who wants to
publish `chordsketch-something` has nothing to read and either guesses or
does not ask. And the project has no stated position to point at if a
modified build starts shipping under this name — which is the one thing that
makes "is this ChordSketch?" unanswerable for a user at the download page.

The projects that solved this — React (MIT plus a separately held mark),
WordPress (GPL plus a foundation-held mark), Rust — all did it the same way:
keep the code licence permissive, hold the name separately, and publish a
policy so the boundary is legible without a lawyer. The failure mode they
avoided is the one Redis and Elasticsearch hit, where the only lever left
against a downstream taking the project's position was to change the code
licence, which split the community instead.

The mark is not registered in any jurisdiction today.

## Decision

Publish [`TRADEMARK.md`](../../TRADEMARK.md) as the project's trademark
policy, covering the word `ChordSketch` and the logo, and reference it from
`README.md` and `CONTRIBUTING.md`.

The policy's line is: **nominative use is free, source-identifying use is
not.** Describing, discussing, teaching, and repackaging unmodified releases
never needs permission. Naming a product, publishing under a name that reads
as official, or shipping a modified build under this name does.

The marks are asserted as unregistered (™). Registration is a separate,
later decision — the policy states the current status rather than assuming a
registration that does not exist.

## Rationale

- A fork is welcome; a fork *called ChordSketch* destroys the only thing that
  makes the name useful to a user deciding what to install. The policy has to
  separate those two cases, and a copyright licence structurally cannot.
- Nominative use has to be explicitly free, or the policy chills exactly the
  ecosystem the MIT licence exists to invite. Every allowed case in the
  policy is spelled out with examples so a downstream author can act on it
  without asking.
- Common-law rights accrue from use, not from filing, so a published policy
  has effect now and does not depend on a registration decision that has cost
  and jurisdiction questions attached to it.
- Writing this before there is a dispute means the position was set on the
  merits rather than aimed at a specific downstream.

## Consequences

- Forks must rename. The policy says so directly and gives the four steps, so
  the requirement is discoverable before someone has invested in a name.
- The `@chordsketch/*` npm scope and the `chordsketch*` crate names are
  stated to be the project's. Ecosystem packages need their own scope, which
  is the convention on both registries anyway.
- Permission requests arrive as GitHub issues and have to be answered in
  writing. At the current rate that is a small cost; if it stops being one,
  the answer is a pre-approved list in the policy, not silence.
- The policy asserts marks that are unregistered, so enforcement outside
  ordinary common-law passing-off is limited. The policy states the ™ status
  plainly rather than implying more, and gets updated if registration lands.
- Third-party marks named in the repository (ChordPro, iReal Pro) are
  acknowledged as their owners', which the project should have said
  somewhere regardless.

## Alternatives considered

- **Say nothing and rely on the licences.** Rejected: this is the status quo,
  and it answers neither the downstream author's question nor the project's.
  Silence also weakens a common-law claim, since the mark's owner is expected
  to police it.
- **Restrict the code licence instead.** Rejected: it gives up the thing the
  project is actually trying to do, and it is the move that split the Redis
  and Elasticsearch communities. The mark is the narrower instrument and the
  one that fits the actual concern.
- **Wait for a registration and publish the policy with it.** Rejected: the
  policy is what downstream authors need, and it works on common-law rights
  today. Coupling it to a filing decision leaves the question unanswered for
  as long as that decision takes.
- **Ban all use of the name without written permission.** Rejected: it would
  make "renders ChordSketch files" a violation, which is both unenforceable
  and the opposite of the intent. Nominative use is protected in the US and
  Japan regardless of what a policy says, so claiming otherwise would only
  make the rest of the document less credible.
- **Pick a more distinctive name instead of defending this one.** Rejected as
  a non-starter at this point: the crates, npm scope, published binaries, and
  editor integrations all carry it.

## References

- [`TRADEMARK.md`](../../TRADEMARK.md) — the policy this ADR adopts
- [ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md) — the pre-1.0
  posture that makes downstream reuse likely
- `AGPL-3.0-only` §7(e) — the clause that declines to grant trademark rights
- Watch signal: a registration in any jurisdiction, a permission request the
  policy does not cleanly answer, or a modified build shipping under the name
