#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use chordsketch_chordpro::config::Config;
use chordsketch_chordpro::parse_multi_lenient;
use chordsketch_chordpro::render_result::RenderResult;

/// Max ChordPro source size the editor will open from disk. 10 MiB
/// comfortably fits the largest hymnal transcriptions in the test
/// corpus (hundreds of songs concatenated) while rejecting anything
/// big enough to wedge the `<textarea>` on modest hardware. Lets the
/// command fail fast with a readable error instead of a WebView hang.
const MAX_OPEN_SIZE_BYTES: u64 = 10 * 1024 * 1024;

/// Upper bound on the ChordPro source length that `export_pdf` and
/// `export_html` accept from the WebView. Matches `MAX_OPEN_SIZE_BYTES`
/// — a user who cannot open a file larger than 10 MiB cannot reach the
/// export path with one either, so keeping the two limits identical is
/// the least-surprising contract. Per `.claude/rules/code-style.md`
/// ("Resource Limits"): the `parse_multi_lenient` + renderer pipeline
/// has no internal cap, so the boundary check lives here at the Tauri
/// command entry point.
const MAX_EXPORT_CHORDPRO_BYTES: usize = 10 * 1024 * 1024;

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
    if chordpro.len() > MAX_EXPORT_CHORDPRO_BYTES {
        return Err(format!(
            "ChordPro source is too large to export ({} bytes > {} bytes)",
            chordpro.len(),
            MAX_EXPORT_CHORDPRO_BYTES
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
/// string to the frontend. Enforces `MAX_OPEN_SIZE_BYTES` during a
/// single opened-handle read so a stray 2 GB binary selected in the
/// file picker fails fast with a readable error, rather than a
/// multi-minute WebView hang.
///
/// Uses `File::open` + `BufReader::take(MAX + 1)` so the size
/// check is TOCTOU-safe per `.claude/rules/defensive-inputs.md`
/// ("Never check a resource then act on it in separate steps. Use
/// atomic operations… Prefer passing already-opened handles"). A
/// separate `metadata()`-then-`read_to_string()` pair leaves a race
/// window where a co-process can grow the file past the limit
/// after the stat but before the read.
///
/// Trust model: not capability-gated; see `save_file`'s doc comment
/// and ADR-0006. WebView code can read any path the running user
/// has read access to.
#[tauri::command]
fn open_file(path: String) -> Result<String, String> {
    if path.is_empty() {
        return Err("Refusing to open: source path is empty".to_string());
    }
    let p = Path::new(&path);
    let file = File::open(p).map_err(|e| format!("Failed to open {path}: {e}"))?;
    // `take(MAX + 1)` lets us distinguish "exactly at the limit" (OK)
    // from "over the limit" (reject) in a single read.
    let mut reader = BufReader::new(file).take(MAX_OPEN_SIZE_BYTES + 1);
    let mut buf = String::new();
    reader
        .read_to_string(&mut buf)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    if buf.len() as u64 > MAX_OPEN_SIZE_BYTES {
        return Err(format!("File is too large (> {MAX_OPEN_SIZE_BYTES} bytes)"));
    }
    Ok(buf)
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            export_pdf,
            export_html,
            open_file,
            save_file,
        ])
        .run(tauri::generate_context!())
        // `expect` is justified: this is process entry — if the Tauri
        // runtime cannot start, there is no application to recover
        // into, so panicking out is the correct terminal behavior.
        .expect("error while running ChordSketch desktop application");
}
