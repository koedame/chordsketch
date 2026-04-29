//! Integration tests for the `chordsketch` CLI binary.

use assert_cmd::Command;
use predicates::prelude::*;
use std::io::Write;
use std::path::Path;
use tempfile::NamedTempFile;

/// Returns the path to a test fixture file.
fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .to_string_lossy()
        .to_string()
}

#[test]
fn test_render_to_stdout() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg(fixture("simple.cho"))
        .assert()
        .success()
        .stdout(predicate::str::contains("Simple Song"))
        .stdout(predicate::str::contains("G     C"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_output_to_file() {
    let output_file = NamedTempFile::new().unwrap();
    let output_path = output_file.path().to_string_lossy().to_string();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), "-o", &output_path])
        .assert()
        .success()
        .stdout(predicate::str::is_empty());

    let content = std::fs::read_to_string(&output_path).unwrap();
    assert!(content.contains("Simple Song"));
    assert!(content.contains("Hello world"));
}

#[test]
fn test_nonexistent_file() {
    // Use a NamedTempFile that is immediately dropped to guarantee
    // the path does not exist, avoiding TOCTOU risk with hardcoded paths.
    let nonexistent = {
        let f = NamedTempFile::new().unwrap();
        f.path().to_string_lossy().to_string()
    };
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg(&nonexistent)
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains(&nonexistent));
}

#[test]
fn test_parse_error() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg(fixture("invalid.cho"))
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains("parse error"));
}

#[test]
fn test_multiple_files() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), &fixture("second.cho")])
        .assert()
        .success()
        .stdout(predicate::str::contains("Simple Song"))
        .stdout(predicate::str::contains("Second Song"));
}

#[test]
fn test_multiple_files_with_error() {
    // One valid, one invalid — should output the valid one and exit non-zero.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), &fixture("invalid.cho")])
        .assert()
        .failure()
        .stdout(predicate::str::contains("Simple Song"))
        .stderr(predicate::str::contains("error:"));
}

#[test]
fn test_version_flag() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains("chordsketch"));
}

#[test]
fn test_help_flag() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Usage"))
        .stdout(predicate::str::contains("--output"))
        .stdout(predicate::str::contains("--format"))
        .stdout(predicate::str::contains("--transpose"));
}

#[test]
fn test_transpose_up() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), "--transpose", "2"])
        .assert()
        .success()
        .stdout(predicate::str::contains("A     D"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_transpose_down() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), "--transpose=-2"])
        .assert()
        .success()
        .stdout(predicate::str::contains("F     A#"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_transpose_down_space_form() {
    // Regression test for #1669: --transpose -2 (space-separated) was previously
    // rejected by clap 4 as an unknown short flag. Fixed by adding
    // allow_negative_numbers = true to the --transpose arg definition.
    // This test would fail if that attribute were removed.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), "--transpose", "-2"])
        .assert()
        .success()
        .stdout(predicate::str::contains("F     A#"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_transpose_zero_is_noop() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), "--transpose", "0"])
        .assert()
        .success()
        .stdout(predicate::str::contains("G     C"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_no_args_shows_error() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .assert()
        .failure()
        .stderr(predicate::str::contains("Usage"));
}

// --- HTML format ---

#[test]
fn test_format_html_stdout() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--format", "html", &fixture("simple.cho")])
        .assert()
        .success()
        .stdout(predicate::str::contains("<!DOCTYPE html>"))
        .stdout(predicate::str::contains("<h1>Simple Song</h1>"))
        .stdout(predicate::str::contains("chord-block"));
}

#[test]
fn test_format_html_output_file() {
    let output_file = NamedTempFile::new().unwrap();
    let output_path = output_file.path().to_string_lossy().to_string();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--format",
            "html",
            "-o",
            &output_path,
            &fixture("simple.cho"),
        ])
        .assert()
        .success();

    let content = std::fs::read_to_string(&output_path).unwrap();
    assert!(content.contains("<!DOCTYPE html>"));
}

// --- PDF format ---

#[test]
fn test_format_pdf_output_file() {
    let output_file = NamedTempFile::new().unwrap();
    let output_path = output_file.path().to_string_lossy().to_string();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--format",
            "pdf",
            "-o",
            &output_path,
            &fixture("simple.cho"),
        ])
        .assert()
        .success();

    let content = std::fs::read(&output_path).unwrap();
    assert!(content.starts_with(b"%PDF"));
}

