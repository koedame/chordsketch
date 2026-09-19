# 0080. The Swift package manifest sits at the repository root and pins its XCFramework before the tag

- **Status**: Accepted
- **Date**: 2026-09-19
- **Amends**: [ADR-0067](0067-swift-package-joins-the-release-call-graph.md)
- **Amended by**: [ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md)

## Context

`packages/swift/README.md` tells consumers to add
`.package(url: "https://github.com/koedame/chordsketch", from: ...)`.
Swift Package Manager clones that repository at a tag and reads
`Package.swift` from its **root**. Three things stood between that
instruction and a working install:

1. **There was no manifest at the root.** It lived in `packages/swift/`.
   Resolving the package failed with
   `the package manifest at '/Package.swift' cannot be accessed`
   (reproduced on the tree before this change, in a `swift:5.9` container,
   with a consumer package depending on a local clone tagged `v0.7.0`).
2. **The tag pointed at the previous release's binary.** The
   `.binaryTarget`'s URL and checksum were rewritten by
   `swift.yml`'s `update-swift-package` job, which opens a pull request
   *after* the tag, because the checksum is the SHA-256 of an XCFramework
   zip that the release itself builds. `git show v0.7.0:packages/swift/Package.swift`
   names the `v0.6.0` asset, and `v0.6.0` names `v0.5.0`'s. Fixing (1)
   alone would have made every tag install the release before it.
3. **The tag held no bindings.** The committed
   `packages/swift/Sources/ChordSketch/ChordSketch.swift` is an empty
   placeholder; the real UniFFI bindings (`chordsketch.swift`) were
   generated in CI and never committed. A consumer resolving a tag got a
   target with none of `parseAndRenderHtml` and the rest. UniFFI checks the
   bindings against the binary at start-up, so a stale copy would fail too:
   the bindings have to come from the same build as the XCFramework.

All three come from one fact: a checkout of the tag is the package, and
the tag was cut before the parts the package needs existed.

## Decision

1. **`Package.swift` is at the repository root.** Its targets take
   `path:` under `packages/swift/`. `packages/swift/Package.swift` is gone.
2. **The generated bindings are committed** as
   `packages/swift/Sources/ChordSketch/chordsketch.swift`, replacing the
   placeholder. (One file, not two: a `ChordSketch.swift` beside a
   `chordsketch.swift` would collide on a case-insensitive checkout, which
   is where SwiftPM clones on macOS.)
3. **The XCFramework is built and pinned before the tag.** After the
   version bump is pushed to the release branch, the maintainer dispatches
   `swift.yml` with `pin=X.Y.Z` on that branch. It builds and tests the
   XCFramework as on any pull request, keeps the zip as the artifact
   `xcframework-<sha256>` (and the bindings as `swift-source-<sha256>`),
   and pushes one commit to the branch
   that sets the `.binaryTarget` URL (`…/releases/download/vX.Y.Z/…`) and
   checksum and commits the bindings generated in the same run. The pull
   request then merges as the release commit.
   `scripts/swift_package.py` reads and rewrites the target; the same code
   swaps in a local XCFramework for `swift test`.
4. **Release mode publishes that zip, and builds nothing.** With a tag,
   `swift.yml` skips the build jobs. `publish` reads the checksum from the
   tag's own `Package.swift`, refuses if its URL is not this tag's, fetches
   the artifact named by that checksum, verifies the SHA-256, and uploads
   it to the Release. `update-cocoapods` follows `publish` as before.
   `update-swift-package` and its pull request are removed.
5. **Two checks stand before the tag.** `Publishable` (required on the
   release pull request and in the merge queue) fails while the manifest
   names any other version than the workspace's, which is what forces the
   pin before the merge. `scripts/release.py`'s preflight fails if the
   pinned artifact has expired, if anything under `crates/`,
   `Cargo.toml` or `Cargo.lock` differs between the commit the zip was
   built from and the release commit, or if the committed bindings are not
   the file the pinned build generated.

## Rationale

The checksum is a property of a build, so it cannot be known before the
build and nothing here makes the build reproducible afterwards (`zip`
records modification times, and the static libraries and `xcodebuild`
output come from the runner's toolchain). The only ordering in which the
tag can contain the checksum is the one where the build comes first and the
same zip is uploaded later.
Everything else here follows from that: the zip has to be kept somewhere
between the pin and the tag, the tag-time job has to verify rather than
rebuild, and a source change after the build has to be caught before the
tag, because nothing after the tag can repair it.

Committing the bindings from the pinning run, rather than by hand or from a
separate generation, is what makes them match the zip. `uniffi-bindgen`
formats its output with `swift-format` when it finds one, so a copy
generated on another machine can differ in whitespace. The first pin run
produced the same file as a Linux generation, but that depends on the
runner image, so CI does not compare the committed copy with a fresh one.
Between releases `main` carries the bindings of the last pin.

Failing in `Publishable` rather than only in `release.py` moves the
reminder to the pull request that needs it, where the fix (dispatch the
pin) is one command, instead of to release day.

## Consequences

**Accepted:**

- The release order changes: bump, push, **pin** (a macOS build, as long
  as the queue makes it), merge, tag. Before, the Swift build ran after
  the tag.
- Tags up to and including `v0.7.0` still have no root manifest. SwiftPM
  works from the first release cut with this flow.
- SwiftPM clones the whole repository for consumers. That is the price of
  serving the package from the main repository at all.
- The pin has to be used within the repository's artifact retention, which
  is capped at 7 days (`retention-days: 90` is asked for and the cap wins;
  measured on the first pin run). From the pin to the end of the tag's
  release run, that is the window. An older pin has an expired zip and must
  be redone: a rebuilt zip has a different checksum, so it is a new pin,
  never a re-upload of an old one. A `swift.yml` dispatch with `tag`
  therefore re-uploads the pinned zip and no longer rebuilds it.
- Each pin stores a zip of about 240 MB as an artifact.
- Any change under `crates/` after the pin needs the pin again. The preflight
  says so instead of tagging a source the zip lacks.

**Gained:**

- A checkout of the tag resolves, contains its bindings, and points at the
  binary built for it (`swift package resolve` downloads the asset and
  verifies its checksum).
- No pull request is opened after the release that has to be merged by
  hand for `main` to stop pointing at the previous binary.

## Alternatives considered

1. **A separate repository for the Swift package (`chordsketch-swift`).**
   Keeps consumers from cloning the main repository and decouples the tag,
   but adds a repository, a credential that can write to it, and a second
   tag that has to be kept in step with each release. Not chosen.
2. **Distribute through CocoaPods only.** Drops SwiftPM, the ecosystem's
   default. Not chosen. (The pod shipped only the XCFramework, not the Swift
   bindings; [ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md)
   closes that gap.)
3. **Keep the post-tag pull request and move the tag onto it.** Rewrites a
   published tag after other channels have already consumed it. Not chosen.
4. **Rebuild at tag time and compare checksums.** Needs a reproducible
   XCFramework, which nothing here guarantees.

## References

- [ADR-0039](0039-release-fan-out-is-an-explicit-call-graph.md),
  [ADR-0067](0067-swift-package-joins-the-release-call-graph.md),
  [ADR-0068](0068-releases-run-through-one-preflighted-script.md),
  [ADR-0079](0079-merges-go-through-the-queue-which-runs-the-publish-checks.md)
- `.github/workflows/swift.yml`, `scripts/swift_package.py`,
  `scripts/release.py` (`preflight_swift`)
- Watch signal: a tag whose `swift package resolve` fails, or whose
  `Package.swift` names an asset the Release does not hold.
