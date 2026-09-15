# 0074. The desktop app is built for Flathub from source, as `io.github.koedame.chordsketch`

- **Status**: Accepted
- **Date**: 2026-09-15
- **Follows**: [ADR-0072](0072-the-cli-is-not-published-to-flathub.md)

## Context

ADR-0072 left the desktop app as the only possible Flathub listing and named
what it needed: a manifest that builds the Rust, npm and wasm parts from
sources without network access, AppStream metainfo, scoped permissions and a
first submission. The
[requirements](https://docs.flathub.org/docs/for-app-authors/requirements)
that shape the manifest:

- "All source available submissions must be built entirely from source code",
  and "There is no network access during the build process": every crate, npm
  package and toolchain component is a checksummed source in the manifest.
- "The ID must not end in generic terms like `.desktop, .app, .linux`." The
  Tauri identifier is `me.koeda.chordsketch.desktop`.
- A domain ID requires that "the author or developer must have control over
  the domain"; applications "hosted on `github.com`" may instead use an
  `io.github.` ID, whose last two components are the repository's owner and
  name. `flatpak-builder-lint manifest` fetches the URL an ID stands for and
  fails with `appid-url-not-reachable` when it does not answer.
- "The runtime(s) used in the manifest must be hosted on Flathub and must be
  the latest version at that time of submission."
- "When a suitable XDG portal exists … using the portal becomes mandatory
  instead of static permissions."
- "All submissions must provide a Metainfo file that passes validation."

Neither the requirements nor the maintenance documentation say anything about
applications that update themselves. The Tauri updater cannot work inside a
Flatpak regardless: the application lives on a read-only `/app`, and
`tauri-plugin-updater` 2.11 on Linux only knows how to replace an AppImage,
`.deb` or `.rpm`.

## Decision

1. **The Flatpak ID is `io.github.koedame.chordsketch`**, the code-hosting ID
   for `github.com/koedame/chordsketch`. Flathub verifies it through an
   administrator of the `koedame` organization signing in with GitHub, so
   nothing has to be served from a domain. The Tauri identifier stays
   `me.koeda.chordsketch.desktop`: macOS and Windows installations, and the
   Homebrew cask's `zap` paths, key their data on it. The Flatpak build does
   not enable GTK's application ID, so the two never meet; the desktop file
   matches the window through `StartupWMClass=chordsketch-desktop`.
2. **The runtime is `org.gnome.Platform`**, at its newest branch (50). It is
   the runtime that carries WebKitGTK 4.1, which Tauri's WebView links;
   `org.freedesktop.Platform` does not, and building WebKitGTK in the manifest
   is not reasonable.
3. **Everything is built from source inside the manifest** (`packaging/flatpak/`):
   - Rust comes from static.rust-lang.org as the host toolchain plus the
     `wasm32-unknown-unknown` standard library, one release for both. The
     rust-stable SDK extension ships no wasm32 standard library, and its rustc
     refuses a standard library from any other release.
   - The wasm-bindgen CLI is built from its crate at the version `Cargo.lock`
     pins, and turns the `chordsketch-wasm` build into the web bundle the
     frontend loads. wasm-opt is not run; the bundle is larger, not different.
   - The tree-sitter grammar is compiled with the LLVM SDK extension's clang
     against wasi-libc's headers, with the flags `tree-sitter build --wasm`
     uses. The tree-sitter CLI downloads its compiler at build time.
   - npm packages come from the `apps/desktop` and `packages/react` lockfiles.
     The frontend is built with `vite build`; the `tsc` type check that
     precedes it in `npm run build` stays in CI, not in the package.
   - The desktop binary is `cargo build -p chordsketch-desktop --features
     tauri/custom-protocol`, which is what the Tauri CLI adds for a release
     build.
   `packaging/flatpak/prepare.py` generates the source lists with
   flatpak-builder-tools, at a pinned commit, from the lockfiles.
4. **The updater is off inside a Flatpak.** The Rust side does not register the
   updater and process plugins when `/.flatpak-info` exists, and the frontend
   asks the new `self_update_enabled` command before checking. Updates arrive
   through Flathub.
5. **Permissions are `--share=ipc`, `--socket=wayland`,
   `--socket=fallback-x11`, `--device=dri` and `--socket=pulseaudio`**, the
   last for the metronome and chord audition. No filesystem or network
   permission: the file dialogs are GTK's native chooser, which goes through
   the FileChooser portal inside a sandbox, and the updater is off.
6. **The `Publishable` check has a `flathub` job.** It runs
   `desktop-release.yml`'s `Generate Flathub files` step, lints the manifest,
   the metainfo and the built repository with `flatpak-builder-lint` and the
   desktop file with `desktop-file-validate`, builds the Flatpak offline in the image Flathub's
   GitHub actions use, and launches it under Xvfb until the window title the
   app sets at the end of its startup appears.
7. **Updates are pull requests on `flathub/io.github.koedame.chordsketch`**, opened by
   `desktop-release.yml`'s `update-flathub` job with the files `prepare.py`
   writes for the tag and the `FLATHUB_TOKEN` secret. A maintainer installs
   the test build Flathub links and merges. The job stops before the pull
   request while that repository does not exist, and for prerelease tags.
   `release-credentials.yml` checks `FLATHUB_TOKEN` once the repository
   exists.
8. **The first submission to `flathub/flathub` is made by the maintainer.**
   Flathub's generative AI policy requires disclosing AI-generated code and
   packaging and does not allow AI tools to open or write submission pull
   requests.

## Rationale

A source build with a toolchain from outside the SDK is more manifest than a
repackaged `.deb`, which Tauri's own Flatpak guide shows, but a repackaged
binary is exactly what the requirements exclude. Taking Rust from its upstream
release rather than the extension is the only way to have a wasm32 standard
library that matches the compiler; Flathub apps such as Chromium already take
their Rust that way.

Detecting the sandbox at runtime keeps one frontend and one binary for every
build, and ties the updater's absence to the reason it cannot work rather than
to a build flag someone has to remember.

Launching the built Flatpak is what found the desktop app stopping partway
through its startup (#2907), which the jobs that only compile it could not.

## Consequences

- `scripts/check-version-consistency.py` requires the metainfo's newest
  `<release>` to be the desktop version, so each release adds one.
- Bumping `wasm-bindgen` in `Cargo.lock` needs nothing else: `prepare.py` builds
  the CLI at the locked version.
- The Rust release is resolved when the files are generated, so a release
  builds with the stable Rust of its release day, as the other CI jobs do.
- Linux users who install the Flatpak are not offered in-app updates.

## Alternatives considered

- **`me.koeda.ChordSketch`, the domain of the Tauri identifier.** `koeda.me`
  answers automated requests from GitHub's runners with a Cloudflare
  challenge (`403`), so the linter's `appid-url-not-reachable` fails in CI
  and would fail in Flathub's own checks; passing it means turning off the
  bot protection for every site under the domain. The ID cannot be changed
  after the first submission, so it should not depend on that setting.
- **Repackage the release `.deb`** (Tauri's documented Flatpak route). Not a
  source build.
- **`org.freedesktop.Platform`.** Has no WebKitGTK.
- **The rust-stable extension plus a downloaded wasm32 standard library.**
  Breaks whenever the extension moves to a Rust release the pinned standard
  library is not from.
- **Change the Tauri identifier to a Flathub-valid one everywhere.** Moves every
  existing installation's data directory for a constraint only Flathub has.
- **Take `@chordsketch/wasm-export` from npm.** A prebuilt binary of this
  application.
- **A Cargo feature that compiles the updater out.** Every Flatpak build would
  have to remember the flag, while the sandbox already says the updater cannot
  work.