#[test]
fn test_format_pdf_with_transpose() {
    let output_file = NamedTempFile::new().unwrap();
    let output_path = output_file.path().to_string_lossy().to_string();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--format",
            "pdf",
            "-t",
            "2",
            "-o",
            &output_path,
            &fixture("simple.cho"),
        ])
        .assert()
        .success();

    let content = std::fs::read(&output_path).unwrap();
    assert!(content.starts_with(b"%PDF"));
}

// --- --config, --define, --no-default-configs ---

#[test]
fn test_config_preset() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--config", "guitar", &fixture("simple.cho")])
        .assert()
        .success()
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_config_file() {
    let mut config_file = NamedTempFile::new().unwrap();
    write!(config_file, r#"{{ "settings": {{ "transpose": 2 }} }}"#).unwrap();
    config_file.flush().unwrap();

    // Config sets transpose=2, so G→A and C→D
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--config",
            config_file.path().to_str().unwrap(),
            &fixture("simple.cho"),
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("A     D"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_config_nonexistent_file() {
    let nonexistent = {
        let f = NamedTempFile::new().unwrap();
        f.path().to_string_lossy().to_string()
    };
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--config", &nonexistent, &fixture("simple.cho")])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains(&nonexistent));
}

#[test]
fn test_define_valid() {
    // --define settings.transpose=3 should transpose G→A# and C→D#
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--define", "settings.transpose=3", &fixture("simple.cho")])
        .assert()
        .success()
        .stdout(predicate::str::contains("A#"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_define_invalid_syntax() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--define", "noequalssign", &fixture("simple.cho")])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains("key=value"));
}

#[test]
fn test_define_empty_key_rejected() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--define", "=value", &fixture("simple.cho")])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains("key must not be empty"));
}

#[test]
fn test_define_whitespace_key_rejected() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--define", "  =value", &fixture("simple.cho")])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains("key must not be empty"));
}

#[test]
fn test_config_transpose_combined_with_cli() {
    let mut config_file = NamedTempFile::new().unwrap();
    // Config sets transpose=2
    write!(config_file, r#"{{ "settings": {{ "transpose": 2 }} }}"#).unwrap();
    config_file.flush().unwrap();

    // CLI adds --transpose 1, total = 3 semitones: G→A# and C→D#
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--config",
            config_file.path().to_str().unwrap(),
            "--transpose",
            "1",
            &fixture("simple.cho"),
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("A#"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_config_transpose_out_of_range_positive() {
    let mut config_file = NamedTempFile::new().unwrap();
    write!(config_file, r#"{{ "settings": {{ "transpose": 300 }} }}"#).unwrap();
    config_file.flush().unwrap();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--config",
            config_file.path().to_str().unwrap(),
            &fixture("simple.cho"),
        ])
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "warning: settings.transpose value 300 is out of i8 range, clamped to 127",
        ));
}

#[test]
fn test_config_transpose_out_of_range_negative() {
    let mut config_file = NamedTempFile::new().unwrap();
    write!(config_file, r#"{{ "settings": {{ "transpose": -200 }} }}"#).unwrap();
    config_file.flush().unwrap();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--config",
            config_file.path().to_str().unwrap(),
            &fixture("simple.cho"),
        ])
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "warning: settings.transpose value -200 is out of i8 range, clamped to -128",
        ));
}

#[test]
fn test_no_default_configs() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--no-default-configs", &fixture("simple.cho")])
        .assert()
        .success()
        .stdout(predicate::str::contains("Hello world"));
}

// --- --define with special characters ---

#[test]
fn test_define_value_containing_equals() {
    // Value contains '=' — only the first '=' should split key from value.
    // The string value "a=b" should be stored as-is.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--define", "metadata.separator=a=b", &fixture("simple.cho")])
        .assert()
        .success();
}

#[test]
fn test_define_value_containing_colon() {
    // Value contains ':' — should be treated as a plain string.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--define",
            "metadata.separator=key: value",
            &fixture("simple.cho"),
        ])
        .assert()
        .success();
}

#[test]
fn test_define_value_containing_spaces() {
    // Value with spaces — should be stored as a string.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--define",
            "metadata.separator=hello world",
            &fixture("simple.cho"),
        ])
        .assert()
        .success();
}

// --- --no-default-configs edge cases ---

#[test]
fn test_no_default_configs_with_missing_config_file() {
    // --no-default-configs combined with --config pointing to a nonexistent file
    // should fail gracefully with an error message.
    let nonexistent = {
        let f = NamedTempFile::new().unwrap();
        f.path().to_string_lossy().to_string()
    };
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--no-default-configs",
            "--config",
            &nonexistent,
            &fixture("simple.cho"),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains(&nonexistent));
}

