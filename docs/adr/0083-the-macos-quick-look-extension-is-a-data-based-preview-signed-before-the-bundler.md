# 0083. The macOS Quick Look extension is a data-based preview, built without Xcode and signed before the bundler

- **Status**: Accepted
- **Date**: 2026-09-24

## Context

The [file-preview tracking issue](https://github.com/koedame/chordsketch/issues/861)
asks for the OS file managers to preview ChordPro files. Linux ships a
standalone thumbnailer (`packaging/linux/`) and Windows an
installer-registered preview handler (ADR-0050). The
[Quick Look issue](https://github.com/koedame/chordsketch/issues/2288)
is the macOS half: pressing Space on a `.cho` in Finder should show the
rendered song.

macOS only loads Quick Look previews from an **app extension** — a
`.appex` bundle inside a host application's `Contents/PlugIns/`, signed,
and running in the App Sandbox. The host here is the Tauri desktop app.
Several choices had to be made, each with a plausible alternative that
is expensive to back out of once bundles are in the field:

**What kind of extension.** Since macOS 12, Quick Look has two
extension styles. A *view-based* preview hands the extension an
`NSViewController` to fill; an HTML preview would mean embedding a
`WKWebView`, whose web-content process needs extra sandbox exceptions
inside an extension. A *data-based* preview (`QLPreviewProvider`,
`QLIsDataBasedPreview`) returns bytes of a declared type — HTML among
them — and Quick Look renders them itself.

**How it is built.** Tauri drives the macOS bundle itself and has no
notion of Xcode targets. The extension could be an Xcode project built
by `xcodebuild`, or a single Swift file compiled by `swiftc`.

**How it reaches the renderer.** The song has to go through
`chordsketch-render-html`, the same as every other surface
(`renderer-parity.md`). The Swift SDK (`crates/ffi`, UniFFI) exposes
the renderer to Swift, but not `chordsketch-preview-handler`'s document
envelope — the CSP-carrying wrapper ADR-0050 introduced for previewing
untrusted files.

**Which file type it previews.** Quick Look selects an extension by
Uniform Type Identifier. No system UTI covers ChordPro, so the app has
to declare one — and the obvious way to do that in Tauri,
`fileAssociations`, also claims the app as the files' editor.

**Who signs it.** The Tauri bundler signs the app's own binaries and
then the app bundle, and does not pass `--deep`. It never signs files
placed through `bundle.macOS.files`, but `codesign` refuses to seal a
bundle that contains unsigned code.

## Decision

**A data-based preview.** `PreviewProvider.swift` reads the file, calls
into Rust for the HTML, and returns it as a `QLPreviewReply` of type
`.html`. There is no view code. The extension requires macOS 12.

**Compiled with `swiftc`, assembled by a script.**
`apps/desktop/scripts/build-quicklook-extension.mjs` runs from the
`prebuild` npm hook on macOS: it builds the Rust side as a static
library, compiles the one Swift file with `-application-extension` and
Foundation's `NSExtensionMain` as the entry point, `lipo`s the
architectures for a universal target, writes the bundle, and signs it.
`tauri.macos.conf.json` copies the result to
`Contents/PlugIns/ChordSketchQuickLook.appex`.

**The Rust side is `chordsketch-preview-handler`, built as a static
library.** Its platform-independent `document` module gains
`render_preview` (bytes in, document out — including a message document
for a file over the 10 MiB limit), and a `quicklook` module exports a
three-function C ABI on macOS only. The crate's manifest keeps
`crate-type = ["cdylib"]` for the Windows DLL; the script picks
`staticlib` with `cargo rustc --crate-type`.

**The app exports `me.koeda.chordsketch.chordpro` and claims nothing
else.** `apps/desktop/src-tauri/Info.plist`, which the Tauri bundler
merges into the app's, declares the UTI with the four extensions and
`text/x-chordpro`, conforming to `public.plain-text`. There is no
`CFBundleDocumentTypes` entry.

**The script signs the extension, with the app's identity.** It reads
`APPLE_SIGNING_IDENTITY` — the variable the bundler signs the app with
— and falls back to ad hoc (`-`). The signature carries the sandbox
entitlement and the hardened runtime, plus a secure timestamp for a
real identity. The bundler then seals the app around it. PR builds of
the macOS cells sign ad hoc, and the arm64 cell installs the bundle,
checks `pluginkit`, and previews a `.cho` in a Quick Look view.

The extension's bundle identifier is
`me.koeda.chordsketch.desktop.quicklook`.

## Rationale

**Data-based** keeps the extension to one short Swift file with no
WebKit inside the sandbox, and no entitlement beyond the sandbox itself.
Quick Look renders the HTML with scripting off; the document still
carries ADR-0050's `default-src 'none'` CSP, so the macOS and Windows
previews show the same bytes under the same policy. macOS 11 and older
are the cost: they would need the deprecated generator API, a different
plug-in format.

**`swiftc` over Xcode** because an Xcode project would be the only one
in the repository, carrying a `project.pbxproj` whose settings duplicate
what the Tauri config already says, for a target with one source file.
The script is the whole build: it is short, readable, and run on every
macOS PR build, which is where it would break.

**The existing crate over the Swift SDK** because the preview needs the
envelope, not only the renderer, and one crate means one rendering
contract for both OS previews. Going through UniFFI would put a
generated binding layer and an XCFramework between a 40-line Swift file
and a function that takes bytes and returns bytes. `cargo rustc
--crate-type` avoids building a Windows static library nobody links.

**Exporting the UTI without document types** follows ADR-0050's line:
installing a preview does not make ChordSketch the default app for
ChordPro files (the desktop app does not handle files opened from
Finder at all yet). Conforming to `public.plain-text` means a Mac where
the extension is disabled, or cannot load, falls back to the system's
text preview rather than a blank icon.

**Signing in the script** is forced by the bundler, and it is also what
the extension needs: a deep re-sign would replace its entitlements with
the app's, and macOS does not load an unsandboxed extension. Sharing
`APPLE_SIGNING_IDENTITY` keeps "which identity signs the app" a single
setting when the Developer ID arrives
([signing and notarization](https://github.com/koedame/chordsketch/issues/2075)).

**The identifier** differs from the `me.koeda.chordsketch.QuickLookExtension`
the Quick Look issue proposed, because an embedded extension's
identifier must be prefixed by its host's, and the host is
`me.koeda.chordsketch.desktop`.

## Consequences

- A macOS bundle now builds three Rust artifacts and needs `swiftc`
  (Xcode or the Command Line Tools), which the GitHub runners and
  Homebrew's build environment both provide. Linux and Windows skip the
  step with a log line.
- `quicklook.rs`'s tests `include_str!` both property lists, the C
  header, the Swift source and `tauri.macos.conf.json`, and fail if the
  UTI, bundle identifier, principal class, executable name or exported
  function names drift apart — on every CI cell, since none of it needs
  macOS to read.
- **The Developer ID has to be in a keychain before `npm run build`.**
  The bundler imports `APPLE_CERTIFICATE` only when it reaches the
  signing step, which is after the `prebuild` hook has already signed
  the extension. When the Developer ID is added, the release job imports
  it first; `docs/releasing.md` records the steps.
- Release bundles are not signed as a whole until then; the extension
  inside them is signed ad hoc. The Homebrew source-build formula
  (ADR-0082) signs its whole bundle ad hoc, so the extension is sealed
  into it the same way it is in PR builds.
- The bundle identifier `me.koeda.chordsketch.desktop.quicklook` is
  frozen: `pluginkit` keys the user's enable / disable choice on it.
- Images referenced by `{image}` do not render, for the same reason as
  on Windows: the document has no base URL, and the CSP says so.

## Alternatives considered

**View-based preview with a `WKWebView`.** Full control over the
page. Rejected: it moves WebKit into the sandboxed extension, which
needs sandbox exceptions for its helper processes, and more code for no
visible difference.

**An Xcode project built by `xcodebuild`.** What Apple's templates
produce, and what the Quick Look issue suggested. Rejected for the
reasons above; it remains the fallback if the extension ever needs
resources (asset catalogs, localised strings) that `swiftc` alone
cannot compile.

**Linking the UniFFI Swift SDK.** Rejected: the envelope would have to
be reimplemented in Swift or added to the public SDK, where it does not
belong.

**A separate Rust crate for the Quick Look ABI.** A cleaner name than
"preview-handler". Rejected for now: it would hold three functions and
depend on the one crate that already owns the document contract;
splitting `document` into its own crate is the move if a third preview
surface appears.

**`fileAssociations` with an `exportedType`.** Tauri's own way to
declare a UTI. Rejected: it also writes `CFBundleDocumentTypes`,
claiming the file type for an app that does not yet open files from
Finder.

**Signing the whole bundle with `codesign --deep` after the bundler.**
One command. Rejected: `--deep` applies one set of entitlements to
every nested bundle, which strips the extension's sandbox.

## References

- [Quick Look — Apple Developer Documentation](https://developer.apple.com/documentation/quicklook) — `QLPreviewProvider`, `QLPreviewReply`, and the `QLIsDataBasedPreview` key.
- ADR-0050 — the Windows preview handler, whose document module and CSP this extension reuses.
- ADR-0082 — the Homebrew source build, which signs ad hoc.
- `apps/desktop/preview-handler/README.md` — the bundle layout, and how to verify the extension on a Mac.
- `docs/releasing.md` — how the extension travels through signing and notarization.
