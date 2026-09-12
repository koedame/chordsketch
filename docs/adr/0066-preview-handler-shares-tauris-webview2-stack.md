# 0066. The preview handler shares Tauri's WebView2 stack, guarded by a lockfile comparison

- **Status**: Accepted
- **Date**: 2026-09-13

## Context

`chordsketch-preview-handler` (ADR-0050) hosts its preview pane through
`wry`, the WebView2 embedding layer `chordsketch-desktop` reaches through
`tauri-runtime-wry`. Both ship in the same Windows installer. The handler
declares `wry`, `windows` and `windows-core` directly, and those
requirements were written to match what Tauri resolves, so `Cargo.lock`
holds one copy of each.

Two things can split that into two copies, and neither makes anything red.

- **Tauri moves first.** `wry = "0.55"` is `^0.55`. When a Tauri release
  depends on `wry` 0.57, the handler keeps resolving 0.55, and the lock
  carries both — along with a second `windows` / `windows-core` line when
  the newer `wry` pulls one. The installer then bundles two WebView2
  embedding layers.
- **The handler moves first.** A dependency-update PR raising only the
  handler's `wry` produces the same split in the other direction.
  [#2865](https://github.com/koedame/chordsketch/pull/2865)
  (`wry` 0.55.0 → 0.57.0) was that PR; re-resolving it adds 237 lines to
  `Cargo.lock`. It was closed.

Until this ADR the invariant was recorded only in a comment in
`apps/desktop/preview-handler/Cargo.toml`. `scripts/check-version-consistency.py`
reads the handler's `package.version`, not its dependencies, and there is
no `deny.toml`.

## Decision

The handler's `wry`, `windows` and `windows-core` requirements stay on the
versions Tauri resolves. They move together, after Tauri does; a bump of
the handler's requirements alone is declined.

`scripts/check-webview-lockstep.py` enforces it from an unconditional
`webview-lockstep` job in `ci.yml`. It reads `Cargo.lock` and, for each of
the three crates, compares the entry the handler resolves with the entry
reached from `tauri-runtime-wry` (`wry` and `windows` directly,
`windows-core` through `wry`). A mismatch fails with both versions named.
A path the comparison needs that no longer exists in the lock also fails,
so a rename or restructure cannot turn the check into a silent pass.

## Rationale

- **The lock already records who resolved what.** Cargo writes a
  dependency as a bare name when the lock holds one version of a crate and
  as `name version` when it holds several, so both consumers' resolutions
  are readable without running cargo or touching the network. The check
  has the shape of the other guard jobs: Python-only, sub-second, no
  `paths:` filter.
- **It asserts the invariant, not a proxy for it.** The property that
  matters is that the two WebView2 consumers link the same crates, not
  that each crate appears once in the whole graph. Today's `main` already
  holds two `windows-core` versions — 0.61.2 for the WebView2 stack and
  0.62.2 for `iana-time-zone` — and that second copy is not what either
  consumer links.

## Consequences

- A Tauri update that leaves the handler behind, or a handler update that
  runs ahead of Tauri, fails on the PR that introduces it. Dependency-update
  PRs of the second kind are expected to go red and be closed.
- **Negative**: the Tauri side is named by dependency paths from
  `tauri-runtime-wry`. If Tauri restructures that corner of its graph, the
  check fails with a message pointing at `LOCKSTEP` and has to be updated.
  *Mitigation*: that failure is loud, and the edit is one table.
- **Negative**: the check does not cover other crates the two consumers
  happen to share (`raw-window-handle`, `webview2-com`). They are reached
  through `wry` or declared with requirements that have not drifted; add
  them to `LOCKSTEP` if one does.

## Alternatives considered

**`cargo-deny` with `bans.multiple-versions = "deny"` and an allowlist of
the known duplicates.** It is a maintained tool and would also bring the
licence axis. Rejected because the lock holds 75 crates with more than one
version (`syn`, `hashbrown`, `rand`, …); the allowlist would have to name
all of them, would change with ordinary dependency updates, and would have
to include `windows-core` itself because of `iana-time-zone` — putting one
of the three crates this ADR protects on the list of allowed duplicates.
ADR-0048 declined `cargo-deny` for the same allowlist cost.

**Assert that each of the three crates appears once in `Cargo.lock`.**
Simpler than comparing consumers, and fails on today's `main` for the
`windows-core` reason above.

## References

- ADR-0050 — why the preview handler embeds WebView2 through `wry`.
- ADR-0048 — the earlier decision not to adopt `cargo-deny`.
- ADR-0062 — the same guard-job shape for the MSRV restatements.
