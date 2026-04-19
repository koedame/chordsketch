//! Golden tests for the PDF renderer.
//!
//! Discovers every subdirectory under `tests/fixtures/` that contains an
//! `input.cho`, parses it through [`chordsketch_core::parse`], renders via
//! [`chordsketch_render_pdf::render_song`], and compares the resulting bytes
//! against an `expected.pdf` snapshot.
//!
//! The PDF renderer is deterministic (no clock, no RNG, stable map
//! orderings), so byte-exact comparison is the right primitive. When the
//! renderer's output changes intentionally, regenerate the snapshots with:
//!
//! ```sh
//! UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden
//! ```
//!
//! Each fixture deliberately mirrors an existing `render-text` fixture so
//! sister-site parity (see `.claude/rules/renderer-parity.md`) can be
//! verified by cross-referencing fixture names.

use std::fs;
use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn discover_fixtures() -> Vec<PathBuf> {
    let dir = fixtures_dir();
    let mut fixtures: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read fixtures directory {}: {}", dir.display(), e))
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() && path.join("input.cho").exists() {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    fixtures.sort();
    fixtures
}

/// Formats a short hex dump around the first differing byte, giving humans
/// enough context to tell whether a diff is stream content, an offset
/// pointer, or a length field.
fn diff_context(expected: &[u8], actual: &[u8]) -> String {
    let mismatch = expected
        .iter()
        .zip(actual.iter())
        .position(|(e, a)| e != a)
        .unwrap_or_else(|| expected.len().min(actual.len()));

    let window = 32usize;
    let start = mismatch.saturating_sub(window);
    let end_e = (mismatch + window).min(expected.len());
    let end_a = (mismatch + window).min(actual.len());

    let hex = |bytes: &[u8]| -> String {
        bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(" ")
    };

    format!(
        "first differing byte: offset {mismatch}\n\
         expected len: {}\n\
         actual   len: {}\n\
         expected [{start}..{end_e}]: {}\n\
         actual   [{start}..{end_a}]: {}\n",
        expected.len(),
        actual.len(),
        hex(&expected[start..end_e]),
        hex(&actual[start..end_a]),
    )
}

fn run_golden_test(fixture_dir: &Path) {
    let name = fixture_dir
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let input_path = fixture_dir.join("input.cho");
    let expected_path = fixture_dir.join("expected.pdf");

    let input = fs::read_to_string(&input_path)
        .unwrap_or_else(|e| panic!("[{name}] cannot read {}: {e}", input_path.display()));

    let song =
        chordsketch_core::parse(&input).unwrap_or_else(|e| panic!("[{name}] parse error: {e}"));
    let actual = chordsketch_render_pdf::render_song(&song);

    assert!(
        !actual.is_empty(),
        "[{name}] PDF renderer returned zero bytes"
    );
    assert!(
        actual.starts_with(b"%PDF-"),
        "[{name}] output does not start with the PDF magic header"
    );

    if std::env::var("UPDATE_GOLDEN").is_ok() {
        fs::write(&expected_path, &actual)
            .unwrap_or_else(|e| panic!("[{name}] cannot write {}: {e}", expected_path.display()));
        eprintln!("[{name}] updated {}", expected_path.display());
        return;
    }

    let expected = fs::read(&expected_path).unwrap_or_else(|e| {
        panic!(
            "[{name}] cannot read {} (run `UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden` to create it): {e}",
            expected_path.display()
        )
    });

    if expected != actual {
        panic!(
            "\n\ngolden test '{name}' failed!\n\
             \n\
             Fixture: {}\n\
             Expected file: {}\n\
             \n\
             {}\n\
             If this change is intentional, run:\n\
             UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden\n",
            fixture_dir.display(),
            expected_path.display(),
            diff_context(&expected, &actual),
        );
    }
}

#[test]
fn golden_tests() {
    let fixtures = discover_fixtures();
    assert!(
        !fixtures.is_empty(),
        "no golden test fixtures found in {}",
        fixtures_dir().display()
    );

    let mut failures = Vec::new();
    for fixture in &fixtures {
        let name = fixture.file_name().unwrap().to_string_lossy().to_string();
        let result = std::panic::catch_unwind(|| run_golden_test(fixture));
        if let Err(e) = result {
            let msg = if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                (*s).to_string()
            } else {
                "unknown panic".to_string()
            };
            failures.push((name, msg));
        }
    }

    if !failures.is_empty() {
        let mut report = format!("\n{} golden test(s) failed:\n", failures.len());
        for (name, msg) in &failures {
            report.push_str(&format!("\n--- {name} ---\n{msg}\n"));
        }
        panic!("{report}");
    }

    eprintln!("all {} golden test(s) passed", fixtures.len());
}

/// Guards the determinism assumption that underlies byte-exact PDF
/// snapshots. If a future change introduces a clock read, RNG, or unstable
/// map order into the PDF pipeline, this test fails loudly instead of
/// snapshot updates silently drifting every run.
#[test]
fn pdf_output_is_deterministic() {
    let input = "{title: Determinism Check}\n\n[C]Hello [G]world\n";
    let song = chordsketch_core::parse(input).expect("parse");
    let a = chordsketch_render_pdf::render_song(&song);
    let b = chordsketch_render_pdf::render_song(&song);
    assert_eq!(a, b, "PDF renderer is not deterministic");
}
