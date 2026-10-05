# 0088. The CocoaPods pod installs from one release archive and has no `prepare_command`

- **Status**: Accepted
- **Date**: 2026-10-05
- **Amends**: [ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md)

## Context

[ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md) made the
pod's source the git tag and fetched the XCFramework in a
`prepare_command`. v0.8.0 was the first release published with that podspec,
and `pod trunk push` failed four times in a row with
`[!] An internal server error occurred.`, after the local lint (the build of
the pod for iOS and macOS) had passed. trunk's status page showed no incident.

The cause is in trunk's source (`app/models/specification_wrapper.rb`,
`validate_prepare_command`, added to trunk's `master` in 2026): trunk refuses a
`prepare_command` for any pod that is not on a fixed list of existing pods
(`ALLOWED_PREPARE_COMMAND_PODS`). The refusal is written as
`linter.add_error(:prepare_command, …)`, but `Pod::Specification::Linter` has
no `add_error` (only its `results` does, in cocoapods-core 1.11.3 and on
`master`). The call raises `NoMethodError`, which trunk's catch-all turns into
the generic 500. Reproduced: loading the 0.8.0 podspec with cocoapods-core
1.11.3 lints with no error, and `Linter#add_error` raises
`NoMethodError: undefined method 'add_error'`. Every push of a podspec with a
`prepare_command` from a pod outside the list fails the same way, whatever the
trunk's state. `ChordSketch` is not on the list, and the list is not ours to
change.

A pull request could not have shown it: `pod lib lint` and `pod spec lint`
run on the machine and never ask trunk.

## Decision

1. **The podspec has no `prepare_command`.** Its source is one release asset,
   `chordsketch-cocoapods.zip` (`:http`), which holds what the pod needs at its
   root: the XCFramework, `LICENSE`, `THIRD_PARTY_LICENSES.md` and `NOTICE`,
   `packages/swift/Sources/ChordSketch/*.swift` (the bindings the tag holds)
   and `packages/swift/Tests/*.swift` (the pod's test spec). The podspec's
   attribute paths are the ones they were with the git source.
2. **`publish` builds the archive** from the XCFramework zip it has just
   checked against the checksum `Package.swift` pins, plus the tag's files
   (`scripts/swift_package.py pod-archive`), and uploads it beside that zip.
   The binary in the pod is therefore the one the bindings were generated
   for, as before; the check moves from the consumer's machine to `publish`.
   The XCFramework zip itself is unchanged, so SwiftPM's pin is unaffected.
   `publish` also computes the archive's SHA-256, and `update-cocoapods` writes
   it into the podspec as `:sha256`, so CocoaPods refuses any other archive at
   that URL. The archive is byte-for-byte reproducible (fixed times and modes),
   so a re-run of `publish` uploads the archive a published pod already pins.
3. **`lint-podspec` runs `pod spec lint`**, not `pod lib lint`, with the URL
   rewritten to the archive that `pod-archive` builds from the pull request's
   own XCFramework, with its checksum. `pod lib lint` builds the working directory and never
   reads `s.source`; `pod spec lint` downloads the source the way
   `pod trunk push` does.
4. **`Publishable` checks the rule trunk applies** (`cocoapods_problems`): no
   `prepare_command`; the source is the release asset, pinned to a checksum; `source_files`, the
   test spec's `source_files`, `vendored_frameworks` and the license file all
   match entries of the archive `pod-archive` builds from the checkout.

## Consequences

- v0.8.0 cannot be pushed to CocoaPods: its tag holds the old podspec
  template, and a tag is not changed. The pod gets its first Swift API in the
  next release. Versions up to 0.7.0 stay as they are.
- The release has one more asset (`chordsketch-cocoapods.zip`), of about the
  size of the XCFramework zip.
- A future rule of trunk's that only its server applies is still invisible to a
  pull request. `cocoapods_problems` carries the one known now.

## Alternatives considered

1. **Ask CocoaPods to add `ChordSketch` to `ALLOWED_PREPARE_COMMAND_PODS`.**
   Outside our hands and slow, for a rule trunk added to stop new pods from
   running commands on consumers' machines. Not chosen.
2. **Commit the XCFramework into the tag.** Contradicts
   [ADR-0080](0080-swift-package-manifest-at-the-root-pins-the-xcframework-before-the-tag.md)
   (the binary is a release asset, the tag holds only its checksum) and puts
   a binary in git history on every release. Not chosen.
3. **Two pods** (`ChordSketchFFI` for the binary, `ChordSketch` for the
   sources). Already rejected in ADR-0081 for the same reasons. Not chosen.
4. **Put the Swift sources into `chordsketch-xcframework.zip`.** Already
   rejected in ADR-0081: the zip is what SwiftPM's pin checksums. Not chosen.

## References

- [ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md)
- trunk.cocoapods.org source, `app/models/specification_wrapper.rb`
- `packaging/cocoapods/ChordSketch.podspec.template`,
  `.github/workflows/swift.yml` (`lint-podspec`, `publish`, `update-cocoapods`),
  `scripts/swift_package.py` (`pod-archive`)
