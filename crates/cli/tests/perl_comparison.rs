//! Text output compared against saved Perl ChordPro output.
//!
//! `tests/perl-baseline/text/` holds what Perl ChordPro (the release recorded
//! in `.github/upstream-version`) prints for every file in `tests/corpus/`.
//! This test renders the same files with ChordSketch, passes both outputs
//! through the normalisation below, and compares them. CI never runs Perl
//! (ADR-0040); the saved output is refreshed by
//! `scripts/update-perl-baseline.sh`.
//!
//! The comparison is a ratchet. A file whose output differs from Perl's after
//! normalisation must be listed, with a reason, in
//! `tests/perl-baseline/accepted-differences.txt`:
//!
//! - a differing file that is not listed fails the test (a regression);
//! - a listed file that now matches fails the test (remove it from the list);
//! - saved output made by another upstream release fails the test;
//! - a corpus file without saved output (and not listed as a Perl failure)
//!   fails the test.
//!
//! Two sections of `docs/known-deviations.md` are generated from the same
//! data and checked here. Run `scripts/update-perl-baseline.sh` to rewrite
//! them (it sets `UPDATE_KNOWN_DEVIATIONS=1`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use chordsketch_chordpro::config::Config;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/// Shared by both sides: LF line endings and straight quotes (Perl prints
/// typographic quotes, ChordSketch keeps what the file says).
fn unify(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace(['\u{2019}', '\u{2018}'], "'")
        .replace(['\u{201c}', '\u{201d}'], "\"")
}

/// Turns every run of hyphens that touches a space (or a line edge) into the
/// same number of spaces, so column positions survive. Perl fills the gap
/// after a chord-bearing syllable with hyphens (`la la-`, `-of ---this`).
fn blank_hyphen_runs(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '-' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i] == '-' {
            i += 1;
        }
        let after_space = start == 0 || chars[start - 1] == ' ';
        let before_space = i == chars.len() || chars[i] == ' ';
        let fill = if after_space || before_space {
            ' '
        } else {
            '-'
        };
        out.extend(std::iter::repeat_n(fill, i - start));
    }
    out
}

/// The leading run of word characters (`\w`) of `s`, if any.
fn leading_word(s: &str) -> Option<&str> {
    let end = s
        .char_indices()
        .find(|(_, c)| !(c.is_alphanumeric() || *c == '_'))
        .map_or(s.len(), |(i, _)| i);
    (end > 0).then(|| &s[..end])
}

