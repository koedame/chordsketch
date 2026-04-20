//! Golden tests for the PDF renderer.
//!
//! Discovers every subdirectory under `tests/fixtures/` that contains an
//! `input.cho`, parses it through [`chordsketch_core::parse`], renders via
//! [`chordsketch_render_pdf::render_song`], and compares the result against
//! a snapshot.
//!
//! # Snapshot modes
//!
//! Each fixture declares its mode by which expected file it ships:
//!
//! - `expected.pdf` — **byte-exact**. The PDF renderer is deterministic (no
//!   clock, no RNG, stable map orderings), so byte-for-byte comparison is
//!   the tightest primitive and the default for ASCII-only input.
//! - `expected.txt` — **text-extraction**. Runs `pdf-extract` on the
//!   rendered bytes and compares against the snapshot. Used for inputs
//!   that trigger the bundled NotoSansCJK subset (any non-Latin1
//!   character), because byte-exact snapshots would commit ~6 MB of font
//!   data per fixture. See #1983 for the rationale.
//!
//! A fixture may ship either, but not both. If neither exists at test
//! time, the harness panics with a clear hint to run UPDATE_GOLDEN.
//!
//! # Regeneration
//!
//! ```sh
//! UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden
//! ```
//!
//! The env var preserves whichever expected format already exists. For a
//! brand-new fixture, create an empty `expected.pdf` or `expected.txt`
//! first to declare the mode, then run UPDATE_GOLDEN.
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

/// Which comparison mode a fixture uses, inferred from the expected file
/// it ships.
enum Mode {
    /// Byte-exact PDF comparison (`expected.pdf`).
    Pdf,
    /// Extract the PDF's text layer via `pdf-extract` and compare against
    /// `expected.txt`. Used when the input triggers the bundled NotoSansCJK
    /// subset font (#1983).
    Text,
}

fn detect_mode(fixture_dir: &Path) -> Mode {
    let pdf = fixture_dir.join("expected.pdf");
    let txt = fixture_dir.join("expected.txt");
    match (pdf.exists(), txt.exists()) {
        (true, true) => panic!(
            "fixture {} has both expected.pdf and expected.txt; pick one mode",
            fixture_dir.display()
        ),
        (true, false) => Mode::Pdf,
        (false, true) => Mode::Text,
        // Neither file exists. The maintainer intent is ambiguous — this
        // could be a fresh fixture that hasn't been primed with its mode
        // marker, or an accidentally deleted snapshot. Panic under
        // UPDATE_GOLDEN with a clear hint rather than defaulting to PDF and
        // surfacing a less helpful I/O error later from `compare_pdf_bytes`.
        (false, false) => {
            if std::env::var("UPDATE_GOLDEN").is_ok() {
                // Default to PDF mode only when the maintainer has opted
                // into regeneration. Still warn so fresh fixtures are named
                // intentionally rather than falling into a default silently.
                eprintln!(
                    "[{}] no expected file present; creating expected.pdf (create an empty expected.txt before UPDATE_GOLDEN to opt into text-extraction mode)",
                    fixture_dir.display()
                );
                Mode::Pdf
            } else {
                panic!(
                    "fixture {} has neither expected.pdf nor expected.txt; create an empty expected.pdf or expected.txt to declare the mode and run `UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden`",
                    fixture_dir.display()
                );
            }
        }
    }
}

/// Line-level diff for text-extraction mode, mirroring the helper in the
/// render-text golden harness so failure output is familiar.
fn diff_strings(expected: &str, actual: &str) -> Option<String> {
    let expected_lines: Vec<&str> = expected.lines().collect();
    let actual_lines: Vec<&str> = actual.lines().collect();
    if expected_lines == actual_lines {
        return None;
    }
    let mut out = String::new();
    let max_len = expected_lines.len().max(actual_lines.len());
    for i in 0..max_len {
        match (expected_lines.get(i), actual_lines.get(i)) {
            (Some(e), Some(a)) if e == a => out.push_str(&format!("  {:4} | {e}\n", i + 1)),
            (Some(e), Some(a)) => {
                out.push_str(&format!("- {:4} | {e}\n", i + 1));
                out.push_str(&format!("+ {:4} | {a}\n", i + 1));
            }
            (Some(e), None) => out.push_str(&format!("- {:4} | {e}\n", i + 1)),
            (None, Some(a)) => out.push_str(&format!("+ {:4} | {a}\n", i + 1)),
            (None, None) => unreachable!(),
        }
    }
    Some(out)
}

fn run_golden_test(fixture_dir: &Path) {
    let name = fixture_dir
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let input_path = fixture_dir.join("input.cho");
    let input = fs::read_to_string(&input_path)
        .unwrap_or_else(|e| panic!("[{name}] cannot read {}: {e}", input_path.display()));

    let song =
        chordsketch_core::parse(&input).unwrap_or_else(|e| panic!("[{name}] parse error: {e}"));
    let actual_pdf = chordsketch_render_pdf::render_song(&song);

    assert!(
        !actual_pdf.is_empty(),
        "[{name}] PDF renderer returned zero bytes"
    );
    assert!(
        actual_pdf.starts_with(b"%PDF-"),
        "[{name}] output does not start with the PDF magic header"
    );

    match detect_mode(fixture_dir) {
        Mode::Pdf => compare_pdf_bytes(fixture_dir, &name, &actual_pdf),
        Mode::Text => compare_extracted_text(fixture_dir, &name, &actual_pdf),
    }
}

fn compare_pdf_bytes(fixture_dir: &Path, name: &str, actual: &[u8]) {
    let expected_path = fixture_dir.join("expected.pdf");

    if std::env::var("UPDATE_GOLDEN").is_ok() {
        fs::write(&expected_path, actual)
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
            diff_context(&expected, actual),
        );
    }
}

fn compare_extracted_text(fixture_dir: &Path, name: &str, pdf_bytes: &[u8]) {
    let expected_path = fixture_dir.join("expected.txt");

    let extracted = pdf_extract::extract_text_from_mem(pdf_bytes)
        .unwrap_or_else(|e| panic!("[{name}] pdf-extract failed: {e}"));

    if std::env::var("UPDATE_GOLDEN").is_ok() {
        fs::write(&expected_path, &extracted)
            .unwrap_or_else(|e| panic!("[{name}] cannot write {}: {e}", expected_path.display()));
        eprintln!("[{name}] updated {}", expected_path.display());
        return;
    }

    let expected = fs::read_to_string(&expected_path).unwrap_or_else(|e| {
        panic!(
            "[{name}] cannot read {} (run `UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden` to create it): {e}",
            expected_path.display()
        )
    });

    if let Some(diff) = diff_strings(&expected, &extracted) {
        panic!(
            "\n\ngolden test '{name}' (text-extraction mode) failed!\n\
             \n\
             Fixture: {}\n\
             Expected file: {}\n\
             \n\
             Diff (- expected, + actual):\n\
             {diff}\n\
             \n\
             If this change is intentional, run:\n\
             UPDATE_GOLDEN=1 cargo test -p chordsketch-render-pdf --test golden\n",
            fixture_dir.display(),
            expected_path.display(),
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