#[test]
fn test_no_default_configs_still_applies_define() {
    // --no-default-configs skips system/user/project configs, but --define
    // should still work on top of built-in defaults.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--no-default-configs",
            "--define",
            "settings.transpose=3",
            &fixture("simple.cho"),
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("A#"));
}

#[test]
fn test_no_default_configs_still_applies_config_file() {
    // --no-default-configs skips system/user/project configs, but an explicit
    // --config file should still be merged.
    let mut config_file = NamedTempFile::new().unwrap();
    write!(config_file, r#"{{ "settings": {{ "transpose": 3 }} }}"#).unwrap();
    config_file.flush().unwrap();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "--no-default-configs",
            "--config",
            config_file.path().to_str().unwrap(),
            &fixture("simple.cho"),
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("A#"));
}

// --- Song-level config overrides ---

#[test]
fn test_song_config_override_transpose() {
    // {+config.settings.transpose: 2} should transpose G→A and C→D
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg(fixture("config-override.cho"))
        .assert()
        .success()
        .stdout(predicate::str::contains("A     D"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_song_config_override_combined_with_cli_transpose() {
    // Song has {+config.settings.transpose: 2}, CLI adds --transpose 1
    // Total = 3 semitones: G→A# and C→D#
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("config-override.cho"), "--transpose", "1"])
        .assert()
        .success()
        .stdout(predicate::str::contains("A#"))
        .stdout(predicate::str::contains("Hello world"));
}

#[test]
fn test_completions_bash() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--completions", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::contains("_chordsketch"));
}

#[test]
fn test_completions_zsh() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--completions", "zsh"])
        .assert()
        .success()
        .stdout(predicate::str::contains("#compdef chordsketch"));
}

#[test]
fn test_completions_fish() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--completions", "fish"])
        .assert()
        .success()
        .stdout(predicate::str::contains("complete -c chordsketch"));
}

#[test]
fn test_completions_powershell() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["--completions", "powershell"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Register-ArgumentCompleter"));
}

// --- convert subcommand ---

#[test]
fn test_convert_plaintext_from_file() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("plain.txt"), "--from", "plaintext"])
        .assert()
        .success()
        .stdout(predicate::str::contains("[G]Hello"))
        .stdout(predicate::str::contains("[C]"))
        .stdout(predicate::str::contains("[Am]Goodbye"));
}

#[test]
fn test_convert_plaintext_from_stdin() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", "-", "--from", "plaintext"])
        .write_stdin("G         C\nHello world\n")
        .assert()
        .success()
        .stdout(predicate::str::contains("[G]Hello"))
        .stdout(predicate::str::contains("[C]"));
}

#[test]
fn test_convert_plaintext_auto_detect() {
    // Auto-detection should recognise plain chord+lyrics from content.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("plain.txt")])
        .assert()
        .success()
        .stdout(predicate::str::contains("[G]Hello"))
        .stdout(predicate::str::contains("[Am]Goodbye"));
}

#[test]
fn test_convert_abc() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("simple.abc"), "--from", "abc"])
        .assert()
        .success()
        .stdout(predicate::str::contains("{title: Simple ABC Tune}"))
        .stdout(predicate::str::contains("[C]"))
        .stdout(predicate::str::contains("[G]"));
}

#[test]
fn test_convert_musicxml_import() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("simple.xml")])
        .assert()
        .success()
        .stdout(predicate::str::contains("[C]"))
        .stdout(predicate::str::contains("[Am]"))
        .stdout(predicate::str::contains("Hello"));
}

#[test]
fn test_convert_musicxml_import_forced() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("simple.xml"), "--from", "musicxml"])
        .assert()
        .success()
        .stdout(predicate::str::contains("[C]"))
        .stdout(predicate::str::contains("Hello"));
}

#[test]
fn test_convert_musicxml_export() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("simple.cho"), "--to", "musicxml"])
        .assert()
        .success()
        .stdout(predicate::str::contains("<score-partwise"))
        .stdout(predicate::str::contains("<root-step>G</root-step>"));
}

#[test]
fn test_convert_musicxml_export_to_file() {
    let output_file = NamedTempFile::new().unwrap();
    let output_path = output_file.path().to_string_lossy().to_string();

    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "convert",
            &fixture("simple.cho"),
            "--to",
            "musicxml",
            "-o",
            &output_path,
        ])
        .assert()
        .success()
        .stdout(predicate::str::is_empty());

    let content = std::fs::read_to_string(&output_path).unwrap();
    assert!(content.contains("<score-partwise"));
}

