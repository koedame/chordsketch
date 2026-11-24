//! Exit-code contract of the `chordsketch` binary.
//!
//! Each test launches the built binary and asserts the exact exit code for
//! one kind of failure. The mapping under test lives in `src/exit.rs`, and
//! the user-facing table is the "Exit codes" section of the crate README.

use assert_cmd::Command;
use std::io::Write;
use std::path::Path;
use tempfile::{NamedTempFile, TempDir};

/// Returns the path to a test fixture file.
fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .to_string_lossy()
        .to_string()
}

/// Returns a path that is guaranteed not to exist: the file is created and
/// removed again, so no hardcoded path can collide with a real one.
fn missing_path() -> String {
    let file = NamedTempFile::new().unwrap();
    file.path().to_string_lossy().to_string()
}

/// Writes `content` to a temp file with the given suffix.
fn temp_file(suffix: &str, content: &[u8]) -> NamedTempFile {
    let mut file = tempfile::Builder::new().suffix(suffix).tempfile().unwrap();
    file.write_all(content).unwrap();
    file.flush().unwrap();
    file
}

fn chordsketch() -> Command {
    Command::cargo_bin("chordsketch").unwrap()
}

// --- 0: success ---

#[test]
fn a_successful_render_exits_0() {
    chordsketch().arg(fixture("simple.cho")).assert().code(0);
}

#[test]
fn a_render_that_only_warns_exits_0() {
    let assert = chordsketch()
        .args(["--no-default-configs", "-D", "settings.transpose=200"])
        .arg(fixture("simple.cho"))
        .assert()
        .code(0);
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).to_string();
    assert!(stderr.contains("warning:"), "stderr: {stderr}");
}

#[test]
fn fmt_check_on_a_formatted_file_exits_0() {
    let formatted = chordsketch()
        .args(["fmt", "-"])
        .write_stdin("{title: Sample}\n[G]Sample text\n")
        .output()
        .unwrap();
    assert_eq!(formatted.status.code(), Some(0));
    chordsketch()
        .args(["fmt", "--check", "-"])
        .write_stdin(formatted.stdout)
        .assert()
        .code(0);
}

// --- 1: `fmt --check` found a file that needs formatting ---

#[test]
fn fmt_check_on_an_unformatted_file_exits_1() {
    chordsketch()
        .args(["fmt", "--check", "-"])
        .write_stdin("{t:Sample}\n\n\n\n[G]Sample text")
        .assert()
        .code(1);
}

#[test]
fn fmt_check_exits_with_the_error_when_a_file_is_also_unformatted() {
    let unformatted = temp_file(".cho", b"{t:Sample}\n\n\n\n[G]Sample text");
    chordsketch()
        .args(["fmt", "--check"])
        .arg(unformatted.path())
        .arg(missing_path())
        .assert()
        .code(66);
}

// --- 2: command-line usage ---

#[test]
fn an_unknown_option_exits_2() {
    chordsketch()
        .args(["--no-such-option", &fixture("simple.cho")])
        .assert()
        .code(2);
}

#[test]
fn a_render_without_input_files_exits_2() {
    chordsketch().assert().code(2);
}

#[test]
fn a_malformed_define_exits_2() {
    chordsketch()
        .args(["--define", "noequalssign", &fixture("simple.cho")])
        .assert()
        .code(2);
}

#[test]
fn convert_to_musicxml_with_several_inputs_exits_2() {
    chordsketch()
        .args(["convert", "--to", "musicxml"])
        .args([fixture("simple.cho"), fixture("second.cho")])
        .assert()
        .code(2);
}

// --- 65: the input data is wrong ---

#[test]
fn a_chordpro_parse_error_exits_65() {
    chordsketch().arg(fixture("invalid.cho")).assert().code(65);
}

#[test]
fn an_input_over_the_size_limit_exits_65() {
    let oversized = temp_file(".cho", &vec![b'a'; 10 * 1024 * 1024 + 1]);
    chordsketch().arg(oversized.path()).assert().code(65);
}

#[test]
fn an_input_that_is_not_utf8_exits_65() {
    let binary = temp_file(".cho", &[0xff, 0xfe, 0xfd]);
    chordsketch().arg(binary.path()).assert().code(65);
}