/// Drops blank lines and trailing whitespace, then ends with one newline.
fn finish(lines: Vec<String>) -> String {
    let mut out = String::new();
    for line in lines {
        let line = line.trim_end();
        if !line.is_empty() {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Perl's text output, reduced to the form shared with ChordSketch's.
fn normalize_perl(raw: &str) -> String {
    let text = unify(raw);
    let mut out: Vec<String> = Vec::new();
    let mut last_chorus: Vec<String> = Vec::new();
    // Kind and body lines of the section being read.
    let mut current: Option<(String, Vec<String>)> = None;
    for line in text.split('\n') {
        if let Some(title) = line.strip_prefix("-- Title: ") {
            out.push(title.to_string());
            continue;
        }
        if let Some(kind) = line.strip_prefix("-- Start of ").and_then(leading_word) {
            out.push(format!("SECTION {kind}"));
            current = Some((kind.to_string(), Vec::new()));
            continue;
        }
        if line
            .strip_prefix("-- End of ")
            .and_then(leading_word)
            .is_some()
        {
            if let Some((kind, body)) = current.take()
                && kind == "chorus"
            {
                last_chorus = body;
            }
            continue;
        }
        if line.trim() == "{chorus}" {
            out.push("SECTION chorus".to_string());
            out.extend(last_chorus.iter().cloned());
            continue;
        }
        if let Some(subtitle) = line.strip_prefix("-- Subtitle: ") {
            out.push(subtitle.to_string());
            continue;
        }
        if matches!(line, "-- New page" | "-- Column break" | "-- New song") {
            continue;
        }
        if let Some(comment) = line.strip_prefix("-- ") {
            out.push(format!("COMMENT {comment}"));
            continue;
        }
        let line = blank_hyphen_runs(line);
        out.push(line.clone());
        if let Some((_, body)) = current.as_mut() {
            body.push(line);
        }
    }
    finish(out)
}

/// Metadata lines that only ChordSketch prints under the title.
const RUST_ONLY_METADATA: &[&str] = &[
    "Key",
    "Tempo",
    "Time",
    "Capo",
    "Duration",
    "Artist",
    "Album",
    "Year",
    "Composer",
    "Lyricist",
    "Copyright",
    "Sorttitle",
    "Subtitle",
];

/// `[Name]` or `[Name: label]`, where `Name` is one capitalised word.
fn section_header(inner: &str) -> Option<&str> {
    let mut chars = inner.char_indices();
    let (_, first) = chars.next()?;
    if !first.is_ascii_uppercase() {
        return None;
    }
    let name_end = chars
        .find(|(_, c)| !c.is_ascii_lowercase())
        .map_or(inner.len(), |(i, _)| i);
    let rest = &inner[name_end..];
    (rest.is_empty() || rest.starts_with(": ")).then(|| &inner[..name_end])
}

/// ChordSketch's text output, reduced to the form shared with Perl's.
fn normalize_rust(raw: &str) -> String {
    let text = unify(raw);
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let bracketed = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'));
        if line.starts_with("[Image: ") {
            continue;
        }
        if let Some(inner) = bracketed {
            if RUST_ONLY_METADATA
                .iter()
                .any(|key| inner.starts_with(&format!("{key}: ")))
            {
                continue;
            }
            if let Some(name) = section_header(inner) {
                out.push(format!("SECTION {}", name.to_lowercase()));
                continue;
            }
            if !line.starts_with("[SVG") {
                out.push(format!("COMMENT {inner}"));
                continue;
            }
        }
        if line.starts_with('|') {
            continue;
        }
        if let Some(inner) = line
            .strip_prefix('(')
            .and_then(|rest| rest.strip_suffix(')'))
        {
            let comment = match inner.strip_prefix('*') {
                Some(italic) => italic.strip_suffix('*').unwrap_or(italic),
                None => inner,
            };
            out.push(format!("COMMENT {comment}"));
            continue;
        }
        out.push(blank_hyphen_runs(line));
    }
    finish(out)
}

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Outcome {
    Identical,
    Different { report: String },
    PerlFailed,
    NoBaseline,
}

/// What is wrong, given what each corpus file compared as and the accepted
/// differences. Empty when the ratchet holds.
fn problems(
    outcomes: &BTreeMap<String, Outcome>,
    accepted: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut found = Vec::new();
    for (file, outcome) in outcomes {
        let is_accepted = accepted.contains_key(file);
        match outcome {
            Outcome::Identical if is_accepted => found.push(format!(
                "{file} now matches Perl: remove it from tests/perl-baseline/accepted-differences.txt"
            )),
            Outcome::Different { report } if !is_accepted => found.push(format!(
                "{file} differs from Perl and is not in tests/perl-baseline/accepted-differences.txt:\n{report}"
            )),
            Outcome::NoBaseline => found.push(format!(
                "{file} has no saved Perl output: run scripts/update-perl-baseline.sh"
            )),
            Outcome::PerlFailed if is_accepted => found.push(format!(
                "{file} is accepted as different, but Perl failed on it: remove it from tests/perl-baseline/accepted-differences.txt"
            )),
            _ => {}
        }
    }
    for file in accepted.keys() {
        if !outcomes.contains_key(file) {
            found.push(format!(
                "{file} is in tests/perl-baseline/accepted-differences.txt but not in tests/corpus"
            ));
        }
    }
    found
}

/// Saved output from another upstream release than the one in use.
fn version_problem(saved: &str, upstream: &str) -> Option<String> {
    (saved.trim() != upstream.trim()).then(|| {
        format!(
            "the saved Perl output is from {}, but .github/upstream-version is {}: \
             run scripts/update-perl-baseline.sh with that release installed",
            saved.trim(),
            upstream.trim()
        )
    })
}

/// The first few lines where the two normalised outputs differ.
fn report_difference(perl: &str, rust: &str) -> String {
    const SHOWN: usize = 4;
    let perl: Vec<&str> = perl.lines().collect();
    let rust: Vec<&str> = rust.lines().collect();
    let mut shown = Vec::new();
    let mut total = 0;
    for i in 0..perl.len().max(rust.len()) {
        let (p, r) = (perl.get(i).copied(), rust.get(i).copied());
        if p != r {
            total += 1;
            if shown.len() < SHOWN {
                shown.push(format!(
                    "  line {}: perl {:?} / chordsketch {:?}",
                    i + 1,
                    p.unwrap_or("<missing>"),
                    r.unwrap_or("<missing>")
                ));
            }
        }
    }
    if total > shown.len() {
        shown.push(format!(
            "  ... {} more differing lines",
            total - shown.len()
        ));
    }
    shown.join("\n")
}

// ---------------------------------------------------------------------------
// Generated sections of docs/known-deviations.md
// ---------------------------------------------------------------------------

fn marker(name: &str, edge: &str) -> String {
    format!("<!-- perl-compare:{name}:{edge} -->")
}

/// Replaces what sits between the `name` markers of `doc`.
fn replace_section(doc: &str, name: &str, content: &str) -> Result<String, String> {
    let (start, end) = (marker(name, "start"), marker(name, "end"));
    let from = doc
        .find(&start)
        .ok_or_else(|| format!("missing {start} in docs/known-deviations.md"))?
        + start.len();
    let to = doc[from..]
        .find(&end)
        .map(|i| from + i)
        .ok_or_else(|| format!("missing {end} in docs/known-deviations.md"))?;
    Ok(format!(
        "{}\n{}\n{}",
        &doc[..from],
        content.trim_end(),
        &doc[to..]
    ))
}

fn summary_section(outcomes: &BTreeMap<String, Outcome>) -> String {
    let count = |want: fn(&Outcome) -> bool| outcomes.values().filter(|o| want(o)).count();
    let identical = count(|o| matches!(o, Outcome::Identical));
    let different = count(|o| matches!(o, Outcome::Different { .. }));
    let failed = count(|o| matches!(o, Outcome::PerlFailed));
    format!(
        "| Format | Identical after normalisation | Different (listed below) | Perl failed to render |\n\
         |--------|-------------------------------|--------------------------|-----------------------|\n\
         | `text` | {identical} | {different} | {failed} |"
    )
}

fn accepted_section(accepted: &BTreeMap<String, String>) -> String {
    let mut out =
        String::from("| File | Why the output differs |\n|------|------------------------|\n");
    for (file, reason) in accepted {
        out.push_str(&format!("| `{file}` | {reason} |\n"));
    }
    out
}

fn perl_failed_section(outcomes: &BTreeMap<String, Outcome>) -> String {
    outcomes
        .iter()
        .filter(|(_, o)| **o == Outcome::PerlFailed)
        .map(|(file, _)| format!("- `{file}`\n"))
        .collect()
}

fn refresh_known_deviations(
    doc: &str,
    outcomes: &BTreeMap<String, Outcome>,
    accepted: &BTreeMap<String, String>,
) -> Result<String, String> {
    let doc = replace_section(doc, "summary", &summary_section(outcomes))?;
    let doc = replace_section(&doc, "accepted", &accepted_section(accepted))?;
    replace_section(&doc, "perl-failed", &perl_failed_section(outcomes))
}

// ---------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// Corpus files, as paths relative to `tests/corpus/` with `/` separators.
fn corpus_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if entry.path().is_dir() {
                walk(&entry.path(), &relative, out);
            } else if name.ends_with(".cho") {
                out.push(relative);
            }
        }
    }
    let mut files = Vec::new();
    walk(&root.join("tests/corpus"), "", &mut files);
    files.sort();
    files
}

