#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Proof of workspace wiring: the editor preview will drive the parser in
// follow-up issues (#2071 split-pane editor, #2074 export dialog). The
// `as _` import keeps the linkage without triggering the unused-crate-
// dependencies lint while the AST is not yet consumed.
use chordsketch_chordpro as _;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ChordSketch desktop application");
}
