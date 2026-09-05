//! The MCP protocol adapter: tool declarations, argument shapes, and the
//! mapping from [`crate::ops`] results onto tool responses.
//!
//! Every tool here is a thin wrapper. It checks the source size, calls one
//! function in [`crate::ops`], and wraps what comes back. Logic that is
//! not about the protocol belongs in `ops`, where it can be tested without
//! a peer.
//!
//! Two failure modes are distinguished, per the MCP specification:
//!
//! - A bad **argument** (an unknown format name, an oversized source) is a
//!   protocol error — `Err(ErrorData::invalid_params(..))`. The caller sent
//!   something the server cannot act on.
//! - A bad **song** (a chord with no voicing, an instrument the caller
//!   asked for) is a tool error — `Ok(CallToolResult::error(..))`, so the
//!   explanation reaches the model rather than being rendered opaquely.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ErrorData};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::ops;

/// Arguments for the tools that take nothing but ChordPro source.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SourceParams {
    /// ChordPro source text (the contents of a `.cho` / `.chopro` /
    /// `.chordpro` file), not a path to one.
    pub source: String,
}

/// Arguments for `render_chordpro`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct RenderParams {
    /// ChordPro source text, not a path to a file.
    pub source: String,
    /// Output format: `text` for chords above lyrics, `html` for a
    /// self-contained document. Defaults to `text`.
    #[serde(default)]
    pub format: Option<String>,
    /// Semitones to shift every chord by; negative transposes down.
    /// Defaults to 0. Composes with a `{transpose}` directive in the
    /// source.
    #[serde(default)]
    pub transpose: Option<i8>,
}

/// Arguments for `chord_diagram_svg`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ChordDiagramParams {
    /// Chord name, as it would appear between brackets in ChordPro
    /// (`Am`, `G7(13)`, `F#m7b5`).
    pub chord: String,
    /// One of `guitar`, `ukulele`, or `piano`. Defaults to `guitar`.
    #[serde(default)]
    pub instrument: Option<String>,
}

/// The ChordSketch MCP server.
///
/// Stateless: every tool call is answered from its arguments alone, so
/// one instance serves any number of calls and nothing carries over
/// between them.
#[derive(Debug, Clone, Default)]
pub struct ChordSketchServer;

impl ChordSketchServer {
    /// Creates a server instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

/// Text describing what the tool ran into, for the model to read.
fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

/// A successful text payload.
fn text(body: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(body)])
}

/// Serialises `value` as the JSON body of a successful tool result.
fn json(value: &impl serde::Serialize) -> Result<CallToolResult, ErrorData> {
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| ErrorData::internal_error(format!("could not serialise result: {e}"), None))?;
    Ok(text(body))
}

/// Rejects a source argument the server will not act on.
fn check_source(source: &str) -> Result<(), ErrorData> {
    ops::check_source_size(source).map_err(|message| ErrorData::invalid_params(message, None))
}

/// Appends the renderer's warnings to `output` as a trailing block.
///
/// Warnings ride in the same text payload rather than a second content
/// block so a caller that reads only the first block still sees them —
/// they are advisory, but silently dropping them would make a
/// half-broken chart look clean.
fn with_warnings(output: String, warnings: &[String]) -> String {
    if warnings.is_empty() {
        return output;
    }
    let mut body = output;
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str("\nWarnings:\n");
    for warning in warnings {
        body.push_str("- ");
        body.push_str(warning);
        body.push('\n');
    }
    body
}

#[tool_router]
impl ChordSketchServer {
    /// Render a ChordPro song to readable text or to HTML, optionally
    /// transposed. Use this to show a chord chart, or to produce a web
    /// page from one. Returns the rendered chart, followed by any
    /// warnings the renderer raised. PDF output is not available here —
    /// run `chordsketch -f pdf song.cho -o song.pdf` for that.
    #[tool(name = "render_chordpro")]
    fn render_chordpro(
        &self,
        Parameters(params): Parameters<RenderParams>,
    ) -> Result<CallToolResult, ErrorData> {
        check_source(&params.source)?;
        let format = match params.format.as_deref() {
            None => ops::RenderFormat::Text,
            Some(name) => ops::RenderFormat::parse(name)
                .map_err(|message| ErrorData::invalid_params(message, None))?,
        };
        let rendered = ops::render(&params.source, format, params.transpose.unwrap_or(0));
        Ok(text(with_warnings(rendered.output, &rendered.warnings)))
    }