/// Non-blank, non-comment lines of a list file.
fn list_lines(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

fn read_accepted(root: &Path) -> BTreeMap<String, String> {
    let path = root.join("tests/perl-baseline/accepted-differences.txt");
    list_lines(&read(&path))
        .into_iter()
        .map(|line| {
            let (file, reason) = line
                .split_once(" | ")
                .unwrap_or_else(|| panic!("expected `<file> | <reason>`, got {line:?}"));
            (file.trim().to_string(), reason.trim().to_string())
        })
        .collect()
}

fn render_with_chordsketch(source: &str) -> String {
    let songs: Vec<_> = chordsketch_chordpro::parse_multi_lenient(source)
        .results
        .into_iter()
        .map(|r| r.song)
        .collect();
    chordsketch_render_text::render_songs_with_warnings(&songs, 0, &Config::defaults()).output
}

/// How each corpus file compares, plus problems found while reading the
/// baseline itself.
fn compare_corpus(root: &Path) -> (BTreeMap<String, Outcome>, Vec<String>) {
    let baseline = root.join("tests/perl-baseline");
    let failed: BTreeSet<String> = list_lines(&read(&baseline.join("perl-failed.txt")))
        .into_iter()
        .map(String::from)
        .collect();
    let files = corpus_files(root);
    let mut extra = Vec::new();
    for file in &failed {
        if !files.contains(file) {
            extra.push(format!(
                "{file} is in tests/perl-baseline/perl-failed.txt but not in tests/corpus"
            ));
        }
    }
    let mut outcomes = BTreeMap::new();
    for file in files {
        let saved = baseline.join("text").join(file.replace(".cho", ".txt"));
        let outcome = if failed.contains(&file) {
            if saved.exists() {
                extra.push(format!(
                    "{file} is listed as a Perl failure but has saved Perl output"
                ));
            }
            Outcome::PerlFailed
        } else if !saved.exists() {
            Outcome::NoBaseline
        } else {
            let source = read(&root.join("tests/corpus").join(&file));
            let perl = normalize_perl(&read(&saved));
            let rust = normalize_rust(&render_with_chordsketch(&source));
            if perl == rust {
                Outcome::Identical
            } else {
                Outcome::Different {
                    report: report_difference(&perl, &rust),
                }
            }
        };
        outcomes.insert(file, outcome);
    }
    (outcomes, extra)
}

// ---------------------------------------------------------------------------
// Tests on the repository
// ---------------------------------------------------------------------------

#[test]
fn the_corpus_matches_the_saved_perl_output_except_for_accepted_differences() {
    let root = repo_root();
    let (outcomes, mut found) = compare_corpus(&root);
    found.extend(problems(&outcomes, &read_accepted(&root)));
    assert!(found.is_empty(), "\n{}\n", found.join("\n"));
}

#[test]
fn the_saved_perl_output_is_from_the_upstream_version_in_use() {
    let root = repo_root();
    let saved = read(&root.join("tests/perl-baseline/perl-version"));
    let upstream = read(&root.join(".github/upstream-version"));
    if let Some(problem) = version_problem(&saved, &upstream) {
        panic!("{problem}");
    }
}

#[test]
fn every_accepted_difference_has_a_reason() {
    for (file, reason) in read_accepted(&repo_root()) {
        assert!(
            reason.len() > 10,
            "{file} needs a reason in accepted-differences.txt"
        );
    }
}

#[test]
fn known_deviations_sections_match_the_baseline() {
    let root = repo_root();
    let (outcomes, _) = compare_corpus(&root);
    let path = root.join("docs/known-deviations.md");
    let doc = read(&path);
    let expected = refresh_known_deviations(&doc, &outcomes, &read_accepted(&root)).unwrap();
    if std::env::var_os("UPDATE_KNOWN_DEVIATIONS").is_some() {
        fs::write(&path, expected).unwrap();
    } else {
        assert!(
            doc == expected,
            "the generated sections of docs/known-deviations.md are out of date: \
             run scripts/update-perl-baseline.sh"
        );
    }
}

// ---------------------------------------------------------------------------
// Tests on the rules and the ratchet (synthetic input)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod rules {
    use super::*;

    #[test]
    fn straight_and_typographic_quotes_compare_equal_on_both_sides() {
        assert_eq!(
            normalize_perl("I\u{2019}ve \u{201c}gone\u{201d}\n"),
            "I've \"gone\"\n"
        );
        assert_eq!(normalize_rust("I've \"gone\"\n"), "I've \"gone\"\n");
    }

    #[test]
    fn windows_line_endings_compare_equal_to_unix_ones() {
        assert_eq!(normalize_rust("a\r\nb\r\n"), "a\nb\n");
    }

    #[test]
    fn a_perl_title_and_subtitle_compare_equal_to_plain_heading_lines() {
        assert_eq!(
            normalize_perl("-- Title: Song\n-- Subtitle: Sub\n"),
            "Song\nSub\n"
        );
        assert_eq!(normalize_rust("Song\nSub\n"), "Song\nSub\n");
    }

    #[test]
    fn a_perl_section_compares_equal_to_a_bracketed_header_without_its_end_line() {
        let perl = normalize_perl("-- Start of verse\nla\n-- End of verse\n");
        let rust = normalize_rust("[Verse]\nla\n");
        assert_eq!(perl, "SECTION verse\nla\n");
        assert_eq!(rust, perl);
    }

    #[test]
    fn a_labelled_section_compares_equal_to_a_labelled_header() {
        assert_eq!(
            normalize_perl("-- Start of verse: Verse 1\n"),
            "SECTION verse\n"
        );
        assert_eq!(normalize_rust("[Verse: Verse 1]\n"), "SECTION verse\n");
    }

    #[test]
    fn the_three_comment_styles_compare_equal_to_perls_dashed_comment() {
        let perl = normalize_perl("-- Play softly\n");
        assert_eq!(perl, "COMMENT Play softly\n");
        for rust in ["(Play softly)\n", "(*Play softly*)\n", "[Play softly]\n"] {
            assert_eq!(normalize_rust(rust), perl, "{rust:?}");
        }
    }

    #[test]
    fn a_perl_chorus_recall_compares_equal_to_the_repeated_chorus() {
        let perl = normalize_perl(
            "-- Start of chorus\nla la\n-- End of chorus\n\n-- Start of verse\nv\n-- End of verse\n{chorus}\n",
        );
        let rust = normalize_rust("[Chorus]\nla la\n\n[Verse]\nv\n\n[Chorus]\nla la\n");
        assert_eq!(rust, perl);
    }

    #[test]
    fn hyphen_fill_next_to_a_space_compares_equal_to_blank_space() {
        assert_eq!(normalize_perl("la la la-\n"), "la la la\n");
        assert_eq!(normalize_perl("-of ---this\n"), " of    this\n");
    }

    #[test]
    fn a_hyphen_inside_a_word_is_kept() {
        assert_eq!(normalize_perl("well-known\n"), "well-known\n");
        assert_eq!(normalize_rust("well-known\n"), "well-known\n");
    }

    #[test]
    fn a_hyphen_next_to_a_space_compares_equal_on_both_sides() {
        assert_eq!(
            normalize_rust("- Start softly\n"),
            normalize_perl("- Start softly\n")
        );
        assert_eq!(normalize_rust("A-    Am\n"), normalize_perl("A-    Am\n"));
    }

    #[test]
    fn blank_lines_and_trailing_spaces_do_not_count() {
        assert_eq!(normalize_perl("a  \n\n\nb\n"), "a\nb\n");
        assert_eq!(normalize_rust("a\n\nb   \n"), "a\nb\n");
    }

    #[test]
    fn metadata_lines_only_chordsketch_prints_are_dropped() {
        let rust = normalize_rust(
            "Song\n[Key: G major]\n[Tempo: 120 BPM (Allegro)]\n[Time: 4/4]\n[Artist: A]\nla\n",
        );
        assert_eq!(rust, "Song\nla\n");
    }

    #[test]
    fn image_lines_only_chordsketch_prints_are_dropped() {
        assert_eq!(normalize_rust("[Image: photo.png]\nla\n"), "la\n");
    }

    #[test]
    fn grid_rows_only_chordsketch_prints_are_dropped() {
        assert_eq!(normalize_rust("| G . . . | C . . . |\nla\n"), "la\n");
    }

    #[test]
    fn page_column_and_song_separators_perl_prints_are_dropped() {
        assert_eq!(
            normalize_perl("a\n-- New page\n-- Column break\n-- New song\nb\n"),
            "a\nb\n"
        );
    }

    #[test]
    fn a_changed_chord_still_makes_the_outputs_differ() {
        let perl = normalize_perl("G     C\nla la\n");
        assert_ne!(normalize_rust("G     D\nla la\n"), perl);
    }

    #[test]
    fn a_moved_chord_still_makes_the_outputs_differ() {
        let perl = normalize_perl("G     C\nla la la\n");
        assert_ne!(normalize_rust("G    C\nla la la\n"), perl);
    }

    #[test]
    fn a_changed_lyric_still_makes_the_outputs_differ() {
        assert_ne!(normalize_rust("la la\n"), normalize_perl("la lo\n"));
    }

    #[test]
    fn a_reordered_section_still_makes_the_outputs_differ() {
        let perl = normalize_perl(
            "-- Start of verse\n-- End of verse\n-- Start of chorus\n-- End of chorus\n",
        );
        assert_ne!(normalize_rust("[Chorus]\n[Verse]\n"), perl);
    }

    fn outcomes(entries: &[(&str, Outcome)]) -> BTreeMap<String, Outcome> {
        entries
            .iter()
            .map(|(f, o)| (f.to_string(), o.clone()))
            .collect()
    }

    fn accepted(files: &[&str]) -> BTreeMap<String, String> {
        files
            .iter()
            .map(|f| (f.to_string(), "because".to_string()))
            .collect()
    }

    fn different() -> Outcome {
        Outcome::Different {
            report: "  line 1".to_string(),
        }
    }

    #[test]
    fn a_file_that_differs_and_is_not_accepted_fails_the_ratchet() {
        let found = problems(&outcomes(&[("a.cho", different())]), &accepted(&[]));
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("a.cho differs from Perl"), "{found:?}");
    }

    #[test]
    fn an_accepted_file_that_now_matches_fails_the_ratchet() {
        let found = problems(
            &outcomes(&[("a.cho", Outcome::Identical)]),
            &accepted(&["a.cho"]),
        );
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("remove it"), "{found:?}");
    }

    #[test]
    fn an_accepted_file_that_still_differs_passes_the_ratchet() {
        assert!(problems(&outcomes(&[("a.cho", different())]), &accepted(&["a.cho"])).is_empty());
    }

    #[test]
    fn a_corpus_file_without_saved_perl_output_fails_the_ratchet() {
        let found = problems(
            &outcomes(&[("new.cho", Outcome::NoBaseline)]),
            &accepted(&[]),
        );
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("no saved Perl output"), "{found:?}");
    }

    #[test]
    fn an_accepted_file_that_is_not_in_the_corpus_fails_the_ratchet() {
        let found = problems(&outcomes(&[]), &accepted(&["gone.cho"]));
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("not in tests/corpus"), "{found:?}");
    }

    #[test]
    fn an_accepted_file_that_perl_cannot_render_fails_the_ratchet() {
        let found = problems(
            &outcomes(&[("a.cho", Outcome::PerlFailed)]),
            &accepted(&["a.cho"]),
        );
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_perl_failure_that_is_not_accepted_passes_the_ratchet() {
        assert!(problems(&outcomes(&[("a.cho", Outcome::PerlFailed)]), &accepted(&[])).is_empty());
    }

    #[test]
    fn saved_output_from_another_upstream_version_fails_the_version_check() {
        assert!(version_problem("R6.100.0\n", "R6.101.0\n").is_some());
    }

    #[test]
    fn saved_output_from_the_upstream_version_in_use_passes_the_version_check() {
        assert!(version_problem("R6.101.0\n", "R6.101.0\n").is_none());
    }

    #[test]
    fn the_difference_report_names_the_first_differing_lines() {
        let report = report_difference("a\nb\nc\n", "a\nx\nc\nd\n");
        assert!(
            report.contains("line 2: perl \"b\" / chordsketch \"x\""),
            "{report}"
        );
        assert!(report.contains("line 4: perl \"<missing>\""), "{report}");
    }

    #[test]
    fn a_generated_section_is_replaced_between_its_markers_only() {
        let doc =
            "before\n<!-- perl-compare:x:start -->\nold\n<!-- perl-compare:x:end -->\nafter\n";
        let new = replace_section(doc, "x", "new").unwrap();
        assert_eq!(
            new,
            "before\n<!-- perl-compare:x:start -->\nnew\n<!-- perl-compare:x:end -->\nafter\n"
        );
    }

    #[test]
    fn a_document_without_the_markers_is_reported() {
        assert!(replace_section("plain\n", "x", "new").is_err());
    }

    #[test]
    fn the_summary_counts_identical_different_and_failed_files() {
        let table = summary_section(&outcomes(&[
            ("a.cho", Outcome::Identical),
            ("b.cho", Outcome::Identical),
            ("c.cho", different()),
            ("d.cho", Outcome::PerlFailed),
        ]));
        assert!(table.ends_with("| `text` | 2 | 1 | 1 |"), "{table}");
    }
}
