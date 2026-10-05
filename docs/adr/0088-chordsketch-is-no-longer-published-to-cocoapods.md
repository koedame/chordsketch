# 0088. ChordSketch is no longer published to CocoaPods

- **Status**: Accepted
- **Date**: 2026-10-05
- **Supersedes**: [ADR-0081](0081-the-cocoapods-pod-builds-the-tags-swift-sources.md)
- **Amends**: [ADR-0067](0067-swift-package-joins-the-release-call-graph.md)

## Context

The CocoaPods maintainers have announced that trunk becomes read-only on
2026-12-02: no new pods and no new versions, while the published ones keep
resolving. Swift Package Manager is the supported way to consume a Swift
library.

The 0.8.0 release had also failed to publish the pod: `pod trunk push`
answered `An internal server error occurred.` four times. 0.8.0 was the
first version whose podspec used `prepare_command`; trunk rejects that for a
new pod through code that raises instead of returning the rejection.
Working around it meant restructuring the pod around a second release asset
for a channel that has about two months left.

## Decision

1. **ChordSketch is not published to CocoaPods from 0.8.0 on.** The
   `update-cocoapods` and `lint-podspec` jobs in `swift.yml`, the
   `packaging/cocoapods/` template, the `cocoapods` channel in
   `ci/release-channels.toml` and its rollup check, the `cocoapods` check in
   `check-publishable.py`, the `release-credentials.yml` trunk check and the
   CocoaPods installation instructions are removed.
2. **The Swift package is the one Swift channel.** The `Publishable` job that
   checked both is now `swift-package`.
3. **Version 0.7.0, already on trunk, stays there.** A published version
   cannot be removed. The `COCOAPODS_TRUNK_TOKEN` repository secret is no
   longer read by any workflow.

## Consequences

- `pod 'ChordSketch'` resolves to 0.7.0, which has no Swift API
  (ADR-0081), and gets no later version.
- Releases no longer wait on a macOS job for the pod, and the macOS lint
  matrix on pull requests is gone.

## References

- [CocoaPods trunk read-only plan](https://blog.cocoapods.org)
