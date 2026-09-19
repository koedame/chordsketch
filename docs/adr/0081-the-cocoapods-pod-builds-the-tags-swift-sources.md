# 0081. The CocoaPods pod builds the tag's Swift sources on top of the pinned XCFramework

- **Status**: Accepted
- **Date**: 2026-09-19
- **Amends**: [ADR-0067](0067-swift-package-joins-the-release-call-graph.md),
  [ADR-0080](0080-swift-package-manifest-at-the-root-pins-the-xcframework-before-the-tag.md)

## Context

`packages/swift/README.md` tells CocoaPods users to add `pod 'ChordSketch'`
and then `import ChordSketch`. The podspec's source was the XCFramework
zip, and its only content attribute was
`vendored_frameworks = 'chordsketchFFI.xcframework'`. The zip holds the C
headers and the module map of `chordsketchFFI`; the Swift API
(`parseAndRenderHtml` and the rest) is the UniFFI-generated
`chordsketch.swift`, which is in neither the zip nor the pod. A consumer got
a module named `chordsketchFFI` with no `ChordSketch` to import. (Read from
the podspec; the pod had never been installed in CI.)

ADR-0080 put that file in the tag, committed by the same run that pins the
XCFramework, which is what the pod needs.

## Decision

1. **The podspec's source is the git tag**, `:git` with `:tag => 'vX.Y.Z'`,
   and `source_files` is `packages/swift/Sources/ChordSketch/*.swift`, the
   committed bindings. The pod is named `ChordSketch`, so its module is the
   one the README imports.
2. **The XCFramework is fetched by `prepare_command`** from the release
   asset `publish` uploads, and unzipped next to the sources for
   `vendored_frameworks`. The command checks the download with
   `shasum -a 256 -c` against the checksum in the tag's own `Package.swift`,
   which `update-cocoapods` reads (`scripts/swift_package.py show`) and
   writes into the podspec. A zip that is not the one the bindings were
   generated with is refused, as SwiftPM refuses it.
3. **The license is the tag's `LICENSE`** (`:file`), which the git source now
   contains, instead of the inlined text the zip source needed.
   `libraries = 'z'` (the flate2 dependency) and `swift_version` match
   `Package.swift`.
4. **A pull request lints the pod.** `swift.yml`'s `lint-podspec` job takes
   the XCFramework and bindings that `assemble-xcframework` built, generates
   the podspec from the same template, points the download URL at the local
   zip (the release asset does not exist yet; the checksum, unzip and layout
   run as released), and runs `pod lib lint` with the pod's `Tests` test spec
   as frameworks and as static libraries. The test spec calls
   the render functions across the FFI, so `import ChordSketch`, the module
   lookup of `chordsketchFFI`, linking and the binding/binary match are run,
   not read. `pod trunk push` runs with `--skip-tests`: its own lint still
   builds the pod from the tag and the uploaded zip, and the tests ran on
   the pull request against the same build.
5. **`Publishable` checks the generated podspec's shape**
   (`cocoapods_problems`): the git tag source, the download URL and checksum
   in `prepare_command`, `source_files` that match files, and the license
   file.

## Consequences

- Versions of the pod up to 0.7.0 have no Swift API and stay that way:
  a published pod version cannot be changed. The first release cut with the
  pin (ADR-0080) is the first with the API.
- CocoaPods clones the whole repository at the tag, as SwiftPM does.
- The download inside `prepare_command` is exercised for real only by
  `pod trunk push`, after the asset exists. The pull request lint covers
  everything else, including the checksum and unzip steps through a local URL.

## Alternatives considered

1. **Drop CocoaPods and keep SwiftPM only.** Removes a channel that has
   users of the previous versions and has no other problem than this one.
   Not chosen.
2. **A second pod (`ChordSketchFFI`) for the binary, with `ChordSketch`
   depending on it.** The usual split, but a second name on trunk to
   register, publish in order and keep in step with each release, for a
   single binary that only this pod uses. Not chosen.
3. **Put `chordsketch.swift` inside the XCFramework zip.** The zip is the
   asset whose checksum `Package.swift` pins for SwiftPM; putting sources in
   it mixes two consumers' formats and would leave the bindings out of the
   tag. Not chosen.

## References

- [ADR-0067](0067-swift-package-joins-the-release-call-graph.md),
  [ADR-0080](0080-swift-package-manifest-at-the-root-pins-the-xcframework-before-the-tag.md)
- `packaging/cocoapods/ChordSketch.podspec.template`,
  `.github/workflows/swift.yml` (`lint-podspec`, `update-cocoapods`)
