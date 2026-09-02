# 0050. The Windows preview handler is registered by the installer, at the installer's scope

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

Explorer's preview pane renders a file type when the shell can find an
in-process COM server implementing `IPreviewHandler` for it. `#861`
tracks that integration across the three desktop platforms; the Linux
half already ships as a standalone XDG thumbnailer
(`packaging/linux/`), and `#2289` covers Windows.

Three questions had to be answered before writing any code, and each
has a plausible-looking wrong answer that is expensive to reverse once
installers are in the field.

**Who writes the registry keys.** The canonical COM mechanism is a
self-registering DLL: `DllRegisterServer` / `DllUnregisterServer`
exports, invoked by `regsvr32`. It puts the key layout in one place —
inside the binary that the keys point at. But invoking it correctly
from an installer is where it goes wrong. Windows Installer runs the
MSI's deferred custom actions as `LocalSystem` unless the action opts
into impersonation, so a `regsvr32` that writes `HKEY_CURRENT_USER`
writes it into the wrong hive; a failing `DllUnregisterServer` leaves
stale keys that the MSI cannot roll back, because self-registration is
opaque to the installer's transaction. NSIS adds its own trap: it is a
32-bit process, so `$SYSDIR\regsvr32.exe` resolves to the 32-bit
`regsvr32`, which cannot load a 64-bit in-process server.

**Which registry root.** Microsoft's "How to Register a Preview
Handler" says to use `HKEY_LOCAL_MACHINE` for an all-users install and
`HKEY_CURRENT_USER` for a per-user one. The two installers Tauri
produces from one config disagree on which they are: the WiX template
declares `InstallScope="perMachine"` (elevated), while the NSIS
`installMode` defaults to `currentUser` (no admin rights). Picking one
root for both would be wrong for one of them.

**What draws the preview.** `chordsketch-render-html` produces HTML, so
the pane needs an HTML renderer running inside `prevhost.exe`. The
desktop app already carries WebView2 as a hard dependency — Tauri's
Windows installer installs the runtime — so the same engine is
available without adding a distribution requirement.

## Decision

**The installers own the registration, declaratively; the DLL exports
only `DllGetClassObject` and `DllCanUnloadNow`.** There is no
`DllRegisterServer`. `apps/desktop/src-tauri/windows/preview-handler.wxs`
(a WiX fragment merged via `bundle.windows.wix.fragmentPaths`) and
`apps/desktop/src-tauri/windows/preview-handler.nsh` (macros merged via
`bundle.windows.nsis.installerHooks`) each write the key layout in their
own language.

**The registration root follows the install scope.** The WiX fragment
writes `Root="HKMU"`, the NSIS hooks write `SHCTX` — the same mechanism
Tauri's own file associations and deep links use. Both resolve to HKLM
for an all-users install and HKCU for a per-user one, so the default
`.exe` installer needs no administrator rights and the elevated MSI
registers for the machine it elevated to modify. Both write through the
64-bit registry view (`Win64="yes"` / `SetRegView 64`).

**The preview is a WebView2 control showing this crate's own document
envelope.** `chordsketch-preview-handler` builds the document from
`chordsketch-render-html`'s *fragment* API (`render_songs_body_*` +
`render_html_css`) rather than its full-document API, so the envelope
can carry a `Content-Security-Policy` meta tag, and hosts it through
`wry` — the same WebView2 embedding layer the desktop app runs on. The
WebView2 profile lives under `FOLDERID_LocalAppDataLow`.

`IPreviewHandlerVisuals` is not implemented: the pane keeps the
document's own typography and colours.

## Rationale

**Declarative beats self-registration here** because the MSI gets
transactional install *and uninstall* for free — a registry component is
reversed by Windows Installer the same way a file is — and because
neither installer has to shell out to `regsvr32` at all, which removes
the impersonation and bitness traps above in one move. The cost is that
the key layout exists in two files. That cost is paid down by a test
rather than by discipline: `registration.rs` holds the identifiers
(CLSID, the `IPreviewHandler` shellex IID, the surrogate AppID, the four
extensions, the DLL file name) as constants and `include_str!`s both
installer files to assert that each one registers all of them, and that
the NSIS uninstall path — the only removal that is written by hand —
covers every extension the install path adds. An extension added to one
installer and not the other fails `cargo test` on every platform.

**Scope-following roots** mean there is one layout, not two. `HKMU` and
`SHCTX` are the same idea spelled in two languages, so the fragment and
the hooks stay line-for-line comparable, which is what makes the parity
test readable.

