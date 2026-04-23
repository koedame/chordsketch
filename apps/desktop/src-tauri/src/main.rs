#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::Path;

use chordsketch_chordpro::config::Config;
use chordsketch_chordpro::parse_multi_lenient;

/// Max ChordPro source size the editor will open from disk. 10 MiB
/// comfortably fits the largest hymnal transcriptions in the test
/// corpus (hundreds of songs concatenated) while rejecting anything
/// big enough to wedge the `<textarea>` on modest hardware. Lets the
/// command fail fast with a readable error instead of a WebView hang.
const MAX_OPEN_SIZE_BYTES: u64 = 10 * 1024 * 1024;

/// Parse the supplied ChordPro source, render every song it contains
/// with the requested transposition, and write the result to `path`.
///
/// Called by the renderer-specific command wrappers below. Extracting
/// the parse + render pipeline here keeps the two commands
/// byte-for-byte equivalent apart from the format choice, so a fix
/// to one (e.g. transpose-clamp behaviour, parse-warnings surface,
/// error message format) does not drift against the other — see
/// `.claude/rules/fix-propagation.md` for the sister-site rationale.
fn render_and_write<R>(path: &str, chordpro: &str, transpose: i8, render: R) -> Result<(), String>
where
    R: Fn(&[chordsketch_chordpro::ast::Song], i8, &Config) -> Vec<u8>,
{
    let config = Config::defaults();
    let parse_result = parse_multi_lenient(chordpro);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    let bytes = render(&songs, transpose, &config);
    fs::write(path, bytes).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Renders `chordpro` to PDF with the optional `transpose` offset and
/// writes the bytes to `path`. The renderer is the in-process
/// `chordsketch-render-pdf` crate, not the WASM module — satisfies
/// AC3 of #2074.
#[tauri::command]
fn export_pdf(path: String, chordpro: String, transpose: Option<i8>) -> Result<(), String> {
    render_and_write(
        &path,
        &chordpro,
        transpose.unwrap_or(0),
        chordsketch_render_pdf::render_songs_with_transpose,
    )
}

/// Renders `chordpro` to HTML with the optional `transpose` offset
/// and writes the string to `path`. As with `export_pdf`, the
/// renderer is the in-process `chordsketch-render-html` crate.
#[tauri::command]
fn export_html(path: String, chordpro: String, transpose: Option<i8>) -> Result<(), String> {
    render_and_write(
        &path,
        &chordpro,
        transpose.unwrap_or(0),
        |songs, t, config| {
            chordsketch_render_html::render_songs_with_transpose(songs, t, config).into_bytes()
        },
    )
}

/// Reads the ChordPro source at `path` and returns it as a UTF-8
/// string to the frontend. Enforces `MAX_OPEN_SIZE_BYTES` before the
/// full read so a stray 2 GB binary selected in the file picker
/// fails fast with a readable error, rather than a multi-minute
/// WebView hang while `editor.value = "…"` digests the payload.
#[tauri::command]
fn open_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("Failed to stat {path}: {e}"))?;
    if meta.len() > MAX_OPEN_SIZE_BYTES {
        return Err(format!(
            "File is too large ({} bytes; limit {} bytes)",
            meta.len(),
            MAX_OPEN_SIZE_BYTES,
        ));
    }
    fs::read_to_string(p).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Writes `content` to `path`, overwriting any existing file. Used
/// by the File → Save / Save As menu items; the frontend is
/// responsible for dialog-driven destination selection so this
/// command does no extra validation beyond the IO error surface.
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
