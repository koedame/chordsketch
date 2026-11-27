//! Utilities for detecting and invoking external tools.
//!
//! The delegate rendering pipeline (ABC, Lilypond, MusicXML) requires external
//! tools to convert notation into SVG. This module provides functions to check
//! whether these tools are installed and accessible on the current system,
//! and to invoke them on delegate environment content.
//!
//! All detection functions are safe to call even when the tools are not
//! installed — they return `false` rather than panicking.
//!
//! # Security
//!
//! These tools execute code that can be embedded in the notation they are
//! given (abc2svg runs JavaScript, Lilypond runs Scheme). The renderers only
//! invoke them when the configuration explicitly enables the delegate (see
//! [`crate::config::Delegate`]), which is off by default and cannot be
//! switched on from a song file or a project config. The content filters
//! applied here reduce what reaches the tools, but they are not a sandbox:
//! enable a delegate only for song files you trust.

use std::fs::OpenOptions;
use std::io::Write;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

/// Checks whether a command is available by attempting to run it.
///
/// Returns `true` if the command can be executed (the process starts
/// successfully). Returns `false` if the command is not found or cannot
/// be executed.
///
/// # Security
///
/// The `command` parameter is passed directly to [`std::process::Command::new`].
/// Callers **must not** pass user-controlled or untrusted input as the command
/// name, as this could lead to arbitrary command execution. This function is
/// intended only for checking hardcoded tool names (e.g., `"lilypond"`,
/// `"abc2svg"`).
///
/// # Examples
///
/// ```no_run
/// use chordsketch_chordpro::external_tool::is_available;
///
/// if is_available("lilypond") {
///     println!("Lilypond is installed");
/// }
/// ```
#[must_use]
pub fn is_available(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

/// Returns `true` if `abc2svg` is available.
///
/// The result is cached at the process level via `OnceLock`, so the
/// subprocess check runs at most once regardless of how many songs
/// are rendered.
#[must_use]
pub fn has_abc2svg() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| is_available("abc2svg"))
}

/// Returns `true` if `lilypond` is available.
///
/// The result is cached at the process level via `OnceLock`, so the
/// subprocess check runs at most once regardless of how many songs
/// are rendered.
#[must_use]
pub fn has_lilypond() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| is_available("lilypond"))
}

/// Global counter for generating unique temp file names within a process.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a unique temporary file path with the given prefix and extension.
///
/// Uses PID + monotonic counter to avoid collisions across threads
/// and sequential invocations within the same process.
fn unique_temp_path(prefix: &str, ext: &str) -> std::path::PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("{prefix}_{pid}_{counter}.{ext}"))
}