#[test]
fn test_convert_chordpro_passthrough() {
    // A .cho file with auto-detection should pass through unchanged.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("simple.cho")])
        .assert()
        .success()
        .stdout(predicate::str::contains("{title: Simple Song}"))
        .stdout(predicate::str::contains("[G]Hello [C]world"));
}

#[test]
fn test_convert_nonexistent_file() {
    // Use a NamedTempFile that is immediately dropped to guarantee
    // the path does not exist, avoiding TOCTOU risk with hardcoded paths.
    let nonexistent = {
        let f = NamedTempFile::new().unwrap();
        f.path().to_string_lossy().to_string()
    };
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &nonexistent])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"))
        .stderr(predicate::str::contains(&nonexistent));
}

#[test]
fn test_convert_musicxml_import_wrong_format() {
    // Feeding a plaintext file with --from musicxml should fail.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", &fixture("plain.txt"), "--from", "musicxml"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"));
}

#[test]
fn test_convert_export_multiple_files_rejected() {
    // --to musicxml with multiple files should fail.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "convert",
            &fixture("simple.cho"),
            &fixture("second.cho"),
            "--to",
            "musicxml",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("single input file"));
}

#[test]
fn test_convert_help() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--from"))
        .stdout(predicate::str::contains("--to"))
        .stdout(predicate::str::contains("musicxml"));
}

#[test]
fn test_convert_auto_detect_unknown_format() {
    // Content that is not recognisable as plaintext, ABC, or ChordPro
    // should trigger the Action::Skip path with a warning.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", "-"])
        .write_stdin("\x00\x01\x02binary junk\x03\x04")
        .assert()
        .failure()
        .stderr(predicate::str::contains("format could not be detected"));
}

#[test]
fn test_convert_invalid_xml_with_from_musicxml() {
    // Malformed XML with --from musicxml should produce an error.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args(["convert", "-", "--from", "musicxml"])
        .write_stdin("this is not valid xml at all")
        .assert()
        .failure()
        .stderr(predicate::str::contains("error:"));
}

// -- --warnings-json (#1827) -------------------------------------------

/// Build a `.cho` file whose combined (file `{transpose}` + CLI
/// `--transpose`) value saturates the `i8` range and therefore forces
/// the render layer to emit a `transpose offset ... clamped to ...`
/// warning. The exact saturation path is in
/// `chordsketch_chordpro::transpose::combine_transpose`.
fn saturating_transpose_fixture() -> NamedTempFile {
    let mut file = NamedTempFile::new_in(std::env::temp_dir()).unwrap();
    file.write_all(b"{title: T}\n{transpose: 100}\n[C]Hello\n")
        .unwrap();
    file
}

#[test]
fn test_warnings_json_emits_jsonl_for_saturating_transpose() {
    // With --warnings-json, the saturation warning must come out as a
    // single-line JSON object on stderr, parseable as JSONL.
    let fixture = saturating_transpose_fixture();
    let output = Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            fixture.path().to_str().unwrap(),
            "--transpose",
            "100",
            "--warnings-json",
        ])
        .assert()
        .get_output()
        .stderr
        .clone();
    let stderr = String::from_utf8(output).unwrap();
    let mut saw_any = false;
    for line in stderr.lines() {
        if line.is_empty() {
            continue;
        }
        saw_any = true;
        assert!(
            line.starts_with('{') && line.ends_with('}'),
            "expected JSONL on stderr with --warnings-json; got: {line}"
        );
        assert!(
            line.contains("\"source\":"),
            "each line must carry a `source` field; got: {line}"
        );
        assert!(
            line.contains("\"message\":"),
            "each line must carry a `message` field; got: {line}"
        );
    }
    assert!(
        saw_any,
        "--warnings-json should have produced at least one line on stderr for a saturating transpose"
    );
}

#[test]
fn test_warnings_json_off_emits_plain_warning_prefix() {
    // Default behaviour: human-readable `warning: ...` lines, not JSON.
    // Regression guard — a refactor that accidentally always produces
    // JSON would break every existing stderr scraper.
    let fixture = saturating_transpose_fixture();
    let output = Command::cargo_bin("chordsketch")
        .unwrap()
        .args([fixture.path().to_str().unwrap(), "--transpose", "100"])
        .assert()
        .get_output()
        .stderr
        .clone();
    let stderr = String::from_utf8(output).unwrap();
    assert!(
        stderr.lines().any(|l| l.starts_with("warning: ")),
        "expected at least one `warning: ` line on stderr; got:\n{stderr}"
    );
    assert!(
        !stderr.lines().any(|l| l.starts_with('{')),
        "default mode must not emit JSON lines; got:\n{stderr}"
    );
}

