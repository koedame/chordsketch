<!-- markdownlint-disable MD041 -->
# ChordSketch OS previews

Draws `.cho` / `.chopro` / `.crd` / `.chordpro` files where the
operating system's file manager previews them, rendering through
`chordsketch-render-html` so the preview matches the desktop app's,
`chordsketch --format html`, and the browser playground. Both previews
ship inside the ChordSketch desktop app:

- **Windows** — an in-process COM server that draws the file in File
  Explorer's preview pane. Ships as `chordsketch_preview_handler.dll`,
  next to `ChordSketch.exe`. Explorer loads it into its isolated
  `prevhost.exe` surrogate, hands it the file as an `IStream`, and gives
  it a window to draw in; the DLL shows the result in a WebView2
  control. Design decisions — why the installers register it, why the
  root follows the install scope, why the profile lives in `LocalLow` —
  are recorded in
  [ADR-0050](../../../docs/adr/0050-windows-preview-handler-is-installer-registered.md).
- **macOS** — a Quick Look preview extension that draws the file when
  you press Space in Finder. Ships as
  `ChordSketch.app/Contents/PlugIns/ChordSketchQuickLook.appex`: a
  small Swift executable linked against this crate built as a static
  library. See [macOS Quick Look extension](#macos-quick-look-extension)
  below, and
  [ADR-0083](../../../docs/adr/0083-the-macos-quick-look-extension-is-a-data-based-preview-signed-before-the-bundler.md)
  for the design decisions.

Linux has a standalone thumbnailer instead; see
[`packaging/linux/README.md`](../../../packaging/linux/README.md).

The rest of this file up to the macOS section describes the Windows
handler.

## Layout

```
apps/desktop/preview-handler/
├── Cargo.toml
└── src/
    ├── lib.rs             # module map; `shell` is cfg(windows)-only
    ├── document.rs        # bytes → HTML (platform-independent, unit-tested everywhere)
    ├── registration.rs    # the identifiers Explorer looks the handler up by
    ├── quicklook.rs       # macOS: the identifiers Quick Look uses, and the C ABI
    └── shell/
        ├── mod.rs         # DllGetClassObject / DllCanUnloadNow, live-object count
        ├── factory.rs     # IClassFactory
        ├── handler.rs     # IPreviewHandler + IInitializeWithStream + IObjectWithSite + IOleWindow
        └── host.rs        # the child window and the WebView2 control in it
```

Two files outside this directory belong to the same feature:

| File | Purpose |
|---|---|
| `apps/desktop/src-tauri/windows/preview-handler.wxs` | WiX fragment — registry layout for the `.msi` |
| `apps/desktop/src-tauri/windows/preview-handler.nsh` | NSIS macros — the same layout for the `.exe` |
| `apps/desktop/scripts/build-preview-handler.mjs` | Builds the DLL and stages it for `bundle.resources` |
| `apps/desktop/src-tauri/tauri.windows.conf.json` | Wires all three into the Tauri bundle |

## Registry layout

Written by the installer, never by the DLL. `<ROOT>` is `HKLM` for an
all-users install and `HKCU` for a per-user one — the WiX fragment
expresses that as `Root="HKMU"`, the NSIS hooks as `SHCTX`. All writes
go to the 64-bit registry view.

```
<ROOT>\Software\Classes\CLSID\{32E65E30-8242-492F-9985-C7785BB38BC7}
    (Default)       = ChordSketch ChordPro Preview Handler
    AppID           = {6d2b5079-2f0b-48dd-ab7f-97cec514d30b}   ; 64-bit prevhost.exe surrogate
    InprocServer32
        (Default)     = <install dir>\chordsketch_preview_handler.dll
        ThreadingModel = Apartment

<ROOT>\Software\Classes\.cho\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}
    (Default) = {32E65E30-8242-492F-9985-C7785BB38BC7}
    ; …and the same key under .chopro, .crd, .chordpro

<ROOT>\Software\Microsoft\Windows\CurrentVersion\PreviewHandlers
    {32E65E30-8242-492F-9985-C7785BB38BC7} = ChordSketch ChordPro Preview Handler
```

`{8895b1c6-…}` is the IID of `IPreviewHandler`; the presence of that
subkey is what marks a file type as previewable.

The two installer files are sister sites in the sense of
[`fix-propagation.md`](../../../.claude/rules/fix-propagation.md): they
say the same thing in two languages, and nothing at runtime reads both.
`src/registration.rs` holds the identifiers as constants, `include_str!`s
both files, and fails `cargo test` if either one drifts — including on
the Linux and macOS CI cells, where none of the COM code compiles.

## Building

The DLL is built automatically as part of a Windows Tauri build:
`apps/desktop/package.json`'s `prebuild` / `predev` hooks run
`node scripts/build-preview-handler.mjs`, which builds the crate for the
current target triple and copies the DLL to
`apps/desktop/src-tauri/windows/bin/` (gitignored) for
`bundle.resources` to install. It runs from the npm hooks rather than
from `build.beforeBundleCommand` because `tauri-build`'s build script
resolves declared resources while compiling `chordsketch-desktop` —
a resource staged at bundling time arrives too late for both
`cargo tauri build` and `cargo tauri dev`.

To build it on its own:

```powershell
cargo build --release --package chordsketch-preview-handler --target x86_64-pc-windows-msvc
```

On Linux and macOS none of the COM code compiles — everything except
`document.rs`, `registration.rs` and `quicklook.rs` is
`cfg(windows)`-gated — so `cargo clippy --workspace` and `cargo test
--workspace` stay green there. `cargo check --target x86_64-pc-windows-msvc -p
chordsketch-preview-handler` type-checks the COM layer from any host
with the target installed.

## Verifying it on a real machine

Explorer caches preview handler registrations per session, so restart it
after installing.

```powershell
# 1. Install the bundle (either installer registers the handler).
#    Then restart Explorer so it re-reads the approved-handler list.
Stop-Process -Name explorer -Force

# 2. Confirm the registration landed. Both should print the CLSID /
#    the DLL path; an empty result means the installer did not run its
#    hook.
Get-ItemPropertyValue 'HKCU:\Software\Classes\.cho\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}' '(default)'
Get-ItemPropertyValue 'HKCU:\Software\Classes\CLSID\{32E65E30-8242-492F-9985-C7785BB38BC7}\InprocServer32' '(default)'
#    For an MSI (per-machine) install, read the same paths under HKLM:.

# 3. Open a folder containing a .cho file, enable the preview pane
#    (View → Preview pane, or Alt+P), and select the file.
```

The song should render with chords above lyrics. If the pane instead
shows a line of plain text, that text is the handler reporting why it
could not draw — a missing WebView2 Runtime, an unwritable profile
folder, or a file over the 10 MiB preview limit.

If the pane stays empty with no message at all, the DLL was never
loaded: re-check step 2, and confirm the path in `InprocServer32` points
at a file that exists.

## Known limits

- **Images do not render.** Documents are loaded with
  `NavigateToString`, so they have an opaque origin and no base URL;
  an `{image}` directive has nothing to resolve its path against. The
  document's Content Security Policy states this limit explicitly
  (`img-src data:`).
- **No scripting, no network.** The policy is `default-src 'none'`. The
  pane renders files the user merely selected in Explorer, so a
  previewed document cannot execute code or make requests.
- **10 MiB ceiling**, matching the desktop app's open / export limit.
  Larger files show a message instead of a render.
- **64-bit only.** The DLL is registered against the 64-bit
  `prevhost.exe` surrogate; there is no 32-bit build.

## macOS Quick Look extension

A data-based Quick Look preview (`QLPreviewProvider`, macOS 12 and
later): Finder hands the extension the file, the extension returns an
HTML document, and Quick Look displays it. The document is
`document::render_preview`'s output — the same envelope, stylesheet and
Content Security Policy the Windows pane shows.

### Bundle layout

```
ChordSketch.app/Contents/
├── Info.plist                         # exports the ChordPro UTI (merged from src-tauri/Info.plist)
└── PlugIns/
    └── ChordSketchQuickLook.appex/
        └── Contents/
            ├── Info.plist             # NSExtension: com.apple.quicklook.preview
            ├── MacOS/ChordSketchQuickLook
            └── _CodeSignature/
```

| Identifier | Value |
|---|---|
| Exported UTI | `me.koeda.chordsketch.chordpro` — conforms to `public.plain-text`; extensions `cho`, `chopro`, `crd`, `chordpro`; MIME `text/x-chordpro` |
| Extension bundle ID | `me.koeda.chordsketch.desktop.quicklook` (prefixed by the app's `me.koeda.chordsketch.desktop`, as macOS requires) |
| Principal class | `ChordSketchPreviewProvider` |

The app only declares the type. It has no `CFBundleDocumentTypes`
entry, so installing ChordSketch does not make it the default app for
ChordPro files.

The sources live in `apps/desktop/src-tauri/macos/quicklook/`:

| File | Purpose |
|---|---|
| `PreviewProvider.swift` | Reads the file and returns the HTML Rust renders |
| `ChordSketchQuickLook.h` | The C ABI of `src/quicklook.rs`, imported by the Swift code |
| `Info.plist` | The extension's `Info.plist`; the build adds the version |
| `QuickLook.entitlements` | App Sandbox — macOS does not load an unsandboxed extension |

`src/quicklook.rs`'s tests read all four, plus
`apps/desktop/src-tauri/Info.plist` and `tauri.macos.conf.json`, and
fail if the identifiers above or the exported function names drift
between them. They run on every CI cell.

### Building

`apps/desktop/package.json`'s `prebuild` hook runs
`node scripts/build-quicklook-extension.mjs`, which on macOS:

1. builds this crate as a static library
   (`cargo rustc --crate-type staticlib`) for each architecture of the
   Tauri target;
2. compiles `PreviewProvider.swift` against it with `swiftc`, and
   `lipo`s the architectures for `universal-apple-darwin`;
3. assembles `apps/desktop/src-tauri/macos/build/ChordSketchQuickLook.appex`
   (gitignored), which `tauri.macos.conf.json`'s `bundle.macOS.files`
   copies into `Contents/PlugIns/`;
4. signs it — sandboxed, hardened runtime — with
   `APPLE_SIGNING_IDENTITY`, or ad hoc when that is unset.

It has to sign the extension itself: the Tauri bundler signs the app
without `--deep` and never signs files placed through
`bundle.macOS.files`. It is a logged no-op on Linux and Windows.
Building needs `swiftc`, from Xcode or the Command Line Tools.

`cargo tauri dev` runs the bare binary, not a bundle, so it does not
build the extension.

### Verifying it on a Mac

Build a bundle signed at least ad hoc, then run the smoke script, which
the arm64 cell of `.github/workflows/desktop-build.yml` also runs:

```sh
cd apps/desktop/src-tauri
APPLE_SIGNING_IDENTITY=- cargo tauri build --bundles app
cd ../../..
apps/desktop/scripts/quicklook-smoke.sh target/release/bundle/macos/ChordSketch.app
```

It copies the app into `~/Applications`, checks the signatures and the
sandbox entitlement, registers the app with LaunchServices and the
extension with `pluginkit`, checks that `.cho` resolves to the ChordPro
UTI, and opens a sample file in a Quick Look preview view
(`scripts/quicklook-render.swift`), failing unless the extension's
process runs. Pass a directory as a second argument to keep the
screenshot of that view. `qlmanage -p` cannot do this check: it aborts
with an ExtensionFoundation "key cannot be nil" exception for any
app-extension preview. Then select a `.cho`
file in Finder and press Space.

If Finder shows the file's source text instead of the rendered song,
the system's plain-text preview answered, which means the extension
did not load:

```sh
pluginkit -m -v -i me.koeda.chordsketch.desktop.quicklook   # listed? "+" = enabled
codesign --verify --deep --strict --verbose=2 ~/Applications/ChordSketch.app
qlmanage -r                                                  # reset Quick Look's cache
```

A `-` in front of the `pluginkit` line means it was disabled in System
Settings → General → Login Items & Extensions → Quick Look.

### Known limits on macOS

- **macOS 12 or later.** Older versions ignore the extension and show
  the plain-text preview.
- **Signing.** Until the release workflow has a Developer ID, the
  published bundles are not signed as a whole; see
  [`docs/releasing.md`](../../../docs/releasing.md#the-macos-quick-look-extension-and-signing).
- Images, scripting, network access and the 10 MiB ceiling behave as on
  Windows (see [Known limits](#known-limits) above). A file over the
  limit shows a message instead of a render.