#[test]
fn an_ireal_url_that_cannot_be_parsed_exits_65() {
    chordsketch().arg("irealb://not-a-chart").assert().code(65);
}

#[test]
fn convert_with_an_undetectable_format_exits_65() {
    chordsketch()
        .args(["convert", "-"])
        .write_stdin("\x00\x01\x02binary junk\x03\x04")
        .assert()
        .code(65);
}

#[test]
fn convert_with_malformed_musicxml_exits_65() {
    chordsketch()
        .args(["convert", "-", "--from", "musicxml"])
        .write_stdin("this is not valid xml at all")
        .assert()
        .code(65);
}

// --- 66: an input file is missing or unreadable ---

#[test]
fn a_missing_input_file_exits_66() {
    chordsketch().arg(missing_path()).assert().code(66);
}

#[test]
fn a_missing_ireal_file_exits_66() {
    chordsketch()
        .args(["--from", "ireal"])
        .arg(missing_path())
        .assert()
        .code(66);
}

#[test]
fn fmt_with_a_missing_file_exits_66() {
    chordsketch()
        .arg("fmt")
        .arg(missing_path())
        .assert()
        .code(66);
}

#[test]
fn convert_with_a_missing_file_exits_66() {
    chordsketch()
        .arg("convert")
        .arg(missing_path())
        .assert()
        .code(66);
}

// --- 73: the output file cannot be written ---

#[test]
fn an_output_file_that_cannot_be_created_exits_73() {
    let dir = TempDir::new().unwrap();
    let output = dir.path().join("no-such-directory").join("out.txt");
    chordsketch()
        .arg("-o")
        .arg(&output)
        .arg(fixture("simple.cho"))
        .assert()
        .code(73);
}

#[test]
fn convert_with_an_output_file_that_cannot_be_created_exits_73() {
    let dir = TempDir::new().unwrap();
    let output = dir.path().join("no-such-directory").join("out.cho");
    chordsketch()
        .arg("convert")
        .arg(fixture("plain.txt"))
        .arg("-o")
        .arg(&output)
        .assert()
        .code(73);
}

// --- 74: writing to stdout failed ---

// `/dev/full` accepts the open and fails every write with ENOSPC; it is a
// Linux device, so the other platforms have no equivalent to run this on.
#[cfg(target_os = "linux")]
#[test]
fn a_failed_write_to_stdout_exits_74() {
    let full = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .unwrap();
    let status = std::process::Command::new(assert_cmd::cargo::cargo_bin("chordsketch"))
        .arg(fixture("simple.cho"))
        .stdout(full)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(74));
}

// --- 76: the MCP handshake failed ---

#[test]
fn an_mcp_session_that_closes_before_the_handshake_exits_76() {
    chordsketch().arg("mcp").write_stdin("").assert().code(76);
}

// --- 78: a `--config` file is missing or malformed ---

#[test]
fn a_missing_config_file_exits_78() {
    chordsketch()
        .arg("--no-default-configs")
        .arg("--config")
        .arg(missing_path())
        .arg(fixture("simple.cho"))
        .assert()
        .code(78);
}

#[test]
fn a_malformed_config_file_exits_78() {
    let config = temp_file(".json", b"{ \"settings\": ");
    chordsketch()
        .arg("--no-default-configs")
        .arg("--config")
        .arg(config.path())
        .arg(fixture("simple.cho"))
        .assert()
        .code(78);
}

// --- several failures in one run ---

#[test]
fn several_failing_inputs_exit_with_the_code_of_the_first_failure() {
    chordsketch()
        .args([missing_path(), fixture("invalid.cho")])
        .assert()
        .code(66);
    chordsketch()
        .args([fixture("invalid.cho"), missing_path()])
        .assert()
        .code(65);
}

#[test]
fn a_failing_input_among_valid_ones_still_writes_the_valid_output() {
    let assert = chordsketch()
        .args([fixture("simple.cho"), fixture("invalid.cho")])
        .assert()
        .code(65);
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout).to_string();
    assert!(stdout.contains("Simple Song"), "stdout: {stdout}");
}
