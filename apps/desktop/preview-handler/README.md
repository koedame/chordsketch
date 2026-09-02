<!-- markdownlint-disable MD041 -->
# ChordSketch Windows preview handler

In-process COM server that draws `.cho` / `.chopro` / `.crd` /
`.chordpro` files in File Explorer's preview pane. Ships inside the
ChordSketch desktop installer as
`chordsketch_preview_handler.dll`, next to `ChordSketch.exe`.

Explorer loads it into its isolated `prevhost.exe` surrogate, hands it
the file as an `IStream`, and gives it a window to draw in. The DLL
renders the source through `chordsketch-render-html` and shows the
result in a WebView2 control, so the pane matches the desktop app's
preview, `chordsketch --format html`, and the browser playground.

Design decisions — why the installers register it, why the root follows
the install scope, why the profile lives in `LocalLow` — are recorded in
[ADR-0050](../../../docs/adr/0050-windows-preview-handler-is-installer-registered.md).

## Layout

```
apps/desktop/preview-handler/
├── Cargo.toml
└── src/
    ├── lib.rs             # module map; `shell` is cfg(windows)-only
    ├── document.rs        # bytes → HTML (platform-independent, unit-tested everywhere)
    ├── registration.rs    # the identifiers Explorer looks the handler up by
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

The DLL is built automatically as part of a Windows Tauri bundle:
`tauri.windows.conf.json` sets `build.beforeBundleCommand` to
`node scripts/build-preview-handler.mjs`, which builds the crate for the
bundle's target triple and copies the DLL to
`apps/desktop/src-tauri/windows/bin/` (gitignored) for
`bundle.resources` to install.

To build it on its own:

```powershell
cargo build --release --package chordsketch-preview-handler --target x86_64-pc-windows-msvc
```

On Linux and macOS the crate compiles to an empty library — everything
except `document.rs` and `registration.rs` is `cfg(windows)`-gated — so
`cargo clippy --workspace` and `cargo test --workspace` stay green
there. `cargo check --target x86_64-pc-windows-msvc -p
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
