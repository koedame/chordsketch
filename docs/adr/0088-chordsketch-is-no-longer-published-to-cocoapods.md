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

## Rationale

Restructuring the pod to work around trunk's `prepare_command` rejection
(a second release asset, or dropping back to the XCFramework-only pod
ADR-0081 replaced) buys at most two months of service before trunk stops
taking pushes regardless. The cost is a new release asset shape plus the
macOS `lint-podspec` matrix kept green against it; the benefit is a
channel that cannot accept another version past 2026-12-02 even if the
workaround succeeds. The Swift package already carries the same
XCFramework (ADR-0080) and is the one channel the pod pulled its
content from, so removing the pod loses no capability a CocoaPods user
cannot already get from the Swift package.

## Consequences

- `pod 'ChordSketch'` resolves to 0.7.0, which has no Swift API
  (ADR-0081), and gets no later version.
- The daily release rollup reads the manifest at the newest tag. Tags up to
  v0.8.0 still list a `cocoapods` channel, so `RETIRED_KINDS` in
  `scripts/_release_channels.py` makes the rollup skip it instead of failing
  on a kind main no longer implements.
- Releases no longer wait on a macOS job for the pod, and the macOS lint
  matrix on pull requests is gone.

## Alternatives considered

- **Restructure the podspec around a second release asset** so
  `prepare_command` stops triggering trunk's rejection. Rejected: the
  fix is non-trivial (a new asset shape, re-verified `lint-podspec`
  matrix) for a channel with about two months of life left before it
  goes read-only regardless.
- **Retry the push as-is, assuming the internal server error was
  transient.** Rejected: it failed identically four times across the
  0.8.0 release, which rules out a one-off trunk hiccup.
- **Keep the `cocoapods` release channel definition but mark it
  permanently stale instead of deleting it.** Rejected: a channel
  nothing publishes to is dead configuration, not a paper trail — the
  paper trail is this ADR and the superseded ADR-0081.

## References

- [CocoaPods blog](https://blog.cocoapods.org)