#[test]
fn test_warnings_json_quote_count_is_balanced() {
    // A well-formed JSONL line has an even number of `"` characters —
    // they all participate in balanced `"key":"value"` pairs. An
    // unescaped double-quote inside a message would break this
    // invariant. This catches regressions in `json_escape` without
    // pulling in a full JSON parser.
    let fixture = saturating_transpose_fixture();
    let output = Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            fixture.path().to_str().unwrap(),
            "--transpose",
            "100",
            "--warnings-json",
        ])
        .assert()
        .get_output()
        .stderr
        .clone();
    let stderr = String::from_utf8(output).unwrap();
    for line in stderr.lines().filter(|l| !l.is_empty()) {
        let quote_count = line.chars().filter(|c| *c == '"').count();
        assert_eq!(
            quote_count % 2,
            0,
            "unbalanced quotes suggest an unescaped double-quote; line: {line}"
        );
    }
}

// -----------------------------------------------------------------
// iReal Pro auto-detection (#2066)
//
// `chordsketch <irealb://...>` and `chordsketch <file-with-ireal>`
// route through the iReal pipeline and emit SVG. The
// `--from chordpro|ireal|auto` flag overrides the auto-sniffer.

/// A minimal, deliberately-small iReal Pro URL sourced from the
/// upstream `pianosnake/ireal-reader` test corpus. Exercising the
/// real wire format guards against regressions in the parser
/// dispatch, the percent-decode, and the obfusc50 unscramble.
const TINY_IREAL_URL: &str = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

#[test]
fn ireal_url_argument_renders_svg_to_stdout() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg(TINY_IREAL_URL)
        .assert()
        .success()
        .stdout(predicate::str::starts_with(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        ))
        .stdout(predicate::str::contains("<svg "));
}

#[test]
fn ireal_file_input_is_auto_detected() {
    let mut file = NamedTempFile::new().unwrap();
    write!(file, "{TINY_IREAL_URL}").unwrap();
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg(file.path())
        .assert()
        .success()
        .stdout(predicate::str::contains("<svg "));
}

#[test]
fn from_ireal_forces_ireal_pipeline_even_for_chordpro_argument() {
    // Forcing `--from ireal` on a non-iReal argument should
    // surface the iReal parser's `MissingPrefix` error rather than
    // silently falling back to the ChordPro path. This keeps
    // `--from` honest: when the user asks for the iReal path, a
    // ChordPro file is a parse error, not a soft fallback.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([&fixture("simple.cho"), "--from", "ireal"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("irealb://"));
}

#[test]
fn from_chordpro_overrides_ireal_url_detection() {
    // `--from chordpro` must skip the iReal sniffer. Passing an
    // iReal URL with that flag forces the ChordPro parser, which
    // legitimately reports a parse error rather than silently
    // dispatching to the iReal pipeline.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([TINY_IREAL_URL, "--from", "chordpro"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error"));
}

#[test]
fn ireal_output_to_file() {
    let out = NamedTempFile::new().unwrap();
    let out_path = out.path().to_string_lossy().to_string();
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([TINY_IREAL_URL, "-o", &out_path])
        .assert()
        .success()
        .stdout(predicate::str::is_empty());
    let body = std::fs::read_to_string(&out_path).unwrap();
    assert!(body.contains("<svg "));
}

#[test]
fn ireal_help_text_documents_from_flag() {
    Command::cargo_bin("chordsketch")
        .unwrap()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("--from"))
        .stdout(predicate::str::contains("ireal"));
}

#[test]
fn ireal_nonexistent_file_with_forced_ireal_reports_error() {
    // When `--from ireal` is used and the file does not exist,
    // `read_ireal_input` returns Err and the CLI reports an error
    // message and exits 1 (exercises the read_ireal_input Err branch).
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([
            "/nonexistent/__chordsketch_test__.irealb",
            "--from",
            "ireal",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error"));
}

#[test]
fn ireal_multi_arg_produces_single_xml_declaration() {
    // Two separate single-song iReal URLs as arguments must produce
    // exactly one <?xml?> processing instruction. Duplicate declarations
    // produce invalid XML and would break downstream XML parsers.
    Command::cargo_bin("chordsketch")
        .unwrap()
        .args([TINY_IREAL_URL, TINY_IREAL_URL])
        .assert()
        .success()
        .stdout(predicate::str::starts_with(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        ))
        .stdout(predicate::function(|out: &str| {
            out.matches("<?xml").count() == 1
        }))
        .stdout(predicate::function(|out: &str| {
            out.matches("<svg ").count() == 2
        }));
}
