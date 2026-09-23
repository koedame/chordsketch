//! OS file-manager previews for ChordPro files.
//!
//! Draws `.cho` / `.chopro` / `.crd` / `.chordpro` files in:
//!
//! - **Windows** File Explorer's preview pane, as an in-process COM
//!   server (`chordsketch_preview_handler.dll`) that Explorer loads
//!   into its `prevhost.exe` surrogate. The installers own the registry
//!   registration.
//! - **macOS** Finder's Quick Look (Space), as a static library linked
//!   into a Quick Look preview extension that the app bundle embeds.
//!
//! Both ship inside the ChordSketch desktop app. See
//! `apps/desktop/preview-handler/README.md` for the registry layout,
//! the bundle layout, the build wiring, and how to verify each preview
//! on a real machine.
//!
//! The crate is split so that the part worth testing does not depend on
//! the platform:
//!
//! - [`document`] turns file bytes into the HTML both previews render.
//!   It compiles and is unit-tested on every CI runner.
//! - [`registration`] holds the identifiers Explorer looks the handler
//!   up by, and asserts that both installer definitions agree with them.
//! - [`quicklook`] holds the identifiers macOS looks the extension up
//!   by, asserts that the property lists agree with them, and — on
//!   macOS only — exports the C ABI the Swift extension calls.
//! - `shell` (private, `cfg(windows)`) is the COM plumbing: it moves
//!   bytes from the shell's `IStream` into [`document`] and the
//!   resulting HTML into a WebView2 control.
//!
//! Everything platform-specific is `cfg`-gated, so `cargo clippy
//! --workspace` / `cargo test --workspace` stay green on every cell.

pub mod document;
pub mod quicklook;
pub mod registration;

#[cfg(windows)]
mod shell;
