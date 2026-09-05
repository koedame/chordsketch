//! The ChordPro operations the MCP tools expose, as plain Rust functions.
//!
//! This module holds every call into the ChordSketch workspace crates and
//! knows nothing about MCP. [`ChordSketchServer`](crate::ChordSketchServer)
//! is the protocol adapter on top of it: it converts arguments, calls into
//! here, and wraps the result in a tool response. Keeping the split means
//! the behaviour of every tool is unit-testable without a transport, a
//! runtime, or a peer.
//!
//! Every operation takes ChordPro source as a string. Nothing in this
//! module opens a file, reads an environment variable, or resolves a
//! configuration path: renders run against [`Config::defaults`], the
//! built-in configuration, so a running server has no filesystem surface
//! at all.

use chordsketch_chordpro::ParseOptions;
use chordsketch_chordpro::config::Config;
use chordsketch_chordpro::json::ToJson;

/// Maximum accepted size of a `source` argument, in bytes.
///
/// Derived from the parser's own limit
/// ([`ParseOptions::max_input_size`], 10 MiB) so the two cannot drift:
/// a source the server accepts is a source the parser accepts. Callers
/// are expected to reject oversized input before doing any work — see
/// [`check_source_size`].
#[must_use]
pub fn max_source_bytes() -> usize {
    ParseOptions::default().max_input_size
}

/// Returns `Err` with a caller-facing message when `source` is larger
/// than [`max_source_bytes`].
///
/// # Errors
///
/// Returns the rejection message when the limit is exceeded.
pub fn check_source_size(source: &str) -> Result<(), String> {
    let limit = max_source_bytes();
    if source.len() > limit {
        return Err(format!(
            "source is {} bytes, which exceeds the {} byte limit",
            source.len(),
            limit
        ));
    }
    Ok(())
}

/// The rendered output formats the server exposes.
///
/// PDF is deliberately absent: a PDF is bytes, and the only way to
/// return bytes over MCP is to base64-encode them into the model's
/// context, where they are unreadable and expensive. The CLI
/// (`chordsketch -f pdf song.cho -o song.pdf`) is the PDF path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderFormat {
    /// Chords positioned above lyrics, as plain text.
    Text,
    /// A self-contained HTML document.
    Html,
}

impl RenderFormat {
    /// Parses the wire-level format name.
    ///
    /// # Errors
    ///
    /// Returns a caller-facing message when `name` is not a known format.
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "text" => Ok(Self::Text),
            "html" => Ok(Self::Html),
            other => Err(format!(
                "unknown format {other:?}; expected \"text\" or \"html\""
            )),
        }
    }
}

/// An output plus the semantic warnings the renderer raised while
/// producing it.
///
/// Warnings are advisory — the output is complete and usable. They are
/// carried separately (rather than folded into the output) so a caller
/// can show the chart and the diagnostics independently.
#[derive(Debug, Clone)]
pub struct Rendered {
    /// The rendered chart.
    pub output: String,
    /// Semantic warnings, in the order the renderer raised them.
    pub warnings: Vec<String>,
}

/// A parse error, positioned in the source.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Diagnostic {
    /// 1-based line number.
    pub line: usize,
    /// 1-based column number.
    pub column: usize,
    /// What the parser could not make sense of.
    pub message: String,
}

/// The result of checking a source for problems.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Validation {
    /// Structural problems the parser recovered from. A source with no
    /// entries here is syntactically valid ChordPro.
    pub errors: Vec<Diagnostic>,
    /// Semantic warnings raised while rendering — an unparseable
    /// `{transpose}` value, an out-of-range `{capo}`, an ambiguous chord
    /// spelling. The source still renders.
    pub warnings: Vec<String>,
}

/// One entry of the directive catalog.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirectiveInfo {
    /// Canonical long-form name, without braces.
    pub name: String,
    /// Short forms accepted for the same directive (`t` for `title`).
    pub aliases: Vec<String>,
    /// One of `none`, `freeform`, or `enum`.
    pub value_kind: String,
    /// The allowed values when `value_kind` is `enum`; empty otherwise.
    pub values: Vec<String>,
    /// One-line description of what the directive does.
    pub summary: String,
}

/// Renders ChordPro source to text or HTML, transposing by
/// `transpose` semitones.
///
/// Multi-song input (segments separated by `{new_song}`) renders into a
/// single document, matching the CLI. `transpose` composes with any
/// `{transpose}` directive in the source the same way `chordsketch -t N`
/// does.
#[must_use]
pub fn render(source: &str, format: RenderFormat, transpose: i8) -> Rendered {
    let config = Config::defaults();
    let songs = parse_songs(source);
    let result = match format {
        RenderFormat::Text => {
            chordsketch_render_text::render_songs_with_warnings(&songs, transpose, &config)
        }
        RenderFormat::Html => {
            chordsketch_render_html::render_songs_with_warnings(&songs, transpose, &config)
        }
    };
    Rendered {
        output: result.output,
        warnings: result.warnings,
    }
}