/// Write content to a new temporary file using `O_EXCL` semantics.
///
/// The file is created with `create_new(true)` which maps to `O_CREAT | O_EXCL`
/// on Unix, preventing symlink attacks and ensuring the file did not already exist.
fn write_temp_file_exclusive(path: &std::path::Path, content: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("failed to create temp file: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("failed to write temp file: {e}"))?;
    Ok(())
}

/// RAII guard that removes a temporary file when dropped.
///
/// Ensures the temp file is cleaned up regardless of how the enclosing
/// scope exits (normal return, early `?` return, or panic). Because
/// `chordsketch-chordpro` has zero external dependencies, this is implemented
/// as a stdlib-only `Drop` type rather than using `scopeguard` or `tempfile`.
///
/// # Usage
///
/// Bind with `let _guard = TempFileGuard { … }`, **not** `let _ = …`.
/// `let _ = expr` drops the value immediately; `let _guard = …` keeps
/// the guard alive until it goes out of scope.
struct TempFileGuard {
    path: std::path::PathBuf,
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// RAII guard that removes a temporary directory (recursively) when dropped.
///
/// Ensures the temp directory is cleaned up regardless of how the enclosing
/// scope exits (normal return, early `?` return, or panic). Because
/// `chordsketch-chordpro` has zero external dependencies, this is implemented
/// as a stdlib-only `Drop` type rather than using `scopeguard` or `tempfile`.
///
/// # Usage
///
/// Bind with `let _guard = TempDirGuard { … }`, **not** `let _ = …`.
/// `let _ = expr` drops the value immediately; `let _guard = …` keeps
/// the guard alive until it goes out of scope.
struct TempDirGuard {
    path: std::path::PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Invoke `abc2svg` on ABC notation content and return the rendered SVG fragment.
///
/// Writes `abc_content` to a temporary file, runs `abc2svg tosvg.js <file>`,
/// and extracts the `<body>` content from the HTML output. The returned string
/// is an HTML fragment containing one or more `<svg>` elements suitable for
/// direct embedding.
///
/// # Errors
///
/// Returns an error string if:
/// - The temporary file cannot be written
/// - `abc2svg` is not available or fails to execute
/// - The output does not contain a recognizable `<body>` section
#[must_use = "invocation errors should not be silently discarded"]
pub fn invoke_abc2svg(abc_content: &str) -> Result<String, String> {
    let sanitized = sanitize_abc_content(abc_content);

    let tmp_path = unique_temp_path("chordsketch_abc", "abc");
    // Guard is created before the write so that if write_temp_file_exclusive
    // creates the file with O_EXCL but then fails on write_all, the guard's
    // Drop still runs and removes the partially-created file. The `let _ =`
    // in Drop silently handles the case where the file was never created
    // (e.g. if O_EXCL open fails before any bytes are written).
    let _guard = TempFileGuard {
        path: tmp_path.clone(),
    };
    write_temp_file_exclusive(&tmp_path, &sanitized)?;

    let output = Command::new("abc2svg")
        .arg("tosvg.js")
        .arg(&tmp_path)
        .output()
        .map_err(|e| format!("failed to invoke abc2svg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("abc2svg exited with error: {stderr}"));
    }

    let html = String::from_utf8_lossy(&output.stdout);
    extract_body_content(&html)
        .ok_or_else(|| "failed to extract SVG from abc2svg output".to_string())
}

/// Stylesheet directives (`%%name ...` or `I:name ...` lines) that are passed
/// to abc2svg. Each one only adjusts layout, spacing, fonts, or the score
/// structure.
///
/// This is an allowlist: a directive line whose name is not listed here is
/// removed before abc2svg sees the notation. Names are compared
/// ASCII-case-insensitively.
const ABC_ALLOWED_DIRECTIVES: &[&str] = &[
    // Page and line layout
    "pagewidth",
    "pagescale",
    "scale",
    "staffwidth",
    "leftmargin",
    "rightmargin",
    "topspace",
    "indent",
    "newpage",
    "vskip",
    "sep",
    "linebreak",
    "staffbreak",
    "barsperstaff",
    "breakoneoln",
    "singleline",
    "stretchstaff",
    "breaklimit",
    "maxshrink",
    "notespacingfactor",
    "lineskipfac",
    "parskipfac",
    "gracespace",
    // Vertical spacing
    "composerspace",
    "infospace",
    "musicspace",
    "partsspace",
    "staffsep",
    "maxstaffsep",
    "sysstaffsep",
    "maxsysstaffsep",
    "subtitlespace",
    "textspace",
    "titlespace",
    "vocalspace",
    "wordsspace",
    // Score structure
    "score",
    "staves",
    "clef",
    "staff",
    "stafflines",
    "staffscale",
    "staffnonote",
    "transpose",
    "ottava",
    "repbra",
    "repeat",
    "setbarnb",
    // Appearance of notes, bars, and headings
    "measurenb",
    "measurebox",
    "measrepnb",
    "contbarnb",
    "aligncomposer",
    "infoline",
    "titlecaps",
    "titleleft",
    "titleformat",
    "writefields",
    "beamslope",
    "flatbeams",
    "straightflags",
    "bstemdown",
    "stemheight",
    "slurheight",
    "tieheight",
    "graceslurs",
    "squarebreve",
    "cancelkey",
    "custos",
    "hyphencont",
    "shiftunison",
    "tuplets",
    "dynamic",
    "gchord",
    "gstemdir",
    "ornament",
    "stemdir",
    "vocal",
    "annotationbox",
    "gchordbox",
    "partsbox",
    "altchord",
    "dblrepbar",
    "rbmax",
    "rbmin",
    "abc-version",
    // Diagnostics
    "checkbars",
    "decoerr",
    "keywarn",
    "linewarn",
    "timewarn",
    "quiet",
    // Text lines
    "center",
    "text",
    // Named fonts
    "titlefont",
    "subtitlefont",
    "composerfont",
    "partsfont",
    "tempofont",
    "vocalfont",
    "textfont",
    "wordsfont",
    "gchordfont",
    "annotationfont",
    "infofont",
    "measurefont",
    "repeatfont",
    "voicefont",
    "historyfont",
    "headerfont",
    "footerfont",
    "tupletfont",
];

/// If `line` is an abc2svg stylesheet directive (`%%name ...` or
/// `I:name ...`), returns the directive name; otherwise `None`.
///
/// The name is the first run of non-whitespace characters after the
/// prefix, which is how abc2svg itself splits a directive line. Leading
/// whitespace before the prefix is ignored here so that such a line is
/// still treated as a directive and has to pass the allowlist.
fn abc_directive_name(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("%%").or_else(|| {
        trimmed
            .get(..2)
            .filter(|p| p.eq_ignore_ascii_case("I:"))
            .map(|_| &trimmed[2..]) // safe: get(..2) succeeded => 2 is a char boundary
    })?;
    // abc2svg splits on JavaScript's `\s`, which also covers U+FEFF.
    let is_sep = |c: char| c.is_whitespace() || c == '\u{feff}';
    let rest = rest.trim_start_matches(is_sep);
    Some(rest.split(is_sep).next().unwrap_or(""))
}

/// Whether `name` is on [`ABC_ALLOWED_DIRECTIVES`].
fn abc_directive_allowed(name: &str) -> bool {
    ABC_ALLOWED_DIRECTIVES
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(name))
}

/// Remove every stylesheet directive that is not on the allowlist from ABC
/// notation before it is handed to abc2svg.
///
/// abc2svg acts on directive lines beyond layout: some open multi-line
/// blocks whose body it interprets (including script blocks it executes),
/// some read other files. Rather than enumerating those, only the
/// directives in [`ABC_ALLOWED_DIRECTIVES`] are kept. A dropped directive
/// whose name starts with `begin` also drops the lines up to its matching
/// `end` line, so the block body is not left behind as stray notation.
/// Lines that are not directives (headers, music, lyrics, comments) pass
/// through unchanged.
fn sanitize_abc_content(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    // While inside a dropped `begin<kind>` block: the `end<kind>` name that
    // closes it, lowercased.
    let mut block_end: Option<String> = None;

    for line in input.lines() {
        let name = abc_directive_name(line);

        if let Some(end) = &block_end {
            if name.is_some_and(|n| n.eq_ignore_ascii_case(end)) {
                block_end = None;
            }
            continue;
        }

        if let Some(name) = name
            && !abc_directive_allowed(name)
        {
            let lower = name.to_ascii_lowercase();
            if let Some(kind) = lower.strip_prefix("begin") {
                block_end = Some(format!("end{kind}"));
            }
            continue;
        }

        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
    }

    output
}

/// Scheme function names whose directly-sigiled calls are stripped from
/// Lilypond content.
///
/// This is a best-effort filter for the most obvious calls, **not a security
/// boundary.** Lilypond runs embedded Scheme with full access to the system,
/// and Scheme can reach these functions in ways a line filter cannot
/// recognise. Lilypond no longer offers a sandbox (its `-dsafe` mode was
/// removed upstream in 2.23.12), so the only protection is to enable the
/// Lilypond delegate solely for song files you trust.
const DANGEROUS_SCHEME_FUNCTIONS: &[&str] = &[
    "system",
    "getenv",
    "open-input-file",
    "open-output-file",
    "open-file",
    "primitive-load",
    "primitive-load-path",
    "eval-string",
    "load",
    "ly:gulp-file",
    // ly:gulp-string is the cousin of ly:gulp-file that has also appeared
    // alongside it; it reads a file and returns its contents as a string
    // (#1844).
    "ly:gulp-string",
    "gulp-string",
    // Note: `ly:format` was removed from this list in #1859. It is a
    // standard Guile `format`-equivalent used in real scores
    // (e.g. `#(ly:format "~a" (ly:context-property …))`), and
    // stripping it silently drops entire lines of legitimate Scheme,
    // producing confusing downstream errors.
    //
    // Honest accounting of what this change weakens: the pattern
    // `#(ly:format "~a" (ly:gulp-file "/etc/passwd"))` — where the
    // dangerous primitive appears as a bare subexpression without its
    // own `#(` / `$(` sigil — is no longer caught by the line-level
    // scanner. With `ly:format` on the blocklist the outer
    // `#(ly:format` match triggered the line drop; after removal it
    // does not, and the inner `(ly:gulp-file …)` has no sigil.
    // We accept this because:
    //   1. This list is not a security boundary (see the doc comment
    //      above); trusting the song file is.
    //   2. The same bypass works with any other wrapper function
    //      (`display`, `apply`, user-defined let-bindings, …), so
    //      keeping `ly:format` on the list did not systematically
    //      close the class of attack — only this one specific spelling.
    //   3. The false-positive rate on legitimate content was real and
    //      visible; the defense value is marginal and already
    //      partial.
    // Directly-sigiled dangerous primitives (`#(ly:gulp-file …)`,
    // `$(ly:system …)`, etc.) remain blocked as before.
    // ly:exit terminates the Lilypond process; useful to a sandbox
    // attacker for masking tampering signals in batch pipelines (#1844).
    "ly:exit",
    "ly:system",
    "ly:parser-include",
    "ly:set-option",
];

/// Remove lines with directly-sigiled calls to the functions in
/// [`DANGEROUS_SCHEME_FUNCTIONS`] (e.g., `#(system ...)`, `#(getenv ...)`).
///
/// Best effort only — see [`DANGEROUS_SCHEME_FUNCTIONS`]. Lilypond content is
/// executable code, so it must come from a trusted song file.
fn sanitize_lilypond_content(input: &str) -> String {
    let mut output = String::with_capacity(input.len());

    for line in input.lines() {
        if line_contains_dangerous_scheme(line) {
            continue;
        }
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
    }

    output
}

/// Check if a line contains a dangerous Scheme function call.
///
/// Matches patterns like `#(system ...)`, `#(ly:system ...)`, `$(system ...)`,
/// or `$(ly:system ...)` anywhere in the line, case-insensitively. In Lilypond
/// 2.18+, `$` is an alternative to `#` for Scheme evaluation.
fn line_contains_dangerous_scheme(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    for sigil in &["#(", "$("] {
        let mut search_from = 0;
        while let Some(pos) = lower[search_from..].find(sigil) {
            let abs_pos = search_from + pos;
            let after = &lower[abs_pos + sigil.len()..];
            let trimmed = after.trim_start();
            for &func in DANGEROUS_SCHEME_FUNCTIONS {
                if trimmed.starts_with(func) {
                    return true;
                }
            }
            search_from = abs_pos + sigil.len();
        }
    }
    false
}

/// Extract content after `<body>` from an HTML string.
///
/// Looks for a `</body>` closing tag first; if absent (abc2svg omits it),
/// falls back to `</html>`. Returns the trimmed content between the opening
/// tag and whichever closing marker is found.
fn extract_body_content(html: &str) -> Option<String> {
    let body_open = html.find("<body>")?;
    let content_start = body_open + "<body>".len();
    let content_end = html
        .find("</body>")
        .or_else(|| html.find("</html>"))
        .unwrap_or(html.len());
    if content_start > content_end {
        return None;
    }
    Some(html[content_start..content_end].trim().to_string())
}

/// Invoke `lilypond` on Lilypond notation content and return the rendered SVG.
///
/// Creates a temporary directory, writes `ly_content` to a `.ly` file, runs
/// `lilypond --svg -o <prefix> <file>`, and reads the resulting SVG file.
/// The returned string is a complete SVG document suitable for inline embedding.
///
/// # Errors
///
/// Returns an error string if:
/// - The temporary directory or file cannot be created
/// - `lilypond` is not available or fails to execute
/// - The output SVG file cannot be read
#[must_use = "invocation errors should not be silently discarded"]
pub fn invoke_lilypond(ly_content: &str) -> Result<String, String> {
    let sanitized = sanitize_lilypond_content(ly_content);

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tmp_dir = std::env::temp_dir().join(format!("chordsketch_ly_{pid}_{counter}"));

    // Use create_dir (not create_dir_all) to fail if the directory already exists,
    // preventing symlink-based attacks on predictable paths.
    std::fs::create_dir(&tmp_dir).map_err(|e| format!("failed to create temp directory: {e}"))?;
    // Guard ensures the temp directory is removed on any exit path.
    let _guard = TempDirGuard {
        path: tmp_dir.clone(),
    };

    let ly_path = tmp_dir.join("input.ly");
    let output_prefix = tmp_dir.join("output");

    // Use create_new(true) / O_EXCL to prevent a TOCTOU race between the
    // freshly created directory and the file write inside it.
    write_temp_file_exclusive(&ly_path, &sanitized)?;

    // No sandbox flag: Lilypond 2.23.12 removed `-dsafe` (passing it is a
    // fatal error), and Lilypond has no replacement. Embedded Scheme runs
    // with the user's privileges, which is why the delegate is off unless
    // the caller enables it for trusted input.
    let result = Command::new("lilypond")
        .arg("--svg")
        .arg(format!("-o{}", output_prefix.display()))
        .arg(&ly_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("failed to invoke lilypond: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("lilypond exited with error: {stderr}"));
    }

    let svg_path = tmp_dir.join("output.svg");
    std::fs::read_to_string(&svg_path)
        .map_err(|e| format!("failed to read lilypond SVG output: {e}"))
}

/// Returns the name of the MuseScore executable available on this system.
///
/// Checks for `mscore` first (common on Debian/Ubuntu), then `musescore`.
/// The result is cached at the process level via `OnceLock`, so the subprocess
/// checks run at most once per process. Returns `None` if neither is in `PATH`.
fn musescore_cmd() -> Option<&'static str> {
    static CACHE: OnceLock<Option<&'static str>> = OnceLock::new();
    *CACHE.get_or_init(|| {
        if is_available("mscore") {
            Some("mscore")
        } else if is_available("musescore") {
            Some("musescore")
        } else {
            None
        }
    })
}

/// Returns `true` if MuseScore (`mscore` or `musescore`) is available.
///
/// The result is cached at the process level.
#[must_use]
pub fn has_musescore() -> bool {
    musescore_cmd().is_some()
}

/// Strip potentially dangerous content from MusicXML before invoking MuseScore.
///
/// MusicXML is XML; this function removes XML processing instructions
/// (`<?...?>`) which could embed executable directives or external entity
/// references, and strips `<!DOCTYPE` declarations that might trigger
/// external entity expansion (XXE). Normal MusicXML element content is
/// preserved unchanged.
pub fn sanitize_musicxml_content(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    // Work on the byte string; all delimiters are ASCII so byte indices are safe.
    let mut pos = 0;
    let bytes = input.as_bytes();
    let len = bytes.len();

    while pos < len {
        if bytes[pos] == b'<' {
            if pos + 1 < len && bytes[pos + 1] == b'?' {
                // Processing instruction <?...?> — skip to closing ?>
                pos += 2;
                while pos < len {
                    if bytes[pos] == b'?' && pos + 1 < len && bytes[pos + 1] == b'>' {
                        pos += 2;
                        break;
                    }
                    pos += 1;
                }
            } else if pos + 8 < len
                && bytes[pos + 1] == b'!'
                && bytes[pos + 2..pos + 9]
                    .iter()
                    .zip(b"DOCTYPE")
                    .all(|(a, b)| a.to_ascii_uppercase() == *b)
            {
                // DOCTYPE declaration — skip to the closing `>`, respecting
                // internal subsets. A DOCTYPE with an internal subset looks
                // like `<!DOCTYPE foo [<!ELEMENT bar EMPTY>]>`: the `>` inside
                // `[…]` must not terminate the declaration, so we track depth.
                pos += 9; // skip past "<!DOCTYPE"
                let mut bracket_depth = 0u32;
                while pos < len {
                    match bytes[pos] {
                        b'[' => {
                            bracket_depth += 1;
                            pos += 1;
                        }
                        b']' => {
                            bracket_depth = bracket_depth.saturating_sub(1);
                            pos += 1;
                        }
                        b'>' if bracket_depth == 0 => {
                            pos += 1;
                            break;
                        }
                        _ => {
                            pos += 1;
                        }
                    }
                }
            } else {
                // Normal tag — pass through
                output.push('<');
                pos += 1;
            }
        } else {
            // SAFETY: pos is a valid UTF-8 boundary because we only advance
            // by 1 on ASCII bytes (0x3C '<', 0x3F '?', 0x21 '!', 0x3E '>').
            // Non-ASCII bytes are copied one byte at a time; they only appear
            // inside text content (never inside the ASCII delimiters above),
            // and we accumulate them into the output char-by-char below.
            // Since we must preserve multi-byte sequences, step forward by
            // the character width at this position.
            let ch = input[pos..].chars().next().expect("valid UTF-8");
            output.push(ch);
            pos += ch.len_utf8();
        }
    }

    output
}

/// Collect page-numbered SVG files produced by MuseScore 3.x.
///
/// MuseScore 3.x writes `output-1.svg`, `output-2.svg`, … (one file per
/// page) into `tmp_dir`. This function reads all existing page files in
/// ascending order, wraps each page's SVG in
/// `<div class="musicxml-page">…</div>`, and concatenates the results.
///
/// Returns an empty string if no page files exist (the caller should treat
/// this as an error). Returns an `Err` if any existing page file cannot be
/// read.
fn collect_musescore_pages(tmp_dir: &std::path::Path) -> Result<String, String> {
    let mut pages = String::new();
    let mut page = 1u32;
    loop {
        let page_path = tmp_dir.join(format!("output-{page}.svg"));
        if !page_path.exists() {
            break;
        }
        match std::fs::read_to_string(&page_path) {
            Ok(content) => {
                pages.push_str("<div class=\"musicxml-page\">");
                pages.push_str(content.trim());
                pages.push_str("</div>\n");
            }
            Err(e) => {
                return Err(format!("failed to read MuseScore SVG page {page}: {e}"));
            }
        }
        page += 1;
    }
    Ok(pages)
}

/// Invoke MuseScore on MusicXML content and return the rendered SVG.
///
/// Writes `musicxml_content` to a temporary `.xml` file, runs
/// `mscore -o <output.svg> <input.xml>` (falling back to `musescore` if
/// `mscore` is not available), and reads the resulting `.svg` file(s).
///
/// ## Output file naming
///
/// MuseScore 3.x produces page-numbered files (`output-1.svg`, `output-2.svg`,
/// …) even for single-page scores. MuseScore 4.x produces a single
/// `output.svg`. This function tries `output.svg` first; if absent it collects
/// all `output-N.svg` files in page order and concatenates their content.
///
/// # Errors
///
/// Returns an error string if:
/// - The temporary file cannot be written
/// - Neither `mscore` nor `musescore` is available or they fail to execute
/// - No SVG output file can be found after a successful run
#[must_use = "invocation errors should not be silently discarded"]
pub fn invoke_musescore(musicxml_content: &str) -> Result<String, String> {
    // Check tool availability before creating any temp files so that a missing
    // tool never leaves an orphaned directory behind.
    let cmd_name = musescore_cmd()
        .ok_or_else(|| "MuseScore is not available (install mscore or musescore)".to_string())?;

    let sanitized = sanitize_musicxml_content(musicxml_content);

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tmp_dir = std::env::temp_dir().join(format!("chordsketch_mxl_{pid}_{counter}"));

    std::fs::create_dir(&tmp_dir).map_err(|e| format!("failed to create temp directory: {e}"))?;
    // Guard ensures the temp directory is removed on any exit path.
    let _guard = TempDirGuard {
        path: tmp_dir.clone(),
    };

    let input_path = tmp_dir.join("input.xml");
    let output_svg = tmp_dir.join("output.svg");

    // Use create_new(true) / O_EXCL to prevent a TOCTOU race between the
    // freshly created directory and the file write inside it.
    write_temp_file_exclusive(&input_path, &sanitized)?;

    let result = Command::new(cmd_name)
        .arg("-o")
        .arg(&output_svg)
        .arg(&input_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("failed to invoke {cmd_name}: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("{cmd_name} exited with error: {stderr}"));
    }

    // MuseScore 4.x writes output.svg; MuseScore 3.x writes output-1.svg,
    // output-2.svg, … (page-numbered) even for single-page scores.
    if output_svg.exists() {
        // MuseScore 4.x path: single file.
        std::fs::read_to_string(&output_svg)
            .map_err(|e| format!("failed to read MuseScore SVG output: {e}"))
    } else {
        // MuseScore 3.x path: collect output-1.svg, output-2.svg, …
        let pages = collect_musescore_pages(&tmp_dir)?;
        if pages.is_empty() {
            return Err(
                "MuseScore produced no SVG output (expected output.svg or output-1.svg)"
                    .to_string(),
            );
        }
        Ok(pages)
    }
}

/// Returns `true` if the Perl `chordpro` reference implementation is available.
///
/// The result is cached at the process level via `OnceLock`, so the
/// subprocess check runs at most once.
#[must_use]
pub fn has_perl_chordpro() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| is_available("chordpro"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonexistent_tool_returns_false() {
        assert!(!is_available("this-command-definitely-does-not-exist-xyz"));
    }

    #[test]
    fn unique_temp_paths_are_distinct() {
        let paths: Vec<_> = (0..100)
            .map(|_| super::unique_temp_path("test", "tmp"))
            .collect();
        // All paths should be unique thanks to the atomic counter.
        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(unique.len(), paths.len());
    }

    #[test]
    fn write_temp_file_exclusive_prevents_overwrite() {
        let path = super::unique_temp_path("test_excl", "tmp");
        // First write succeeds.
        super::write_temp_file_exclusive(&path, "hello").unwrap();
        // Hold a guard so the file is cleaned up even if the assertion panics.
        let _guard = super::TempFileGuard { path: path.clone() };
        // Second write to same path must fail (O_EXCL semantics).
        let result = super::write_temp_file_exclusive(&path, "world");
        assert!(result.is_err());
    }

    #[test]
    fn temp_file_guard_removes_file_on_drop() {
        let path = super::unique_temp_path("test_guard_file", "tmp");
        super::write_temp_file_exclusive(&path, "data").unwrap();
        assert!(path.exists(), "file should exist before guard drops");
        {
            let _guard = super::TempFileGuard { path: path.clone() };
        } // guard drops here
        assert!(
            !path.exists(),
            "file should be removed after TempFileGuard drops"
        );
    }

    #[test]
    fn temp_dir_guard_removes_dir_on_drop() {
        let dir =
            std::env::temp_dir().join(format!("chordsketch_test_guard_{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        // Write a file inside so we exercise recursive removal.
        std::fs::write(dir.join("inner.txt"), "hello").unwrap();
        assert!(dir.exists(), "dir should exist before guard drops");
        {
            let _guard = super::TempDirGuard { path: dir.clone() };
        } // guard drops here
        assert!(
            !dir.exists(),
            "dir should be removed after TempDirGuard drops"
        );
    }

    // The following tests are #[ignore] because they depend on external tools.
    // Run with: cargo test -p chordsketch-chordpro -- --ignored

    #[test]
    fn extract_body_content_basic() {
        let html = "<html><body>\n<svg>hello</svg>\n</body></html>";
        let result = super::extract_body_content(html);
        assert_eq!(result, Some("<svg>hello</svg>".to_string()));
    }

    #[test]
    fn extract_body_content_missing_body() {
        let html = "<html><div>no body tag</div></html>";
        assert!(super::extract_body_content(html).is_none());
    }

    #[test]
    fn extract_body_content_empty_body() {
        let html = "<html><body></body></html>";
        assert_eq!(super::extract_body_content(html), Some(String::new()));
    }

    #[test]
    #[ignore]
    fn abc2svg_detection() {
        assert!(has_abc2svg(), "abc2svg not found in PATH");
    }

    #[test]
    #[ignore]
    fn invoke_abc2svg_produces_svg() {
        let abc = "X:1\nT:Test\nM:4/4\nK:C\nCDEF|GABc|\n";
        let result = invoke_abc2svg(abc);
        assert!(result.is_ok(), "invoke_abc2svg failed: {:?}", result.err());
        let svg = result.unwrap();
        assert!(svg.contains("<svg"), "output should contain SVG element");
    }

    #[test]
    fn invoke_abc2svg_fails_gracefully_without_tool() {
        if has_abc2svg() {
            // Skip if abc2svg is available — this test is for the missing-tool path.
            return;
        }
        let result = invoke_abc2svg("X:1\n");
        assert!(result.is_err());
    }

    #[test]
    #[ignore]
    fn lilypond_detection() {
        assert!(has_lilypond(), "lilypond not found in PATH");
    }

    #[test]
    #[ignore]
    fn invoke_lilypond_produces_svg() {
        let ly = "\\relative c' { c4 d e f | g2 g | }\n";
        let result = invoke_lilypond(ly);
        assert!(result.is_ok(), "invoke_lilypond failed: {:?}", result.err());
        let svg = result.unwrap();
        assert!(svg.contains("<svg"), "output should contain SVG element");
    }

    #[test]
    fn invoke_lilypond_fails_gracefully_without_tool() {
        if has_lilypond() {
            return;
        }
        let result = invoke_lilypond("{ c4 }\n");
        assert!(result.is_err());
    }

    #[test]
    fn sanitize_abc_keeps_notation_and_allowed_directives() {
        let input = "X:1\nT:Test\nM:4/4\nL:1/8\n%%score (S A)\nI:linebreak $\n\
                     %%titlefont Times 18\nK:C\n% a plain comment\nCDEF|GABc|\nw:la la la la\n";
        let result = super::sanitize_abc_content(input);
        assert_eq!(
            result,
            "X:1\nT:Test\nM:4/4\nL:1/8\n%%score (S A)\nI:linebreak $\n\
             %%titlefont Times 18\nK:C\n% a plain comment\nCDEF|GABc|\nw:la la la la"
        );
    }

    #[test]
    fn sanitize_abc_keeps_allowed_directives_whatever_their_case_spacing_or_arguments() {
        for line in [
            "%%score",
            "%%SCORE (1 2)",
            "%% score (1 2)",
            "%%\tStaffSep 30",
            "I:score {1 2}",
            "i:Score",
            "I: measurenb 0",
            "  %%vskip 1cm",
        ] {
            let input = format!("X:1\n{line}\nK:C\n");
            assert_eq!(
                super::sanitize_abc_content(&input),
                format!("X:1\n{line}\nK:C"),
                "allowed directive was dropped: {line:?}"
            );
        }
    }

    #[test]
    fn sanitize_abc_drops_every_directive_outside_the_allowlist() {
        // Names that are not on the allowlist, including ones that merely
        // start or end like an allowed name. None may survive, whatever the
        // prefix, case, spacing, or trailing arguments.
        let names = [
            "frobnicate",
            "scorex",
            "xscore",
            "score-extra",
            "include",
            "format",
            "font",
            "MIDI",
            "voice",
            "tune",
            "",
        ];
        let prefixes = ["%%", "%% ", "%%\t", "I:", "I: ", "i:", " %%", "\t%%"];
        for name in names {
            for prefix in prefixes {
                for name_case in [name.to_string(), name.to_ascii_uppercase()] {
                    for suffix in ["", " arg", "\targ more"] {
                        let line = format!("{prefix}{name_case}{suffix}");
                        let input = format!("X:1\n{line}\nK:C\nCDEF|\n");
                        assert_eq!(
                            super::sanitize_abc_content(&input),
                            "X:1\nK:C\nCDEF|",
                            "directive outside the allowlist survived: {line:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn every_allowed_abc_directive_survives_and_a_suffixed_name_does_not() {
        for &name in super::ABC_ALLOWED_DIRECTIVES {
            let kept = format!("X:1\n%%{name} 1\nK:C\n");
            assert_eq!(
                super::sanitize_abc_content(&kept),
                format!("X:1\n%%{name} 1\nK:C"),
                "{name}"
            );
            let suffixed = format!("X:1\n%%{name}x 1\nK:C\n");
            assert_eq!(
                super::sanitize_abc_content(&suffixed),
                "X:1\nK:C",
                "{name}x"
            );
        }
    }

    #[test]
    fn sanitize_abc_drops_a_block_directive_together_with_its_body() {
        let input = "X:1\nK:C\n%%beginfoo opt\nbody line 1\n%%score (1)\nbody line 2\n\
                     %%endfoo\nCDEF|\n";
        let result = super::sanitize_abc_content(input);
        assert_eq!(result, "X:1\nK:C\nCDEF|");
    }

    #[test]
    fn sanitize_abc_drops_a_block_directive_given_with_the_info_field_prefix() {
        let input = "X:1\nI:BeginFoo\nbody\nI:EndFoo\nK:C\nCDEF|\n";
        let result = super::sanitize_abc_content(input);
        assert_eq!(result, "X:1\nK:C\nCDEF|");
    }

    #[test]
    fn sanitize_abc_drops_the_rest_of_an_unterminated_block() {
        let input = "X:1\nK:C\n%%beginfoo\nbody\nCDEF|\n";
        let result = super::sanitize_abc_content(input);
        assert_eq!(result, "X:1\nK:C");
    }

    #[test]
    fn sanitize_abc_ends_a_block_only_at_its_own_end_directive() {
        let input = "X:1\n%%beginfoo\n%%endbar\nstill body\n%%endfoo\nK:C\n";
        let result = super::sanitize_abc_content(input);
        assert_eq!(result, "X:1\nK:C");
    }

    #[test]
    fn sanitize_abc_does_not_panic_on_multibyte_text_after_a_prefix() {
        for input in [
            "X:1\n%%é\nK:C\n",
            "X:1\nIé\nK:C\n",
            "X:1\n%%\u{feff}é x\nK:C\n",
        ] {
            let result = super::sanitize_abc_content(input);
            assert!(result.starts_with("X:1"), "{input:?}");
            assert!(result.ends_with("K:C"), "{input:?}");
        }
    }

    #[test]
    fn sanitize_lilypond_strips_system_call() {
        let input = "\\relative c' { c4 d e f }\n#(system \"echo pwned\")\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("system"));
        assert!(result.contains("\\relative"));
    }

    #[test]
    fn sanitize_lilypond_strips_getenv() {
        let input = "\\relative c' { c4 }\n#(getenv \"HOME\")\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("getenv"));
    }

    #[test]
    fn sanitize_lilypond_strips_file_access() {
        let input = "#(open-input-file \"/etc/passwd\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("open-input-file"));
        assert!(result.contains("\\relative"));
    }

    #[test]
    fn sanitize_lilypond_strips_ly_system() {
        let input = "\\relative c' { c4 }\n#(ly:system \"rm -rf /\")\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:system"));
    }

    #[test]
    fn sanitize_lilypond_case_insensitive() {
        let input = "#(SYSTEM \"echo pwned\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("SYSTEM"));
    }

    #[test]
    fn sanitize_lilypond_preserves_normal_content() {
        let input = "\\version \"2.24.0\"\n\\relative c' {\n  c4 d e f |\n  g2 g |\n}\n";
        let result = super::sanitize_lilypond_content(input);
        assert_eq!(
            result,
            "\\version \"2.24.0\"\n\\relative c' {\n  c4 d e f |\n  g2 g |\n}"
        );
    }

    #[test]
    fn sanitize_lilypond_strips_eval_string() {
        let input = "#(eval-string \"(system \\\"id\\\")\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("eval-string"));
    }

    #[test]
    fn sanitize_lilypond_strips_gulp_file() {
        let input = "#(ly:gulp-file \"/etc/passwd\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:gulp-file"));
    }

    #[test]
    fn sanitize_lilypond_strips_gulp_string() {
        // #1844: ly:gulp-string is the string-returning cousin of gulp-file.
        let input = "#(ly:gulp-string \"/etc/passwd\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:gulp-string"));
        assert!(result.contains("\\relative"));
    }

    #[test]
    fn sanitize_lilypond_preserves_ly_format() {
        // #1859: `ly:format` is a legitimate Guile `format`-equivalent
        // used in real scores; the compound threat that originally had
        // it on the blocklist (combining it with `ly:gulp-file`,
        // `ly:system`, `ly:parser-include`, …) already requires one of
        // those primitives, all of which remain independently blocked.
        // Lines that only use `ly:format` must pass through the
        // sanitizer untouched so legitimate content is not silently
        // truncated.
        let input = "#(ly:format \"~a\" \"x\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(
            result.contains("ly:format"),
            "ly:format on its own must be preserved; got {result:?}"
        );
        assert!(
            result.contains("\\relative"),
            "surrounding music content must also survive"
        );
    }

    #[test]
    fn sanitize_lilypond_strips_ly_exit() {
        // #1844: ly:exit terminates the process and masks tampering.
        let input = "#(ly:exit 0)\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:exit"));
    }

    #[test]
    fn sanitize_lilypond_strips_dollar_sign_system() {
        let input = "$(system \"echo pwned\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("system"));
        assert!(result.contains("\\relative"));
    }

    #[test]
    fn sanitize_lilypond_strips_dollar_sign_with_space() {
        let input = "$( system \"echo pwned\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("system"));
    }

    #[test]
    fn sanitize_lilypond_strips_dollar_sign_getenv() {
        let input = "$(getenv \"HOME\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("getenv"));
    }

    #[test]
    fn sanitize_lilypond_strips_dollar_sign_ly_system() {
        let input = "$(ly:system \"rm -rf /\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:system"));
    }

    #[test]
    fn sanitize_lilypond_dollar_sign_case_insensitive() {
        let input = "$(SYSTEM \"echo pwned\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("SYSTEM"));
    }

    #[test]
    fn sanitize_lilypond_strips_multi_space_scheme() {
        // Multiple spaces between #( or $( and the function name.
        let input = "#(  system \"rm -rf /\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("system"));

        let input2 = "$(   getenv \"SECRET\")\n\\relative c' { c4 }\n";
        let result2 = super::sanitize_lilypond_content(input2);
        assert!(!result2.contains("getenv"));
    }

    #[test]
    fn sanitize_lilypond_preserves_normal_dollar_sign() {
        // Dollar sign not followed by ( should be preserved.
        let input = "\\relative c' { c4$\\markup{test} }\n";
        let result = super::sanitize_lilypond_content(input);
        assert_eq!(result, "\\relative c' { c4$\\markup{test} }");
    }

    #[test]
    fn sanitize_lilypond_strips_load() {
        let input = "#(load \"/etc/lilypond-init.scm\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("load"));
    }

    #[test]
    fn sanitize_lilypond_strips_ly_parser_include() {
        let input = "#(ly:parser-include \"/etc/passwd\")\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:parser-include"));
    }

    #[test]
    fn sanitize_lilypond_strips_ly_set_option() {
        let input = "#(ly:set-option 'safe #f)\n\\relative c' { c4 }\n";
        let result = super::sanitize_lilypond_content(input);
        assert!(!result.contains("ly:set-option"));
    }

    #[test]
    #[ignore]
    fn perl_chordpro_detection() {
        assert!(has_perl_chordpro(), "chordpro (Perl) not found in PATH");
    }

    // -- sanitize_musicxml_content tests ------------------------------------

    #[test]
    fn sanitize_musicxml_strips_processing_instruction() {
        let input = r#"<?xml version="1.0" encoding="UTF-8"?><root/>"#;
        let result = super::sanitize_musicxml_content(input);
        assert!(!result.contains("<?xml"), "PI should be stripped");
        assert!(result.contains("<root/>"), "element content should remain");
    }

    #[test]
    fn sanitize_musicxml_strips_doctype() {
        let input =
            r#"<!DOCTYPE score-partwise PUBLIC "-//foo//bar" "http://evil.example/"><root/>"#;
        let result = super::sanitize_musicxml_content(input);
        assert!(!result.contains("DOCTYPE"), "DOCTYPE should be stripped");
        assert!(result.contains("<root/>"), "element content should remain");
    }

    #[test]
    fn sanitize_musicxml_strips_doctype_case_insensitive() {
        let input = "<!doctype foo><root/>";
        let result = super::sanitize_musicxml_content(input);
        assert!(
            !result.contains("doctype"),
            "doctype (lowercase) should be stripped"
        );
        assert!(result.contains("<root/>"));
    }

    #[test]
    fn sanitize_musicxml_preserves_normal_elements() {
        let input =
            "<score-partwise><part id=\"P1\"><measure number=\"1\"/></part></score-partwise>";
        let result = super::sanitize_musicxml_content(input);
        assert_eq!(result, input, "normal MusicXML should be preserved");
    }

    #[test]
    fn sanitize_musicxml_preserves_utf8_text() {
        let input = "<part>café naïve résumé</part>";
        let result = super::sanitize_musicxml_content(input);
        assert_eq!(result, input, "UTF-8 text content should be preserved");
    }

    #[test]
    fn sanitize_musicxml_strips_multiple_pis() {
        let input = "<?foo bar?><?baz quux?><root/>";
        let result = super::sanitize_musicxml_content(input);
        assert!(!result.contains("<?"), "all PIs should be stripped");
        assert!(result.contains("<root/>"));
    }

    #[test]
    fn sanitize_musicxml_strips_doctype_with_internal_subset() {
        // The bug in #1256: the old scanner stopped at the first `>` inside
        // `[…]`, leaving the residual `]>` in the output.
        let input = "<!DOCTYPE score-partwise [\
            <!ELEMENT score-partwise EMPTY>\
            ]><score-partwise/>";
        let result = super::sanitize_musicxml_content(input);
        assert!(!result.contains("DOCTYPE"), "DOCTYPE should be stripped");
        assert!(
            !result.contains(']'),
            "residual `]` from internal subset should not appear"
        );
        assert!(
            result.contains("<score-partwise/>"),
            "element content should remain"
        );
    }

    // -- collect_musescore_pages tests (#1262) --------------------------------

    /// RAII guard that removes a temp directory when dropped, even if a test panics.
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Create a unique temp dir for a test and return both the path and its guard.
    fn make_test_temp_dir(label: &str) -> (std::path::PathBuf, TempDirGuard) {
        let dir = std::env::temp_dir().join(format!(
            "test_ms_{label}_{}_{}_collect",
            std::process::id(),
            super::TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&dir).expect("failed to create test temp dir");
        let guard = TempDirGuard(dir.clone());
        (dir, guard)
    }

    #[test]
    fn collect_musescore_pages_single_page() {
        let (dir, _guard) = make_test_temp_dir("single");
        std::fs::write(dir.join("output-1.svg"), "<svg>page1</svg>").unwrap();
        let result = super::collect_musescore_pages(&dir).unwrap();
        assert!(
            result.contains("musicxml-page"),
            "page should be wrapped in musicxml-page div"
        );
        assert!(
            result.contains("<svg>page1</svg>"),
            "SVG content should be present"
        );
    }

    #[test]
    fn collect_musescore_pages_multi_page() {
        let (dir, _guard) = make_test_temp_dir("multi");
        std::fs::write(dir.join("output-1.svg"), "<svg>page1</svg>").unwrap();
        std::fs::write(dir.join("output-2.svg"), "<svg>page2</svg>").unwrap();
        let result = super::collect_musescore_pages(&dir).unwrap();
        assert_eq!(
            result.matches("musicxml-page").count(),
            2,
            "two pages should produce two wrapper divs"
        );
        assert!(
            result.contains("<svg>page1</svg>"),
            "page 1 SVG should be present"
        );
        assert!(
            result.contains("<svg>page2</svg>"),
            "page 2 SVG should be present"
        );
        // Pages must appear in order.
        let p1 = result.find("<svg>page1</svg>").unwrap();
        let p2 = result.find("<svg>page2</svg>").unwrap();
        assert!(p1 < p2, "page 1 should appear before page 2");
    }

    #[test]
    fn collect_musescore_pages_empty_dir_returns_empty_string() {
        let (dir, _guard) = make_test_temp_dir("empty");
        let result = super::collect_musescore_pages(&dir).unwrap();
        assert!(result.is_empty(), "no page files → empty string");
    }

    // -- musescore integration tests (#1258) ----------------------------------

    #[test]
    fn invoke_musescore_fails_gracefully_without_tool() {
        if has_musescore() {
            return; // Skip if musescore is installed
        }
        let mxl = "<score-partwise/>";
        let result = invoke_musescore(mxl);
        assert!(result.is_err(), "should fail without musescore installed");
    }

    #[test]
    #[ignore]
    fn musescore_detection() {
        assert!(has_musescore(), "mscore or musescore not found in PATH");
    }

    #[test]
    #[ignore]
    fn invoke_musescore_produces_svg() {
        let mxl = r#"<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Music</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>"#;
        let result = invoke_musescore(mxl);
        assert!(
            result.is_ok(),
            "invoke_musescore failed: {:?}",
            result.err()
        );
        let svg = result.unwrap();
        assert!(
            svg.contains("<svg") || svg.contains("<div class=\"musicxml-page\">"),
            "output should contain SVG or page wrapper"
        );
    }
}
