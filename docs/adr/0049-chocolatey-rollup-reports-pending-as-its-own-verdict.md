# 0048. The Chocolatey channel reports pending as its own verdict

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
means, and Chocolatey has a state no other channel in the manifest has.
Every other registry publishes synchronously: the moment `cargo publish`
or `npm publish` returns, the version is installable. Chocolatey's
community repository accepts an upload and then queues it for human
moderation. The two versions this repository holds waited 28 days (0.2.1,
`Created` 2026-04-16 → `PackageApprovedDate` 2026-05-14) and 54 days
(0.5.0, 2026-05-20 → 2026-07-13) according to their own feed entries.

So the channel has three states where the rollup's verdict had two.

## Decision

`_check_chocolatey` reports **three** verdicts, and the rollup renders
three:

| Verdict | Meaning | Job |
|---|---|---|
| `OK` | a user can install this version now | green |
| `PENDING` | the repository accepted it; moderation has not cleared it | green |
| `FAIL` | the repository does not have it — the push did not land | red |

`CheckResult` grows a `pending` flag and a `status` property; the summary
job in `release-verify.yml` renders `⏳ PENDING` and excludes it from
`any_fail`. No other channel sets `pending`, so their verdicts stay the
binary they have always been.

All three verdicts come from one probe: the v2 OData **entity** endpoint,
`Packages(Id='<package>',Version='<version>')`. A 404 is `FAIL`; a 200
whose `Published` is the NuGet unlisted sentinel (`1900-01-01T00:00:00`)
is `PENDING`; a 200 with a real `Published` date is `OK`.

## Rationale

**Green must mean installable.** The rollup's `✅` is read as "the release
reached this channel". During moderation it has not: the install feed
omits the queued version, so `choco install chordsketch` serves the
previous release. Measured 2026-09-01 — `slack` 4.52.155 was queued
(`PackageStatus` `Submitted`), and `FindPackagesById()?id='slack'`
returned 4.51.191 as its newest entry with no 4.52.155 anywhere in the
response. Reporting that as `OK` states something the reader can check and
find false.

**Red must be actionable.** Approval is an asynchronous act by a
Chocolatey moderator that nothing in this repository can unblock. Holding
a red open for 28-54 days per release trains the same "red means nothing"
reflex [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md)
moved this rollup off the release event to break. A 404 *is* actionable —
re-run `chocolatey-retry.yml` once the queue that produced the 403
drains — so that stays red.

Neither existing verdict can carry the middle state without lying about
one of those two properties. The third verdict is what the state costs.

**`Published` is the probe because it is the field that tracks what a
user can install.** Measured 2026-09-01:

| Version | `PackageStatus` | `IsApproved` | `Published` | In install feed |
|---|---|---|---|---|
| `slack` 4.51.191 | `Approved` | `true` | real date | yes |
| `slack` 1.0.0 | `Approved` | `true` | real date | yes |
| `slack` 4.51.185 | `Exempted` | **`false`** | real date | **yes** |
| `slack` 4.52.155 | `Submitted` | `false` | `1900-01-01T00:00:00` | no |
| `chordsketch` 0.5.0 | `Approved` | `true` | real date | yes |
| `chordsketch` 0.2.1 | `Approved` | `true` | real date | yes |

`Published` agrees with install-feed membership on every row; the two
obvious alternatives do not:

- **`IsApproved` misreports `Exempted`.** Those versions skip moderation
  review and are fully installable, yet report `false`. A checker keyed to
  that flag would report a live release as stuck in moderation
  indefinitely.
- **`PackageStatus` is an open enum** with at least four values seen
  (`Approved`, `Exempted`, `Submitted`, plus whatever comes next), so
  matching `== "Approved"` carries the same defect with no way to know
  when Chocolatey adds a fifth.

The `1900-01-01` instant is not a Chocolatey quirk: it is how NuGet v2
servers represent an unlisted package, which is exactly the state a
version awaiting moderation is in.

`PackageStatus` is still read, and reported in the detail line, because a
human triaging a `PENDING` row wants to know which queue it is in. It is
never the verdict. A feed that stops emitting `Published` reports
`<error>` rather than being resolved in either direction.

**`FindPackagesById()` — the feed `choco install` actually reads — is
rejected, despite being the most direct statement of the property.** It
applies `$filter` *after* paging. `FindPackagesById()?id='slack'&$filter=
Version eq '1.0.0'` returns an empty first page, an empty second page, and
the (listed, approved) version only on the third — while
`$filter=Version eq '4.51.191'` returns it immediately, because that
version is near the top of the underlying scan. A checker built on it
works only while a package has fewer versions than the 40-item page size,
then silently starts reporting published releases as missing. chordsketch
has two versions today, so the defect would not have surfaced for years.
Paging until the version is found or the links run out would be correct
but costs a request per 40 versions; the entity endpoint addresses one
version directly, cannot paginate, and answers all three verdicts in a
single request.

## Consequences

- A release whose Chocolatey push was refused turns the daily rollup red
  and stays red until the version lands. That is the intended detection.
  The failure detail names the `chocolatey-retry.yml` dispatch that
  resolves it, so the red is actionable rather than merely persistent.
- A version in moderation shows `⏳ PENDING` in the release body's channel
  table and leaves the job green. The release body therefore states, for
  the whole 28-54 day window, that Windows users cannot yet install the
  release — which is true, and was previously invisible.
- Every verdict costs exactly one HTTP request.
- `CheckResult.ok` now means "the rollup may stay green for this channel",
  not "the release has arrived". The two came apart the moment a third
  verdict existed; the docstring says so, and `status` is what the CLI and
  the summary job read.
- An unreadable feed (any non-404 HTTP failure), or one that omits
  `Published`, reports `<error>` and fails — so a transport problem or a
  feed-shape change is never read as a missing publish, and never silently
  absorbed into `PENDING`.

## Alternatives considered

**Leave `kind = "manual"`.** Rejected: it is what produced the gap. The
403-to-warning disposition is deliberate, and it moves the whole burden of
noticing a missed publish onto a job annotation nobody reads after a green
release.

**Fail on anything short of installable.** Rejected: red for 28-54 days
per release with no action available to clear it.

**Pass on anything the repository holds, reporting moderation only in the
detail line.** This was the first shape of this decision, and it is
rejected. It is cheaper — no third verdict, no table column, no
aggregation change — but the saving is the entire point of the check. A
`✅ OK` row carrying the released version string is indistinguishable from
a converged channel, so the one reader who would act on the information
(someone asking "can Windows users install this yet?") is told yes when
the answer is no. Cost was the only argument for it, and the cost turned
out to be an enum, an icon, and one `case` arm.

**Bound `PENDING` with a maximum age, failing past it.** Rejected for now:
the two observed waits (28 and 54 days) give no basis for a threshold, and
a wrong one produces exactly the unactionable red this decision avoids.
The state to watch for is a version that needs maintainer action to clear
moderation; `PackageStatus` in the detail line is where that would first
be visible.

## References

- #1852 — the 403 that a queued version produces on every newer push
- [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md) — why this
  rollup runs on a schedule rather than on the release event
- `.github/actions/chocolatey-pack-push/action.yml` — the publish action
  whose `on-forbidden: warn` disposition this rollup backstops
