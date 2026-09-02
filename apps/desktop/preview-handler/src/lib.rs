//! Windows Explorer preview handler for ChordPro files.
//!
//! Builds an in-process COM server (`chordsketch_preview_handler.dll`)
//! that Explorer loads into its `prevhost.exe` surrogate to draw
//! `.cho` / `.chopro` / `.crd` / `.chordpro` files in the preview pane.
//! The DLL ships inside the ChordSketch desktop installer; the
//! installers own the registry registration. See
//! `apps/desktop/preview-handler/README.md` for the registry layout,
//! the build wiring, and how to verify the handler on a real machine.
//!
//! The crate is split so that the part worth testing does not depend on
//! the platform:
//!
//! - [`document`] turns file bytes into the HTML the pane renders. It
//!   compiles and is unit-tested on every CI runner.
//! - [`registration`] holds the identifiers Explorer looks the handler
//!   up by, and asserts that both installer definitions agree with them.
//! - `shell` (private, `cfg(windows)`) is the COM plumbing: it moves
//!   bytes from the shell's `IStream` into [`document`] and the
//!   resulting HTML into a WebView2 control.
//!
//! On non-Windows targets everything below the first two modules
//! compiles away, so `cargo clippy --workspace` / `cargo test
//! --workspace` stay green on the Linux and macOS cells.

pub mod document;
pub mod registration;

#[cfg(windows)]
mod shell;
