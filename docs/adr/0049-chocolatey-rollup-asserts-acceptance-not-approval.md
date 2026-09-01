# 0049. The Chocolatey channel check asserts acceptance, not approval

- **Status**: Accepted
- **Date**: 2026-09-01

## Context

`ci/release-channels.toml` carried `chocolatey` as `kind = "manual"`, and
`_check_manual` in `scripts/check-release-channels.py` returns `ok=True`
unconditionally. The post-release rollup
(`.github/workflows/release-verify.yml`) therefore asserted nothing at all
about this channel.

That gap became the only gap. The release fan-out's `update-chocolatey`
job hands a 403 from `choco push` to the shared publish action
(`.github/actions/chocolatey-pack-push/action.yml`) with
`on-forbidden: warn`, so a refused push annotates the job and the release
stays green — the right call for one channel of eight, and it leaves the
job annotation as the only place a missed publish is visible. The rollup,
which exists to answer "has every channel converged on the release?",
stayed green too.

Promoting the channel to a real checker requires deciding what a red
means, and Chocolatey has a state no other channel in the manifest has:
a version can be *on the repository* while still queued for community
moderation. The two versions the repository holds waited 28 days (0.2.1,
`Created` 2026-04-16 → `PackageApprovedDate` 2026-05-14) and 54 days
(0.5.0, 2026-05-20 → 2026-07-13) according to their own feed entries. A
rollup that treats "not approved yet" as a failure is red for a month or
two per release while the publish step has done everything it can do.

## Decision

`_check_chocolatey` passes when the community repository **holds** the
released version, whatever its moderation state, and fails only when the
repository does not have it. The moderation state is reported in the
result's detail line rather than in its verdict.

The probe is the v2 OData entity endpoint,
`Packages(Id='<package>',Version='<version>')`.

## Rationale

The entity endpoint separates the two states the verdict depends on:

| Probe | Answer |
|---|---|
| `Packages(Id='chordsketch',Version='0.5.0')` | 200, `PackageStatus` `Approved` |
| `Packages(Id='slack',Version='4.52.155')` | 200, `PackageStatus` `Submitted` |
| `Packages(Id='chordsketch',Version='0.4.0')` | 404 |

(Measured 2026-09-01. `slack` 4.52.155 was queued for moderation at that
time; chordsketch 0.4.0 and 0.2.2 were never accepted, and 0.2.1 answers
200 like 0.5.0.)

A pending moderation therefore never has to be conflated with a failed
push: the feed distinguishes them, and the channel needs no third
`warning` / `pending` verdict beyond the existing pass/fail.

Approval is also not ours to hold a red open for. It is an asynchronous
act by a Chocolatey moderator, unblocked by nothing the repository can do,
whereas a 404 is actionable: re-run `chocolatey-retry.yml` once the queue
that produced the 403 drains. Failing on the state we cannot act on would
train the same "red means nothing" reflex
[ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md) moved this
rollup off the release event to break.

`FindPackagesById()?id='<package>'` is the wrong probe for the same
reason it looks like the right one: it omits submitted versions. It
returned 40 entries for `slack` on 2026-09-01 without the queued
4.52.155, so a checker built on it would call a successfully pushed
release missing for the entire moderation window.

## Consequences

- A release whose Chocolatey push was refused turns the daily rollup red
  and stays red until the version lands. That is the intended detection,
  and it is a state that can last as long as the moderation queue that
  caused the 403 — the red is correct throughout, because the channel
  genuinely does not have the release. The failure detail names the
  `chocolatey-retry.yml` dispatch that resolves it so the red is
  actionable rather than merely persistent.
- A version sitting in moderation shows as `✅ OK` in the release body's
  channel table. Someone reading only the table cannot tell it apart from
  an approved version; the distinction is in the job log's `detail:` line.
  Accepted: the table answers "did the release reach this channel", and
  `observed` stays the version string every other channel puts there.
- An unreadable feed (any non-404 HTTP failure) reports `<error>`, not
  `<absent>`, so a transport problem cannot be read as a missing publish.

## Alternatives considered

**Leave `kind = "manual"`.** Rejected: it is what produced the gap. The
403-to-warning disposition is deliberate, and it moves the whole burden of
noticing a missed publish onto a job annotation nobody reads after a green
release.

**Fail on anything short of `Approved`.** Rejected: red for 28-54 days
per release with no action available to clear it.

**Add a third `warning` / `pending` verdict.** Rejected as unnecessary
work: it exists to express a state the feed already lets us classify as a
pass, and it would need a matching column in the rollup table, the
release-body writer, and the summary job's aggregation.
