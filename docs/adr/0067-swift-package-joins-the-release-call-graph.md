# 0067. The Swift Package workflow joins the release call graph, and the XCFramework consumers follow its publish

- **Status**: Accepted
- **Date**: 2026-09-14
- **Amends**: [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md)
- **Amended by**: [ADR-0080](0080-swift-package-manifest-at-the-root-pins-the-xcframework-before-the-tag.md), [ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md)

## Context

ADR-0039 rooted the library release at `release.yml` and called six
publishing workflows from it with `needs: [release]`. It left
`swift.yml` (with `python.yml`, `ruby.yml`, `kotlin.yml`) on its own
`push: tags: v*` trigger and recorded that as a known limitation, naming
one visible cost: `post-release.yml`'s `update-swift-package` polled the
release for up to 30 minutes for the XCFramework that `swift.yml`
uploads from a parallel run.

That cost was understated. Two jobs in `post-release.yml` consume the
XCFramework asset, and only one of them waited for it:

- `update-swift-package` downloads the zip to pin its SHA256 in
  `Package.swift`. It polled.
- `update-cocoapods` runs `pod trunk push`, which validates the podspec
  by downloading its `:http` source — the same zip. It did not wait.

Measured on `v0.6.0` (release run 34770974199):

| Event | Time (UTC, 2026-09-13) |
|---|---|
| `swift.yml` tag run created | 17:14:11 |
| `Update Swift Package.swift` starts polling | 17:50:06 |
| `Update CocoaPods podspec` fails: `curl: (56) The requested URL returned error: 404` on `releases/download/v0.6.0/chordsketch-xcframework.zip` | 17:51:34 |
| `Update Swift Package.swift` times out after 30 minutes | 18:20:36 |
| `swift.yml` tag run still `queued` | 18:3x |

The Swift build had not started an hour after the tag: Dependabot PR
runs rebuilt against the new `main` at the same moment and held the
account's five macOS slots. CocoaPods lost the race outright; the poll
lost it by running out of time.

The same race explains the CocoaPods history, although those logs have
expired and it cannot be confirmed: `update-cocoapods` was red on both
`v0.4.0` and `v0.5.0`, and trunk serves 0.2.0–0.3.0 and 0.5.0 but not
0.4.0.

The obvious fixes both make it worse. A longer poll, or the same poll
added to `update-cocoapods`, holds a runner while it waits —
`update-cocoapods` is a macOS job, so it would sit on one of the five
slots the Swift build it is waiting for needs. It also leaves the
failure mode in place, only with a later deadline.

## Decision

1. **`swift.yml` becomes a reusable workflow in `release.yml`'s
   fan-out.** It drops `tags: ["v*"]` from its `push` trigger, gains
   `workflow_call` with a required `tag` input, and `release.yml` calls
   it with `needs: [release]` and `permissions: contents: write`.
   `publish` is gated on `inputs.tag != ''`, following ADR-0039
   decision 3. PR and `main` push CI are unchanged.

2. **`update-cocoapods` and `update-swift-package` move from
   `post-release.yml` into `swift.yml`, each with `needs: [publish]`.**
   The `Wait for xcframework asset` poll is deleted; the edge replaces
   it.

3. **`post-release.yml` keeps the six channels that read only
   `release.yml`'s own assets** (Homebrew, Scoop, Chocolatey, Snap, AUR,
   Flathub).

4. **`python.yml`, `ruby.yml`, and `kotlin.yml` stay on `push: tags`.**
   They publish to their registries from their own builds and read
   nothing from the GitHub Release, so they have no ordering defect to
   fix. The limitation ADR-0039 recorded now applies to those three
   only.

## Rationale

The defect is a missing ordering edge between the job that produces the
asset and the jobs that consume it. `needs:` is how this project
expresses that edge (ADR-0039's "Ordering"), and ADR-0039 already
rejected a poll as "a band-aid over a missing ordering edge" when it
turned down a wait step for `release-verify`. The Swift poll was the
same band-aid, left behind.

An edge in the same run also gives the waiting to GitHub's scheduler:
nothing occupies a runner until the XCFramework exists, so however long
the macOS queue is, the consumers cannot time out on it and cannot
deepen it.

Moving `swift.yml` behind `release` fixes a second race the old layout
had without anyone hitting it: `publish` runs `gh release upload`, which
fails if `release.yml` has not created the Release yet. The two tag runs
were unordered; usually the Swift build was the slower one.

## Consequences

**Accepted:**

- The Swift build starts after `release.yml`'s build matrix instead of
  alongside it, so the XCFramework reaches the release later on a quiet
  day. Nothing downstream is waiting on it any more, so this costs
  nothing but wall-clock.
- A Swift build failure now turns the release run red, where it used to
  be red in a separate `swift.yml` run. This is the ADR-0039 intent: a
  failed publish is visible in the run that performed it.
- The single-channel re-run for CocoaPods and `Package.swift` is no
  longer `post-release.yml`'s dispatch. A `swift.yml` dispatch with a
  tag rebuilds the XCFramework and replaces the release asset
  (`--clobber`), which changes its SHA256. To retry only a failed
  update, re-run that job inside the release run
  (`gh run rerun <run-id> --failed`); `publish` succeeded and is not
  re-run. `docs/releasing.md` step 8 says this.

**Gained:**

- No poll, no timeout, and no macOS runner held waiting for another
  macOS job.
- CocoaPods validation can no longer see a missing asset.

## Alternatives considered

1. **Call `swift.yml` from `release.yml` and add it to `post-release`'s
   `needs:`** (`needs: [release, swift]`). Rejected — it orders
   Homebrew, Scoop, Chocolatey, Snap, AUR, and Flathub behind a macOS
   build they read nothing from, and a Swift failure would skip all six.
   Fan-in discipline (`.claude/rules/ci-parallelization.md` §1) forbids
   the edge.

2. **Leave `swift.yml` on its tag trigger and move the two jobs into it
   behind `publish`.** Fixes the XCFramework race but keeps the
   `publish`-before-`release` race, and keeps a library release workflow
   outside the graph ADR-0039 built. Folding it in is one more
   `workflow_call` stanza, so there is no saving to buy with the
   remaining race.

3. **Split the two jobs into their own reusable workflow called with
   `needs: [release, swift]`.** Rejected — a third file whose only
   content is two jobs whose only dependency is a job in `swift.yml`.
   Keeping them next to `publish` puts the edge where the asset is made.

4. **Lengthen the poll / add one to `update-cocoapods`.** Rejected — see
   Context. It was tried (koedame/chordsketch#2885) and closed.

## References

- [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md) —
  "Known limitation, deliberately not addressed here"
- v0.6.0 release run: https://github.com/koedame/chordsketch/actions/runs/34770974199
- koedame/chordsketch#2885 — the closed poll-based attempt
- CocoaPods trunk versions: https://trunk.cocoapods.org/api/v1/pods/ChordSketch
