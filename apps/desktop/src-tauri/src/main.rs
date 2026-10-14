#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use chordsketch_chordpro::config::Config;
use chordsketch_chordpro::input_limit::{
    MAX_INPUT_BYTES, ReadLimitedError, read_to_string_limited,
};
use chordsketch_chordpro::parse_multi_lenient;
use chordsketch_chordpro::render_result::RenderResult;

/// Parse the supplied ChordPro source, render every song it contains
/// with the requested transposition, and write the result to `path`.
/// Returns the collected render-side warnings so the frontend can
/// surface them to the user (#2201).
///
/// Called by the renderer-specific command wrappers below. Extracting
/// the parse + render pipeline here keeps the two commands
/// byte-for-byte equivalent apart from the format choice, so a fix
/// to one (e.g. transpose-clamp behaviour, parse-warnings surface,
/// error message format) does not drift against the other — see
/// `.claude/rules/fix-propagation.md` for the sister-site rationale.
///
/// Warning parity with the WASM path (playground / desktop live
/// preview): both use each renderer's `render_songs_with_warnings`
/// variant, so the warning messages and ordering are identical across
/// browser, in-process desktop export, and the CLI (see
/// `crates/wasm/src/lib.rs` `flush_warnings`). Parser warnings are not
/// included — `parse_multi_lenient` never returns structured warnings,
/// only per-line errors that are flushed into the partial AST, and the
/// CLI/WASM paths do not surface those either.
///
/// Trust model: the callers (`export_pdf` / `export_html`) are not
/// capability-gated; see `save_file`'s doc comment and ADR-0006.
fn render_and_write<R>(
    path: &str,
    chordpro: &str,
    transpose: i8,
    render: R,
) -> Result<Vec<String>, String>
where
    R: Fn(&[chordsketch_chordpro::ast::Song], i8, &Config) -> RenderResult<Vec<u8>>,
{
    if path.is_empty() {
        return Err("Refusing to write: destination path is empty".to_string());
    }
    // Per `.claude/rules/code-style.md` ("Resource Limits"): the
    // `parse_multi_lenient` + renderer pipeline has no internal cap, so the
    // boundary check lives here at the Tauri command entry point. The limit
    // is the one `open_file` enforces: a user who cannot open a larger file
    // cannot reach the export path with one either.
    if chordpro.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "ChordPro source is too large to export ({} bytes > {} bytes)",
            chordpro.len(),
            MAX_INPUT_BYTES
        ));
    }
    let config = Config::defaults();
    let parse_result = parse_multi_lenient(chordpro);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    let result = render(&songs, transpose, &config);
    fs::write(path, result.output).map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(result.warnings)
}

/// Renders `chordpro` to PDF with the optional `transpose` offset and
/// writes the bytes to `path`. The renderer is the in-process
/// `chordsketch-render-pdf` crate, not the WASM module — satisfies
/// AC3 of #2074. Returns the renderer's captured warnings so the
/// frontend can surface them in the Export dialog (#2201).
#[tauri::command]
fn export_pdf(
    path: String,
    chordpro: String,
    transpose: Option<i8>,
) -> Result<Vec<String>, String> {
    render_and_write(
        &path,
        &chordpro,
        transpose.unwrap_or(0),
        chordsketch_render_pdf::render_songs_with_warnings,
    )
}

/// Renders `chordpro` to HTML with the optional `transpose` offset
/// and writes the string to `path`. As with `export_pdf`, the
/// renderer is the in-process `chordsketch-render-html` crate.
/// Returns the renderer's captured warnings so the frontend can
/// surface them in the Export dialog (#2201).
#[tauri::command]
fn export_html(
    path: String,
    chordpro: String,
    transpose: Option<i8>,
) -> Result<Vec<String>, String> {
    render_and_write(
        &path,
        &chordpro,
        transpose.unwrap_or(0),
        |songs, t, config| {
            let r = chordsketch_render_html::render_songs_with_warnings(songs, t, config);
            RenderResult::with_warnings(r.output.into_bytes(), r.warnings)
        },
    )
}

/// Reads the ChordPro source at `path` and returns it as a UTF-8
/// string to the frontend. Enforces [`MAX_INPUT_BYTES`] during a single
/// opened-handle read so a stray 2 GB binary selected in the file picker
/// fails fast with a readable error, rather than a multi-minute WebView
/// hang.
///
/// The size check is TOCTOU-safe per `.claude/rules/defensive-inputs.md`
/// ("Never check a resource then act on it in separate steps. Use
/// atomic operations… Prefer passing already-opened handles"): the file
/// is opened once and read through
/// [`read_to_string_limited`], so a co-process cannot grow it past the
/// limit between a stat and the read.
///
/// Trust model: not capability-gated; see `save_file`'s doc comment
/// and ADR-0006. WebView code can read any path the running user
/// has read access to.
#[tauri::command]
fn open_file(path: String) -> Result<String, String> {
    if path.is_empty() {
        return Err("Refusing to open: source path is empty".to_string());
    }
    let file = File::open(Path::new(&path)).map_err(|e| format!("Failed to open {path}: {e}"))?;
    read_to_string_limited(BufReader::new(file), MAX_INPUT_BYTES).map_err(|e| match e {
        ReadLimitedError::TooLarge { limit } => format!("File is too large (> {limit} bytes)"),
        other => format!("Failed to read {path}: {other}"),
    })
}

