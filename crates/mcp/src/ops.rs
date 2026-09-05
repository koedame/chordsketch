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

use std::fmt;

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

/// Maximum accepted size of a `chord` argument, in bytes.
///
/// A chord name is a handful of characters — the longest the editor can
/// compose is on the order of `F#m7b5(9,11,13)/C#` — and the diagram
/// renderer echoes whatever it is given into the SVG's title, so an
/// unbounded name is a 1:1 amplifier into the caller's context. 128
/// bytes leaves an order of magnitude of headroom over any real chord.
pub const MAX_CHORD_BYTES: usize = 128;

/// Returns `Err` with a caller-facing message when `source` is larger
/// than [`max_source_bytes`].
///
/// # Errors
///
/// Returns the rejection message when the limit is exceeded.
#[must_use = "an oversized source must not be processed"]
pub fn check_source_size(source: &str) -> Result<(), String> {
    check_size("source", source, max_source_bytes())
}

/// Returns `Err` with a caller-facing message when `chord` is larger
/// than [`MAX_CHORD_BYTES`].
///
/// # Errors
///
/// Returns the rejection message when the limit is exceeded.
#[must_use = "an oversized chord name must not be processed"]
pub fn check_chord_size(chord: &str) -> Result<(), String> {
    check_size("chord", chord, MAX_CHORD_BYTES)
}