    /// Parse a ChordPro song and return its syntax tree as JSON — every
    /// directive, every chord with its position, every section
    /// boundary. Use this when the structure itself is the answer, not
    /// the rendered chart. The tree reflects the source as written: it
    /// is not transposed and directive values are not normalised.
    #[tool(name = "parse_chordpro")]
    fn parse_chordpro(
        &self,
        Parameters(params): Parameters<SourceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        check_source(&params.source)?;
        let parsed = ops::parse_ast(&params.source);
        Ok(text(with_warnings(parsed.output, &parsed.warnings)))
    }

    /// Check a ChordPro song for problems. Returns JSON with `errors`
    /// (structural problems, each with a line and column) and
    /// `warnings` (the file renders, but something in it is suspect —
    /// an unparseable `{transpose}`, an out-of-range `{capo}`, an
    /// ambiguous chord spelling like `G13`). Both lists empty means the
    /// file is clean.
    #[tool(name = "validate_chordpro")]
    fn validate_chordpro(
        &self,
        Parameters(params): Parameters<SourceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        check_source(&params.source)?;
        json(&ops::validate(&params.source))
    }

    /// Tidy ChordPro source: expand short directive names to their long
    /// form, capitalise chord roots, and put exactly one blank line
    /// between sections. Returns the reformatted source, which is
    /// always valid ChordPro.
    #[tool(name = "format_chordpro")]
    fn format_chordpro(
        &self,
        Parameters(params): Parameters<SourceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        check_source(&params.source)?;
        Ok(text(ops::format_source(&params.source)))
    }

    /// Draw a chord diagram as an SVG fragment, for embedding in a page
    /// or a document. Fretted instruments (`guitar`, `ukulele`) get a
    /// fingering grid; `piano` gets a keyboard with the chord tones
    /// highlighted.
    #[tool(name = "chord_diagram_svg")]
    fn chord_diagram_svg(
        &self,
        Parameters(params): Parameters<ChordDiagramParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let instrument = params.instrument.as_deref().unwrap_or("guitar");
        match ops::chord_diagram_svg(&params.chord, instrument) {
            Err(message) => Err(ErrorData::invalid_params(message, None)),
            Ok(None) => Ok(tool_error(format!(
                "no {instrument} diagram is available for chord {:?}",
                params.chord
            ))),
            Ok(Some(svg)) => Ok(text(svg)),
        }
    }

    /// List every ChordPro directive this implementation knows, with
    /// its short aliases, whether it takes a value, and the allowed
    /// values when the set is fixed. Use this before writing a
    /// directive into a song, to check it exists and what it accepts.
    #[tool(name = "list_directives")]
    fn list_directives(&self) -> Result<CallToolResult, ErrorData> {
        json(&ops::directives())
    }
}

#[tool_handler(
    name = "chordsketch",
    instructions = "ChordSketch works with ChordPro chord charts: lyrics with chords in \
square brackets and metadata in braces, e.g. `{title: Scarborough Fair}` and \
`Are you [Em]going to [G]Scarborough [Em]Fair`. Every tool takes the song's \
source text as a string — read the file yourself and pass its contents; the \
server has no access to the filesystem. To show a chart or change its key use \
`render_chordpro`; to inspect its structure use `parse_chordpro`; to check a \
file you wrote use `validate_chordpro`; to tidy one use `format_chordpro`. \
PDF export and iReal Pro charts are not exposed here — use the `chordsketch` \
command-line tool for those."
)]
impl ServerHandler for ChordSketchServer {}