/// Writes `content` to `path`, overwriting any existing file. Used
/// by the File → Save / Save As menu items; the frontend is
/// responsible for dialog-driven destination selection; an empty
/// `path` is rejected immediately to produce a clear error rather
/// than a confusing OS-level "No such file" message.
///
/// Trust model: this command is not capability-gated (Tauri v2's
/// capability system does not apply to `invoke_handler!`-registered
/// commands). The WebView is trusted to call this with a
/// user-approved path because the WebView loads only from the local
/// Vite build under the CSP documented in `tauri.conf.json`. See
/// ADR-0006 for the full rationale and the revisit triggers.
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("Refusing to write: destination path is empty".to_string());
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Whether this installation updates itself through the Tauri updater.
///
/// Not inside a Flatpak sandbox: there the application lives on a
/// read-only `/app`, and the store it was installed from delivers every
/// new version, so an in-app updater could neither install nor should
/// it try. Flatpak writes `/.flatpak-info` into every sandbox
/// (flatpak-metadata(5)).
///
/// Not in a build compiled by a package manager that upgrades it itself:
/// the Homebrew formula sets `CHORDSKETCH_NO_SELF_UPDATE` while building,
/// and an updater replacing that build with the prebuilt release would
/// undo what `brew upgrade` manages.
fn self_updates() -> bool {
    updates_itself(
        option_env!("CHORDSKETCH_NO_SELF_UPDATE").is_some(),
        Path::new("/.flatpak-info").exists(),
    )
}

fn updates_itself(built_without_updater: bool, in_flatpak: bool) -> bool {
    !built_without_updater && !in_flatpak
}

/// Tells the frontend whether to run the update check loop. See
/// [`self_updates`].
#[tauri::command]
fn self_update_enabled() -> bool {
    self_updates()
}

fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // `tauri-plugin-opener` exposes `openUrl()` to the frontend
        // so the Help → "Visit project homepage" menu item can hand
        // the URL off to the OS default browser. Scoped via the
        // capability allowlist to the project homepage only (#2199).
        .plugin(tauri_plugin_opener::init());
    if self_updates() {
        builder = builder
            // `tauri-plugin-updater` lets the frontend call `check()` /
            // `downloadAndInstall()` against the release manifest at the
            // endpoint configured in `tauri.conf.json`. Signatures are
            // verified against the bundled `pubkey` before install, so
            // a compromised GitHub Release CDN cannot push rogue updates.
            // See ADR-0005 (#2076).
            .plugin(tauri_plugin_updater::Builder::new().build())
            // `tauri-plugin-process` exposes `relaunch()` to the
            // frontend so the user can restart the app after the
            // updater installs a new version.
            .plugin(tauri_plugin_process::init());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            export_pdf,
            export_html,
            open_file,
            save_file,
            self_update_enabled,
        ])
        .run(tauri::generate_context!())
        // `expect` is justified: this is process entry — if the Tauri
        // runtime cannot start, there is no application to recover
        // into, so panicking out is the correct terminal behavior.
        .expect("error while running ChordSketch desktop application");
}

#[cfg(test)]
mod tests {
    use super::{MAX_INPUT_BYTES, open_file, render_and_write, updates_itself};
    use chordsketch_chordpro::render_result::RenderResult;
    use std::path::PathBuf;

    /// A file under the temp dir, removed on drop, named per test so the
    /// parallel test threads never share one.
    struct TempFile(PathBuf);

    impl TempFile {
        fn with_len(name: &str, len: usize) -> Self {
            let path = std::env::temp_dir().join(format!(
                "chordsketch-desktop-{}-{name}.cho",
                std::process::id()
            ));
            std::fs::write(&path, vec![b'a'; len]).expect("write temp file");
            Self(path)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn opening_a_file_within_the_limit_returns_its_text() {
        let file = TempFile::with_len("small", 12);
        assert_eq!(open_file(file.path()).unwrap(), "a".repeat(12));
    }

    #[test]
    fn opening_a_file_of_exactly_the_limit_succeeds() {
        let file = TempFile::with_len("exact", MAX_INPUT_BYTES);
        assert_eq!(open_file(file.path()).unwrap().len(), MAX_INPUT_BYTES);
    }

    #[test]
    fn opening_a_file_one_byte_over_the_limit_is_refused_with_a_readable_error() {
        let file = TempFile::with_len("over", MAX_INPUT_BYTES + 1);
        let err = open_file(file.path()).unwrap_err();
        assert_eq!(
            err,
            format!("File is too large (> {MAX_INPUT_BYTES} bytes)")
        );
    }

    #[test]
    fn opening_an_empty_path_or_a_missing_file_is_refused() {
        assert!(open_file(String::new()).unwrap_err().contains("empty"));
        let missing = std::env::temp_dir().join("chordsketch-desktop-no-such-file.cho");
        let err = open_file(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.starts_with("Failed to open "), "{err}");
    }

    #[test]
    fn exporting_a_source_over_the_limit_is_refused_before_anything_is_written() {
        let source = "a".repeat(MAX_INPUT_BYTES + 1);
        let target = std::env::temp_dir().join(format!(
            "chordsketch-desktop-{}-export.pdf",
            std::process::id()
        ));
        let err = render_and_write(&target.to_string_lossy(), &source, 0, |_, _, _| {
            RenderResult::new(Vec::new())
        })
        .unwrap_err();
        assert!(err.contains("too large to export"), "{err}");
        assert!(
            !target.exists(),
            "nothing may be written for a refused source"
        );
    }

    #[test]
    fn a_plain_build_outside_a_sandbox_updates_itself() {
        assert!(updates_itself(false, false));
    }

    #[test]
    fn a_build_made_without_the_updater_does_not_update_itself() {
        assert!(!updates_itself(true, false));
    }

    #[test]
    fn a_build_inside_a_flatpak_does_not_update_itself() {
        assert!(!updates_itself(false, true));
    }
}