fn check_size(field: &str, value: &str, limit: usize) -> Result<(), String> {
    if value.len() > limit {
        return Err(format!(
            "{field} is {} bytes, which exceeds the {limit} byte limit",
            value.len()
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
    #[must_use = "an unknown format must not fall back to a default"]
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

/// An output plus the diagnostics raised while producing it.
///
/// Warnings are advisory — the output is complete and usable. They are
/// carried separately (rather than folded into the output) so a caller
/// can show the chart and the diagnostics independently.
#[derive(Debug, Clone)]
pub struct Rendered {
    /// The rendered chart.
    pub output: String,
    /// Parse diagnostics first, then the renderer's semantic warnings.
    pub warnings: Vec<String>,
}

/// A parse error, positioned in the source.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Diagnostic {
    /// 1-based line number, counted from the start of the whole source.
    pub line: usize,
    /// 1-based column number.
    pub column: usize,
    /// What the parser could not make sense of.
    pub message: String,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "parse error at line {} column {}: {}",
            self.line, self.column, self.message
        )
    }
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

/// A parsed source: one syntax tree per song, plus any parse errors.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Parsed {
    /// One tree per song. Input with no `{new_song}` directive yields
    /// exactly one entry.
    pub songs: Vec<serde_json::Value>,
    /// Structural problems the parser recovered from while building the
    /// trees above.
    pub errors: Vec<Diagnostic>,
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
///
/// A source the parser had to recover from still renders — the parser is
/// lenient — but the lines it could not read are missing from the
/// output, so those diagnostics lead [`Rendered::warnings`]. A caller
/// that shows the chart without them shows a silently shortened song.
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
    let mut warnings: Vec<String> = diagnostics(source)
        .iter()
        .map(ToString::to_string)
        .collect();
    warnings.extend(result.warnings);
    Rendered {
        output: result.output,
        warnings,
    }
}

/// Parses ChordPro source into one syntax tree per song.
///
/// The trees are the parser's own AST, serialised by
/// [`chordsketch_chordpro::json`]. They are not transposed and their
/// `{key}` directives are not canonicalised — this is what the file
/// says, not what a preview would show.
///
/// # Errors
///
/// Returns a message when a serialised tree is not valid JSON, which
/// would mean a defect in the serialiser rather than anything the caller
/// did.
pub fn parse_ast(source: &str) -> Result<Parsed, String> {
    let mut songs = Vec::new();
    for song in parse_songs(source) {
        let json = song.to_json_string();
        let value = serde_json::from_str(&json)
            .map_err(|e| format!("the parser produced a tree that is not valid JSON: {e}"))?;
        songs.push(value);
    }
    Ok(Parsed {
        songs,
        errors: diagnostics(source),
    })
}

/// Checks ChordPro source for structural errors and semantic warnings.
///
/// Both layers are reported together because they answer one question —
/// "is anything wrong with this file?" — with different severities: an
/// entry in `errors` means the parser had to recover, an entry in
/// `warnings` means the file renders but something in it is suspect.
#[must_use]
pub fn validate(source: &str) -> Validation {
    // The renderer is what raises semantic warnings, so validation runs
    // one: the text renderer, because it is the cheapest of the three
    // and every warning is raised before any format-specific work.
    let rendered = chordsketch_render_text::render_songs_with_warnings(
        &parse_songs(source),
        0,
        &Config::defaults(),
    );
    Validation {
        errors: diagnostics(source),
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
#[must_use = "the caller must distinguish an unknown instrument from an undrawable chord"]
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

/// Parse diagnostics for the whole source, positioned against the
/// **file**.
///
/// Deliberately not taken from [`parse_songs`]: the multi-song parser
/// splits at `{new_song}` and lexes each segment from line 1, so its
/// error positions are relative to the segment. A caller holding the
/// file cannot resolve those without knowing where the segments began.
/// The single-pass lenient parser sees the same structural problems
/// (splitting neither creates nor removes them) and positions them
/// against the file, which is what a caller can act on.
fn diagnostics(source: &str) -> Vec<Diagnostic> {
    chordsketch_chordpro::parse_lenient(source)
        .errors
        .iter()
        .map(|e| Diagnostic {
            line: e.line(),
            column: e.column(),
            message: e.message.clone(),
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

    /// Two songs, both well-formed.
    const MULTI_SONG: &str =
        "{title: Alpha}\nAlpha [G]lyric\n{new_song}\n{title: Beta}\nBeta [C]lyric\n";

    /// Two songs where the unclosed directive is on **line 5 of the
    /// file**, but line 2 of the second song's segment.
    const MULTI_SONG_WITH_ERROR: &str =
        "{title: A}\n[G]ok\n{new_song}\n{title: B}\n{bad\n[G]Hello\n";

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
    fn rendering_a_song_the_parser_had_to_recover_from_reports_where_it_gave_up() {
        // The lenient parser drops what it cannot read, so the chart comes
        // back shorter than the song. Without a diagnostic the caller has
        // no way to know a line went missing.
        let source = "{title: Test}\n{bad\n[G]Hello\n";
        let rendered = render(source, RenderFormat::Text, 0);
        assert!(
            rendered.output.contains("Hello"),
            "the rest of the song still renders, got {:?}",
            rendered.output
        );
        assert!(
            !rendered.output.contains("bad"),
            "the unreadable line is not in the chart, got {:?}",
            rendered.output
        );
        assert!(
            rendered
                .warnings
                .iter()
                .any(|w| w.contains("line 2") && w.contains("parse error")),
            "the missing line is reported with its position, got {:?}",
            rendered.warnings
        );
    }

    #[test]
    fn parse_errors_come_before_renderer_warnings() {
        // Both layers land in one list; the structural problem is the one
        // that changed the output, so it reads first.
        let rendered = render("{bad\n{transpose: up2}\n[C]Hello\n", RenderFormat::Text, 0);
        assert!(rendered.warnings.len() >= 2, "got {:?}", rendered.warnings);
        assert!(
            rendered.warnings[0].contains("parse error"),
            "got {:?}",
            rendered.warnings
        );
        assert!(
            rendered.warnings.iter().any(|w| w.contains("up2")),
            "the renderer's warning survives too, got {:?}",
            rendered.warnings
        );
    }

    #[test]
    fn parsing_a_song_returns_one_tree_carrying_its_metadata() {
        let parsed = parse_ast(SONG).expect("the tree serialises");
        assert_eq!(parsed.songs.len(), 1, "one song in, one tree out");
        assert_eq!(
            parsed.songs[0]["metadata"]["title"], "Scarborough Fair",
            "the title is on the tree, got {:?}",
            parsed.songs[0]
        );
        assert!(parsed.errors.is_empty(), "a clean song reports nothing");
    }

    #[test]
    fn parsing_a_song_with_an_unclosed_directive_still_returns_a_tree_and_reports_the_error() {
        let parsed = parse_ast("{title: Test}\n{bad\n[G]Hello\n").expect("the tree serialises");
        assert_eq!(parsed.errors.len(), 1, "the unclosed directive is reported");
        assert_eq!(parsed.errors[0].line, 2);
        assert_eq!(parsed.songs[0]["metadata"]["title"], "Test");
    }

    #[test]
    fn parsing_a_multi_song_file_returns_one_tree_per_song_in_order() {
        // The renderer splits at `{new_song}`; the parse tool must agree
        // with it, or "the title of the first song" answers with the last
        // song's title.
        let parsed = parse_ast(MULTI_SONG).expect("the trees serialise");
        assert_eq!(parsed.songs.len(), 2, "got {:?}", parsed.songs);
        assert_eq!(parsed.songs[0]["metadata"]["title"], "Alpha");
        assert_eq!(parsed.songs[1]["metadata"]["title"], "Beta");
    }

    #[test]
    fn parse_errors_in_a_later_song_are_positioned_against_the_whole_file() {
        // The multi-song parser lexes each segment from line 1, so a
        // diagnostic taken from it would say line 2 for a problem the
        // caller sees on line 5 of the file they hold.
        let parsed = parse_ast(MULTI_SONG_WITH_ERROR).expect("the trees serialise");
        assert_eq!(
            parsed.errors[0].line, 5,
            "the position is the one in the file, got {:?}",
            parsed.errors
        );
    }

    #[test]
    fn validation_errors_in_a_later_song_are_positioned_against_the_whole_file() {
        let result = validate(MULTI_SONG_WITH_ERROR);
        assert_eq!(
            result.errors[0].line, 5,
            "the position is the one in the file, got {:?}",
            result.errors
        );
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
        let uppercase = chord_diagram_svg("Am", "GUITAR").unwrap();
        assert!(
            uppercase.as_deref().is_some_and(|s| s.starts_with("<svg")),
            "an uppercase instrument name still draws a diagram"
        );
        assert_eq!(uppercase, chord_diagram_svg("Am", "guitar").unwrap());

        let alias = chord_diagram_svg("Am", "uke").unwrap();
        assert!(
            alias.as_deref().is_some_and(|s| s.starts_with("<svg")),
            "the alias still draws a diagram"
        );
        assert_eq!(alias, chord_diagram_svg("Am", "ukulele").unwrap());
    }

    #[test]
    fn a_chord_name_within_the_limit_is_accepted_and_one_over_it_is_not() {
        assert!(check_chord_size(&"A".repeat(MAX_CHORD_BYTES)).is_ok());
        let error = check_chord_size(&"A".repeat(MAX_CHORD_BYTES + 1)).expect_err("over the limit");
        assert!(error.contains("chord"), "got {error:?}");
        assert!(
            error.contains(&MAX_CHORD_BYTES.to_string()),
            "the limit is named, got {error:?}"
        );
    }

    #[test]
    fn every_chord_the_diagram_renderer_draws_stays_well_inside_the_name_limit() {
        // The limit is only defensible if no real chord approaches it.
        for chord in [
            "Am",
            "G7(9,11,13)",
            "F#m7b5/C#",
            "Cadd9",
            "Bbmaj7#11/D",
            "C#dim7",
        ] {
            assert!(
                chord.len() < MAX_CHORD_BYTES,
                "{chord} is {} bytes, close to the {MAX_CHORD_BYTES} byte limit",
                chord.len()
            );
            assert!(check_chord_size(chord).is_ok());
        }
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