**The fragment API** is what makes the CSP possible. The preview host
renders files the user merely selected in Explorer, and
`chordsketch-render-html`'s own documentation asks consumers handling
untrusted input to add a CSP on top of its sanitisation of delegate
sections (`{start_of_svg}` et al.). `default-src 'none'` gives the pane
no script execution and no network egress; a tracking pixel in a
downloaded `.cho` cannot fire. Going through the fragment API rather
than string-editing the full-document output also means the body markup
and stylesheet stay byte-identical to the CLI's `--format html`, the
desktop app's `Export HTML…`, and the playground.

**LocalLow** is not a preference. WebView2 defaults its profile to the
directory of the hosting executable, which here is `prevhost.exe` in
`System32` — not writable at any integrity level. And Explorer runs the
preview host at low integrity for files that carry an untrusted-zone
mark, where `LocalLow` is the only per-user location a process may
write. One path covers both cases.

**Not implementing `IPreviewHandlerVisuals`** follows from what the
document is. `render_html_css` is a fixed light theme with explicit dark
text colours and no `body` background rule. Honouring Explorer's
`SetBackgroundColor` under a dark shell theme would paint a dark
background behind dark text; honouring `SetTextColor` would fight the
stylesheet's chord / lyric / annotation colours. The pane shows the song
exactly as every other ChordSketch surface renders it, which is the
renderer-parity answer as well as the legible one.

## Consequences

- The `.exe` installer registers the handler without administrator
  rights, which is the path most users take. The MSI registers it for
  the machine.
- Uninstall removes the handler. The NSIS path compares each
  extension's `shellex` value against our own CLSID before deleting it,
  so an application that has since claimed `.cho` keeps its
  registration.
- `apps/desktop/preview-handler` joins `apps/desktop/src-tauri` as a
  workspace member that is **not** a default member: it links the same
  WebView2 layer, which a bare contributor machine need not have. Both
  are still covered by the `--workspace` clippy / test / doc jobs,
  because everything outside the crate's platform-independent
  `document` module is `cfg(windows)`-gated and compiles away
  elsewhere. On the Windows cell of `ci.yml`'s test matrix the whole
  COM server is compiled and linked on every PR.
- Images referenced by `{image}` do not render in the pane. Documents
  are loaded with `NavigateToString`, so they have an opaque origin and
  no base URL to resolve a relative path against; the CSP states that
  limit rather than leaving it to chance.
- The DLL is built by `apps/desktop/scripts/build-preview-handler.mjs`
  as `build.beforeBundleCommand` on Windows and staged where
  `bundle.resources` can pick it up. A Windows bundle now builds two
  Rust artifacts.
- The CLSID `{32E65E30-8242-492F-9985-C7785BB38BC7}` is frozen. Changing
  it orphans the keys written by every installer already in the field.

## Alternatives considered

**Self-registering DLL invoked by both installers.** One definition of
the key layout instead of two. Rejected for the impersonation, bitness,
and rollback problems in Context — all three are silent failures that
produce an installed application whose preview pane simply never
appears.

**Render with GDI from `chordsketch-render-text`.** No WebView2
dependency and no profile directory. Rejected: it makes the preview a
fifth rendering of a ChordPro song with its own layout engine, which is
exactly what `renderer-parity.md` exists to prevent, and it discards the
chord-over-lyrics typography that makes the preview worth having.

**Drive WebView2 through `webview2-com` directly instead of `wry`.**
More control over the environment-creation callbacks. Rejected: the
asynchronous environment / controller creation and its message pumping
is accidental complexity that `wry` already solves, and `wry` is
already in the lockfile as a Tauri dependency, so the DLL and the app
share one copy.

**Registering under the ProgID rather than the extension key.**
Microsoft's walkthrough hangs `shellex` off a ProgID. Rejected: the four
ChordPro extensions have no ChordSketch ProgID today (`fileAssociations`
in `tauri.conf.json` covers only `.irealb` / `.irealbook`), and creating
one would mean claiming the file type's default-program association as a
side effect of installing a preview handler.

**Setting `DisableLowILProcessIsolation` on the CLSID.** Would let the
preview host run at the user's integrity level, removing any doubt about
WebView2 under low integrity. Rejected: it removes the sandbox that
exists precisely because the file being previewed is untrusted, and the
`LocalLow` profile addresses the writability problem without giving up
the isolation.

## References

- [How to Register a Preview Handler](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-register-a-preview-handler) — key layout, the `prevhost.exe` surrogate AppIDs, and the HKLM-vs-HKCU rule this ADR follows.
- `apps/desktop/preview-handler/README.md` — the registry layout as installed, and how to verify the handler on a real machine.
- `.claude/rules/renderer-parity.md` — why the pane renders through `chordsketch-render-html` rather than a fifth implementation.
- `.claude/rules/fix-propagation.md` — the sister-site discipline the WiX / NSIS parity test implements.
- `packaging/linux/README.md` — the Linux half of `#861`, and why it ships standalone instead of inside an installer.