/// Parses ChordPro source and returns the syntax tree as a JSON
/// document, plus any recoverable parse warnings.
///
/// The tree is the parser's own AST, serialised by
/// [`chordsketch_chordpro::json`]. It is not transposed and its `{key}`
/// directives are not canonicalised — this is what the file says, not
/// what a preview would show.
#[must_use]
pub fn parse_ast(source: &str) -> Rendered {
    let result = chordsketch_chordpro::parse_lenient(source);
    Rendered {
        output: result.song.to_json_string(),
        warnings: result.errors.iter().map(ToString::to_string).collect(),
    }
}

/// Checks ChordPro source for structural errors and semantic warnings.
///
/// Both layers are reported together because they answer one question —
/// "is anything wrong with this file?" — with different severities: an
/// entry in `errors` means the parser had to recover, an entry in
/// `warnings` means the file renders but something in it is suspect.
#[must_use]
pub fn validate(source: &str) -> Validation {
    let parsed = chordsketch_chordpro::parse_multi_lenient(source);
    let errors = parsed
        .results
        .iter()
        .flat_map(|r| r.errors.iter())
        .map(|e| Diagnostic {
            line: e.line(),
            column: e.column(),
            message: e.message.clone(),
        })
        .collect();
    // The renderer is what raises semantic warnings, so validation runs
    // one: the text renderer, because it is the cheapest of the three
    // and every warning is raised before any format-specific work.
    let songs: Vec<_> = parsed.results.into_iter().map(|r| r.song).collect();
    let rendered =
        chordsketch_render_text::render_songs_with_warnings(&songs, 0, &Config::defaults());
    Validation {
        errors,
        warnings: rendered.warnings,
    }
}

/// Normalises ChordPro source: long-form directive names, capitalised
/// chord roots, one blank line between sections.
///
/// Equivalent to `chordsketch fmt`. The result is always valid ChordPro
/// and formatting it again changes nothing.
#[must_use]
pub fn format_source(source: &str) -> String {
    chordsketch_chordpro::format_chordpro(
        source,
        &chordsketch_chordpro::formatter::FormatOptions::default(),
    )
}

/// Renders a chord diagram for `chord` on `instrument` as an SVG
/// fragment.
///
/// `instrument` accepts `guitar`, `ukulele` (alias `uke`), and `piano`
/// (aliases `keyboard`, `keys`), case-insensitively. Returns `Ok(None)`
/// when the chord is known but no voicing can be drawn for it on that
/// instrument.
///
/// # Errors
///
/// Returns a caller-facing message when `instrument` is not one of the
/// accepted names.
pub fn chord_diagram_svg(chord: &str, instrument: &str) -> Result<Option<String>, String> {
    use chordsketch_chordpro::chord_diagram::{
        DiagramSize, render_keyboard_svg_with_size, render_svg_with_options, resolve_orientation,
    };
    use chordsketch_chordpro::voicings::{lookup_diagram, lookup_keyboard_voicing};

    // Regular size and the project-default orientation, so a diagram
    // returned here matches the one the HTML renderer draws for the same
    // chord. `frets_shown = 5` is the same constant `crates/render-html`
    // uses when no `{chordfrets}` directive is set.
    let orientation = resolve_orientation(None);
    match instrument.to_ascii_lowercase().as_str() {
        "piano" | "keyboard" | "keys" => Ok(lookup_keyboard_voicing(chord, &[])
            .map(|v| render_keyboard_svg_with_size(&v, DiagramSize::Regular))),
        instrument @ ("guitar" | "ukulele" | "uke") => {
            Ok(lookup_diagram(chord, &[], instrument, 5)
                .map(|d| render_svg_with_options(&d, orientation, DiagramSize::Regular)))
        }
        other => Err(format!(
            "unknown instrument {other:?}; expected one of \"guitar\", \"ukulele\", \"piano\""
        )),
    }
}

