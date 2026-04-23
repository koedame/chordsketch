#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;

use chordsketch_chordpro::config::Config;
use chordsketch_chordpro::parse_multi_lenient;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_pdf, export_html])
        .run(tauri::generate_context!())
        // `expect` is justified: this is process entry — if the Tauri
        // runtime cannot start, there is no application to recover
        // into, so panicking out is the correct terminal behavior.
        .expect("error while running ChordSketch desktop application");
}
