#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Proof of workspace wiring (AC of #2069). The editor preview drives
// the parser in follow-ups (#2071 split-pane editor, #2074 export
// dialog); until then, `as _` keeps the linkage live so the crate's
// `[lints.rust] unused_crate_dependencies = "warn"` fires if the link
// is removed without replacement.
use chordsketch_chordpro as _;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        // `expect` is justified: this is process entry — if the Tauri
        // runtime cannot start, there is no application to recover
        // into, so panicking out is the correct terminal behavior.
        .expect("error while running ChordSketch desktop application");
}
