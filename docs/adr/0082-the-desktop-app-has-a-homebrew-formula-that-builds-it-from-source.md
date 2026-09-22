# 0082. The desktop app has a Homebrew formula that builds it from source

- **Status**: Accepted
- **Date**: 2026-09-22
- **Follows**: [ADR-0074](0074-the-desktop-app-is-built-for-flathub-from-source.md)

## Context

The desktop app reaches macOS through a Homebrew cask that installs the
prebuilt DMG from the GitHub Release. That DMG is not signed with an Apple
Developer ID and not notarized (#2075 tracks the certificate). Measured on a
`macos-latest` runner after `brew install --cask koedame/tap/chordsketch`
([run](https://github.com/koedame/chordsketch/actions/runs/35621509652)):

- Every file of `/Applications/ChordSketch.app` carries
  `com.apple.quarantine: …;Homebrew Cask;…`. Homebrew documents that it
  "applies macOS quarantine attributes to Cask downloads so Gatekeeper
  performs these checks instead of Homebrew bypassing them", and the
  `--no-quarantine` flag is gone from Homebrew 5.1.0.
- The bundle's seal is broken: the executable is linker-signed ad hoc, the
  `Info.plist` is not bound and there are no sealed resources, so
  `codesign --verify --deep --strict` fails with "code has no resources but
  signature indicates they must be present". Tauri's documentation says an
  ad-hoc signature on the bundle avoids Apple silicon builds downloaded from
  GitHub releases being treated as damaged.

So the first launch of a cask-installed app needs the user to clear the flag
or approve the app in System Settings, until a certificate exists. A cask
cannot avoid this: it "distributes … pre-built files published by the
upstream developer" (Homebrew's Acceptable Casks).

Gatekeeper's first-launch check applies to quarantined files. Software the
user compiles is not downloaded as an app, so nothing quarantines it, and
Apple silicon only asks that code be signed in some way, which an ad-hoc
signature satisfies.

## Decision

1. **`koedame/tap` gets a formula `chordsketch-desktop` that builds
   `ChordSketch.app` on the user's machine**, next to the cask. It comes from
   `packaging/homebrew/chordsketch-desktop-formula.rb.template`, filled in
   with the release's source archive URL and checksum. It installs the bundle
   into the keg and puts `chordsketch-desktop` on `PATH`; putting the app in
   `/Applications` is left to the user (the caveats say how), because
   formulae are not meant to write outside their prefix (`brew linkapps` was
   removed in Homebrew 1.2.0).
2. **Rust comes from `rustup`**, not Homebrew's `rust`, which ships no
   `wasm32-unknown-unknown` standard library. `rustup` installs the host
   toolchain and that target as one matching release. `wasm-pack` and `node`
   come from Homebrew.
3. **The build runs the steps of `.github/actions/desktop-build-steps`**
   (wasm packages, grammar, `@chordsketch/react`, desktop frontend, then
   `tauri build --bundles app`), with the Tauri CLI run through `npx` at the
   version the workflows pin.
4. **The bundle is signed ad hoc** (`APPLE_SIGNING_IDENTITY=-`), which needs
   no certificate and gives the bundle the seal the DMG lacks.
5. **The Tauri updater is off in that build.** The formula compiles with
   `CHORDSKETCH_NO_SELF_UPDATE` set; `self_updates()` reads it with
   `option_env!` and the frontend already asks `self_update_enabled`
   ([ADR-0074](0074-the-desktop-app-is-built-for-flathub-from-source.md)).
   Updates arrive through `brew upgrade`.
6. **`homebrew-desktop-smoke.yml` builds the formula on macOS** in a local
   tap from this checkout's archive: `brew audit --strict`, `brew install
   --build-from-source`, `brew test`, no quarantine flag, `codesign --verify`,
   and launching the app through `open`.

## Rationale

Measured in the same run, on the formula build: `brew audit --strict` clean;
the build takes 6 minutes 14 seconds on `macos-latest` (arm64); the built app
has no quarantine flag, `codesign --verify --deep --strict` reports it valid
with `Sealed Resources version=2`, and `open` starts it
(`LAUNCH: Successful launched … me.koeda.chordsketch.desktop`).
`spctl --assess` says "rejected" for it, as it does for any app that is not
notarized: it assesses the policy without looking at the quarantine flag, so
it does not describe what a launch does.

The updater is switched off by a build-time variable here, where ADR-0074
declined a compile-time flag for the Flatpak, because the reasons differ. A
Flatpak announces itself at runtime through `/.flatpak-info`. A Homebrew build
has no such signal: the app is an ordinary bundle that the user can copy
anywhere, and a path test on `Cellar` would turn the updater back on for the
copy that the caveats recommend. Exactly one place builds for Homebrew, and
that place is the formula, so the flag is set once, beside the build steps it
belongs to.

## Consequences

- Users need Xcode Command Line Tools and wait about ten minutes for each
  install and upgrade (the runner's time; a user's machine may be slower).
- The app does not show up in Launchpad or Spotlight until it is copied into
  `/Applications`, and a copy is not updated by `brew upgrade` or in-app.
- The formula duplicates the build steps of `desktop-build-steps`. The smoke
  workflow catches drift only when the formula or the workflow changes.
- **Not verified on a user's Mac.** The runner has no one to answer a
  Gatekeeper dialog: the cask-installed app also started there. That a
  cask-installed app stops at the first-launch dialog, and that the
  source-built one does not, rests on Apple's and Homebrew's documentation and
  on the flags measured above. Intel Macs, and Macs whose Xcode Command Line
  Tools differ from the runner's, were not built.
- Homebrew is moving the network off for `install` (a `fetch` phase); a
  formula that downloads crates and npm packages during `install` will then
  need a `fetch` method.
- **Not published yet.** `desktop-release.yml` does not generate this formula
  or push it to the tap, and the README does not mention it.

## Alternatives considered

- **Keep the cask and buy a Developer ID.** Removes the first-launch step for
  every user and is tracked in #2075; it costs USD 99 per year and does not
  need this formula. The two are not exclusive.
- **A cask whose `preflight` builds the app.** A cask is defined as a place
  for finished, upstream-published files, and building in one is outside
  what Homebrew documents; a formula is the documented way to build from
  source.
- **Ad-hoc sign the DMG's bundle and keep the cask.** Fixes the broken seal
  that Tauri documents as the "damaged" trigger, but the quarantined app
  still needs the user's approval. Worth doing on its own; it does not remove
  the step.
- **Homebrew's `rust` plus a downloaded wasm32 standard library.** Breaks
  whenever the two are not the same Rust release (ADR-0074 rejected the same
  combination for the Flatpak).
- **A `Cellar` path test for the updater.** Wrong for a copy in
  `/Applications`.

## References

- [Homebrew Security and Supply Chain](https://docs.brew.sh/Homebrew-Security-and-Supply-Chain),
  [Acceptable Casks](https://docs.brew.sh/Acceptable-Casks),
  [Homebrew 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)
- [Tauri: macOS code signing](https://v2.tauri.app/distribute/sign/macos/),
  [Tauri: GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/)
- Apple Developer Forums on ad-hoc signing on Apple silicon
  (https://developer.apple.com/forums/thread/699085) and on when Gatekeeper
  runs (https://developer.apple.com/forums/thread/740680)
- #2075 (Developer ID signing and notarization)