/// Returns every directive the parser knows, with its aliases and
/// allowed values.
///
/// This is the vocabulary for writing ChordPro, so a caller can check a
/// directive exists — and what it accepts — before emitting it.
#[must_use]
pub fn directives() -> Vec<DirectiveInfo> {
    use chordsketch_chordpro::directive_catalog::{self, DirectiveValueKind};
    directive_catalog::directives()
        .iter()
        .map(|d| {
            let (value_kind, values) = match d.value {
                DirectiveValueKind::None => ("none", Vec::new()),
                DirectiveValueKind::FreeForm => ("freeform", Vec::new()),
                DirectiveValueKind::Enum(vs) => {
                    ("enum", vs.iter().map(|v| (*v).to_string()).collect())
                }
            };
            DirectiveInfo {
                name: d.name.to_string(),
                aliases: d.aliases.iter().map(|a| (*a).to_string()).collect(),
                value_kind: value_kind.to_string(),
                values,
                summary: d.summary.to_string(),
            }
        })
        .collect()
}

/// Parses `source` into the song list every renderer takes, splitting at
/// `{new_song}` boundaries the way the CLI does.
fn parse_songs(source: &str) -> Vec<chordsketch_chordpro::ast::Song> {
    chordsketch_chordpro::parse_multi_lenient(source)
        .results
        .into_iter()
        .map(|r| r.song)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONG: &str =
        "{title: Scarborough Fair}\n{key: Em}\nAre you [Em]going to [G]Scarborough [Em]Fair\n";

    #[test]
    fn rendering_a_song_to_text_puts_its_chords_above_the_lyrics() {
        let rendered = render(SONG, RenderFormat::Text, 0);
        let lines: Vec<&str> = rendered.output.lines().collect();
        let chord_line = lines
            .iter()
            .position(|l| l.contains("Em") && l.contains('G'))
            .expect("a chord line is rendered");
        assert!(
            lines[chord_line + 1].contains("Scarborough"),
            "the lyric line follows the chord line, got {:?}",
            &lines[chord_line..]
        );
        assert!(rendered.warnings.is_empty(), "a clean song warns nothing");
    }

    #[test]
    fn rendering_a_song_to_html_returns_a_document_carrying_its_title() {
        let rendered = render(SONG, RenderFormat::Html, 0);
        assert!(
            rendered.output.contains("<html"),
            "html output is a document"
        );
        assert!(rendered.output.contains("Scarborough Fair"));
    }

    #[test]
    fn rendering_with_a_transpose_shifts_every_chord_by_that_many_semitones() {
        let rendered = render("[C]Hello [G]world\n", RenderFormat::Text, 2);
        assert!(
            rendered.output.contains('D') && rendered.output.contains('A'),
            "C and G transposed up two semitones are D and A, got {:?}",
            rendered.output
        );
        assert!(
            !rendered.output.contains('C'),
            "no chord is left at the original pitch, got {:?}",
            rendered.output
        );
    }

    #[test]
    fn rendering_with_a_negative_transpose_shifts_the_chords_down() {
        let rendered = render("[D]Hello\n", RenderFormat::Text, -2);
        assert!(rendered.output.contains('C'), "got {:?}", rendered.output);
    }

    #[test]
    fn rendering_a_song_whose_transpose_directive_is_not_a_number_reports_a_warning() {
        let rendered = render("{transpose: up2}\n[C]Hello\n", RenderFormat::Text, 0);
        assert!(
            rendered.warnings.iter().any(|w| w.contains("up2")),
            "the unparseable value is named in a warning, got {:?}",
            rendered.warnings
        );
        assert!(
            rendered.output.contains('C'),
            "the song still renders at its original pitch"
        );
    }

    #[test]
    fn parsing_a_song_returns_a_json_tree_carrying_its_metadata() {
        let parsed = parse_ast(SONG);
        let value: serde_json::Value =
            serde_json::from_str(&parsed.output).expect("the tree is valid JSON");
        assert_eq!(
            value["metadata"]["title"], "Scarborough Fair",
            "the title is on the tree, got {value}"
        );
        assert!(parsed.warnings.is_empty(), "a clean song warns nothing");
    }

    #[test]
    fn parsing_a_song_with_an_unclosed_directive_still_returns_a_tree_and_warns() {
        let parsed = parse_ast("{title: Test}\n{bad\n[G]Hello\n");
        assert!(
            !parsed.warnings.is_empty(),
            "the unclosed directive is reported"
        );
        let value: serde_json::Value =
            serde_json::from_str(&parsed.output).expect("the tree is still valid JSON");
        assert_eq!(value["metadata"]["title"], "Test");
    }

    #[test]
    fn validating_a_clean_song_reports_no_errors_and_no_warnings() {
        let result = validate(SONG);
        assert!(result.errors.is_empty(), "got {:?}", result.errors);
        assert!(result.warnings.is_empty(), "got {:?}", result.warnings);
    }

    #[test]
    fn validating_a_song_with_an_unclosed_directive_reports_a_positioned_error() {
        let result = validate("{title: Test}\n{bad\n[G]Hello\n");
        let first = result.errors.first().expect("an error is reported");
        assert_eq!(first.line, 2, "the error points at the offending line");
        assert!(first.column >= 1, "columns are 1-based");
        assert!(!first.message.is_empty());
    }

    #[test]
    fn validating_a_song_with_an_ambiguous_chord_reports_it_as_a_warning_not_an_error() {
        let result = validate("[G13]Hello\n");
        assert!(
            result.errors.is_empty(),
            "an ambiguous chord still parses, got {:?}",
            result.errors
        );
        assert!(
            result.warnings.iter().any(|w| w.contains("G13")),
            "it is flagged as a warning, got {:?}",
            result.warnings
        );
    }

    #[test]
    fn formatting_a_song_expands_short_directives_and_capitalises_chord_roots() {
        let formatted = format_source("{t: Test}\n[am]Hello\n");
        assert!(formatted.contains("{title: Test}"), "got {formatted:?}");
        assert!(formatted.contains("[Am]"), "got {formatted:?}");
    }

    #[test]
    fn formatting_an_already_formatted_song_changes_nothing() {
        let once = format_source("{t: Test}\n[am]Hello\n");
        assert_eq!(format_source(&once), once);
    }

    #[test]
    fn asking_for_a_guitar_diagram_of_a_known_chord_returns_an_svg() {
        let svg = chord_diagram_svg("Am", "guitar")
            .expect("guitar is a known instrument")
            .expect("Am has a guitar voicing");
        assert!(
            svg.starts_with("<svg"),
            "got {:?}",
            &svg[..svg.len().min(40)]
        );
    }

    #[test]
    fn asking_for_a_piano_diagram_returns_a_different_svg_than_the_guitar_one() {
        let piano = chord_diagram_svg("Am", "piano")
            .expect("piano is a known instrument")
            .expect("Am has a keyboard voicing");
        let guitar = chord_diagram_svg("Am", "guitar").unwrap().unwrap();
        assert!(piano.starts_with("<svg"));
        assert_ne!(piano, guitar, "each instrument draws its own diagram");
    }

    #[test]
    fn instrument_names_are_accepted_case_insensitively_and_by_alias() {
        assert_eq!(
            chord_diagram_svg("Am", "GUITAR").unwrap(),
            chord_diagram_svg("Am", "guitar").unwrap()
        );
        assert_eq!(
            chord_diagram_svg("Am", "uke").unwrap(),
            chord_diagram_svg("Am", "ukulele").unwrap()
        );
    }

    #[test]
    fn asking_for_a_diagram_on_an_unknown_instrument_is_an_error_naming_the_accepted_ones() {
        let error = chord_diagram_svg("Am", "banjo").expect_err("banjo is not exposed");
        assert!(error.contains("banjo"), "got {error:?}");
        assert!(error.contains("guitar"), "got {error:?}");
    }

    #[test]
    fn asking_for_a_diagram_of_something_that_is_not_a_chord_yields_no_diagram() {
        assert!(
            chord_diagram_svg("not a chord", "guitar")
                .expect("guitar is a known instrument")
                .is_none()
        );
    }

    #[test]
    fn the_directive_catalog_carries_title_with_its_short_alias() {
        let all = directives();
        let title = all
            .iter()
            .find(|d| d.name == "title")
            .expect("title is a directive");
        assert!(title.aliases.iter().any(|a| a == "t"), "got {title:?}");
        assert_eq!(title.value_kind, "freeform");
        assert!(!title.summary.is_empty());
    }

    #[test]
    fn an_enum_valued_directive_lists_the_values_it_accepts() {
        let all = directives();
        let enums: Vec<_> = all.iter().filter(|d| d.value_kind == "enum").collect();
        assert!(!enums.is_empty(), "the catalog has enum-valued directives");
        assert!(
            enums.iter().all(|d| !d.values.is_empty()),
            "every enum directive lists its values"
        );
    }

    #[test]
    fn asking_for_pdf_is_rejected_because_the_server_does_not_render_bytes() {
        let error = RenderFormat::parse("pdf").expect_err("pdf is not a server format");
        assert!(error.contains("pdf"), "got {error:?}");
        assert!(error.contains("text"), "the accepted formats are named");
    }

    #[test]
    fn a_source_within_the_parser_limit_is_accepted_and_one_over_it_is_not() {
        let limit = max_source_bytes();
        assert!(check_source_size(&"a".repeat(limit)).is_ok());
        let error = check_source_size(&"a".repeat(limit + 1)).expect_err("over the limit");
        assert!(error.contains(&limit.to_string()), "got {error:?}");
    }
}
