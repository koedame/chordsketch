//! UniFFI bindings for ChordSketch.
//!
//! Exposes ChordPro parsing and rendering (text, HTML, PDF) to Python,
//! Swift, Kotlin, and Ruby via [UniFFI](https://mozilla.github.io/uniffi-rs/).

use chordsketch_chordpro::render_result::RenderResult;

uniffi::include_scaffolding!("chordsketch");

/// Errors returned by the FFI layer.
#[derive(Debug, thiserror::Error)]
pub enum ChordSketchError {
    /// No songs found in the input.
    #[error("no songs found in input")]
    NoSongsFound,
    /// Invalid configuration string.
    #[error("invalid config: {reason}")]
    InvalidConfig {
        /// Human-readable description of why the config is invalid.
        reason: String,
    },
    /// A ChordPro ↔ iReal Pro conversion failed (#2067).
    #[error("conversion failed: {reason}")]
    ConversionFailed {
        /// Parser or converter diagnostic.
        reason: String,
    },
}

/// Resolve a [`chordsketch_chordpro::config::Config`] from an optional JSON/preset string.
fn resolve_config(
    config_json: Option<String>,
) -> Result<chordsketch_chordpro::config::Config, ChordSketchError> {
    match config_json {
        Some(name) => {
            if let Some(preset) = chordsketch_chordpro::config::Config::preset(&name) {
                Ok(preset)
            } else {
                chordsketch_chordpro::config::Config::parse(&name).map_err(|e| {
                    ChordSketchError::InvalidConfig {
                        reason: format!("not a known preset and not valid RRJSON: {e}"),
                    }
                })
            }
        }
        None => Ok(chordsketch_chordpro::config::Config::defaults()),
    }
}

/// Parse input into songs.
///
/// `parse_multi_lenient` always returns at least one `ParseResult`
/// (`split_at_new_song` unconditionally pushes the trailing segment, even
/// for empty input — see `chordsketch_chordpro::parser`), so the resulting
/// `Vec<Song>` is never empty. The previous `is_empty()` guard was dead
/// code. See #1083.
///
/// The function still returns `Result` (and the [`ChordSketchError::NoSongsFound`]
/// variant is still part of the FFI surface) for binding ABI stability —
/// removing the variant would be a breaking change for Python / Swift /
/// Kotlin / Ruby consumers. The variant is retained as defensive
/// future-proofing in case the lenient parser ever changes its
/// always-returns-one-segment behavior.
fn parse_songs(input: &str) -> Result<Vec<chordsketch_chordpro::ast::Song>, ChordSketchError> {
    let result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = result.results.into_iter().map(|r| r.song).collect();
    Ok(songs)
}

/// Forward each warning in a [`RenderResult`] to `eprintln!` and unwrap the output.
///
/// UniFFI-based consumers (Python, Swift, Kotlin, Ruby) receive output via their
/// language binding. Render warnings — such as transpose saturation or chorus
/// recall limits — are forwarded to the platform's standard error stream
/// (`sys.stderr` in Python, `NSLog`/`stderr` in Swift, `System.err` in Kotlin,
/// `$stderr` in Ruby). This matches the NAPI binding's pattern. See #1541.
fn flush_warnings<T>(result: RenderResult<T>) -> T {
    for w in &result.warnings {
        eprintln!("chordsketch: {w}");
    }
    result.output
}

/// Parse ChordPro input and render as plain text.
///
/// Parse warnings are silently discarded — the lenient parser produces a
/// best-effort result even when the input contains errors. To retrieve
/// diagnostics, call [`validate()`] before or after rendering.
///
/// Render warnings (e.g. transpose saturation, chorus recall limits) are
/// forwarded to stderr via `flush_warnings`.
///
/// # Parameters
///
/// * `transpose` — semitone transposition offset applied on top of any
///   in-file `{transpose}` directives. Accepts the full `i8` range
///   (`-128..=127`); musically meaningful values are typically `-24..=24`
///   (two octaves). If the combined offset (API value + in-file directive)
///   saturates the `i8` range, it is clamped and a warning is emitted.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_text(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<String, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    Ok(flush_warnings(
        chordsketch_render_text::render_songs_with_warnings(
            &songs,
            transpose.unwrap_or(0),
            &config,
        ),
    ))
}

/// Parse ChordPro input and render as an HTML document.
///
/// Parse warnings are silently discarded — the lenient parser produces a
/// best-effort result even when the input contains errors. To retrieve
/// diagnostics, call [`validate()`] before or after rendering.
///
/// Render warnings (e.g. transpose saturation, chorus recall limits) are
/// forwarded to stderr via `flush_warnings`.
///
/// See [`parse_and_render_text`] for `transpose` parameter documentation.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_html(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<String, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    Ok(flush_warnings(
        chordsketch_render_html::render_songs_with_warnings(
            &songs,
            transpose.unwrap_or(0),
            &config,
        ),
    ))
}

/// Parse ChordPro input and render as a PDF document.
///
/// Parse warnings are silently discarded — the lenient parser produces a
/// best-effort result even when the input contains errors. To retrieve
/// diagnostics, call [`validate()`] before or after rendering.
///
/// Render warnings (e.g. transpose saturation, chorus recall limits) are
/// forwarded to stderr via `flush_warnings`.
///
/// See [`parse_and_render_text`] for `transpose` parameter documentation.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_pdf(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<Vec<u8>, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    Ok(flush_warnings(
        chordsketch_render_pdf::render_songs_with_warnings(&songs, transpose.unwrap_or(0), &config),
    ))
}

/// Structured render result for text / HTML output.
///
/// Returned by [`parse_and_render_text_with_warnings`] and
/// [`parse_and_render_html_with_warnings`]. See #1827 for the
/// cross-binding rationale; the plain `parse_and_render_*` variants
/// forward warnings to stderr via `eprintln!`, which UniFFI-based
/// consumers (Python, Swift, Kotlin, Ruby) cannot capture structurally.
#[derive(Debug)]
pub struct TextRenderWithWarnings {
    /// Rendered text / HTML output.
    pub output: String,
    /// Warnings captured during the render pass.
    pub warnings: Vec<String>,
}

/// Structured render result for PDF output.
///
/// See [`TextRenderWithWarnings`] for the warnings contract.
#[derive(Debug)]
pub struct PdfRenderWithWarnings {
    /// Rendered PDF byte stream.
    pub output: Vec<u8>,
    /// Warnings captured during the render pass.
    pub warnings: Vec<String>,
}

/// Parse ChordPro input, render as plain text, and return warnings
/// alongside the output instead of forwarding them to stderr.
///
/// See [`parse_and_render_text`] for the parameter contract and
/// [`TextRenderWithWarnings`] for the warnings contract.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_text_with_warnings(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<TextRenderWithWarnings, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    let result = chordsketch_render_text::render_songs_with_warnings(
        &songs,
        transpose.unwrap_or(0),
        &config,
    );
    Ok(TextRenderWithWarnings {
        output: result.output,
        warnings: result.warnings,
    })
}

/// Parse ChordPro input, render as an HTML document, and return warnings
/// alongside the output.
///
/// See [`parse_and_render_text_with_warnings`] for the warnings contract.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_html_with_warnings(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<TextRenderWithWarnings, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    let result = chordsketch_render_html::render_songs_with_warnings(
        &songs,
        transpose.unwrap_or(0),
        &config,
    );
    Ok(TextRenderWithWarnings {
        output: result.output,
        warnings: result.warnings,
    })
}

/// Parse ChordPro input, render as a PDF document, and return warnings
/// alongside the byte stream.
///
/// See [`parse_and_render_text_with_warnings`] for the warnings contract.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_pdf_with_warnings(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<PdfRenderWithWarnings, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    let result =
        chordsketch_render_pdf::render_songs_with_warnings(&songs, transpose.unwrap_or(0), &config);
    Ok(PdfRenderWithWarnings {
        output: result.output,
        warnings: result.warnings,
    })
}

/// Parse ChordPro input and render as a body-only HTML fragment.
///
/// Unlike [`parse_and_render_html`], the returned string is just the
/// `<div class="song">...</div>` markup — no `<!DOCTYPE>`, `<html>`,
/// `<head>`, `<title>`, or embedded `<style>` block. Use this from
/// hosts that supply their own document envelope so the rendered
/// chord-over-lyrics layout does not depend on HTML5's nested-document
/// recovery rules — see #2279.
///
/// Pair with [`render_html_css`] to obtain the matching stylesheet.
///
/// Render warnings are forwarded to stderr via `flush_warnings`. Use
/// [`parse_and_render_html_body_with_warnings`] to capture them
/// programmatically.
///
/// See [`parse_and_render_text`] for `transpose` parameter documentation.
///
/// # Errors
///
/// Returns [`ChordSketchError::InvalidConfig`] when `config_json` cannot
/// be parsed.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_html_body(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<String, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    Ok(flush_warnings(
        chordsketch_render_html::render_songs_body_with_warnings(
            &songs,
            transpose.unwrap_or(0),
            &config,
        ),
    ))
}

/// Parse ChordPro input, render as a body-only HTML fragment, and return
/// warnings alongside the output.
///
/// See [`parse_and_render_html_body`] for the body-only contract and
/// [`parse_and_render_text_with_warnings`] for the warnings contract.
///
/// # Errors
///
/// Returns [`ChordSketchError::InvalidConfig`] when `config_json` cannot
/// be parsed.
#[must_use = "callers must handle parse and render errors"]
pub fn parse_and_render_html_body_with_warnings(
    input: String,
    config_json: Option<String>,
    transpose: Option<i8>,
) -> Result<TextRenderWithWarnings, ChordSketchError> {
    let config = resolve_config(config_json)?;
    let songs = parse_songs(&input)?;
    let result = chordsketch_render_html::render_songs_body_with_warnings(
        &songs,
        transpose.unwrap_or(0),
        &config,
    );
    Ok(TextRenderWithWarnings {
        output: result.output,
        warnings: result.warnings,
    })
}

/// Returns the canonical chord-over-lyrics CSS that
/// [`parse_and_render_html`] embeds inside `<style>`.
///
/// Pair with [`parse_and_render_html_body`] when the consumer is
/// supplying its own document envelope.
#[must_use]
pub fn render_html_css() -> String {
    chordsketch_render_html::render_html_css()
}

/// Variant of [`render_html_css`] that honours `settings.wraplines` from
/// the supplied config (R6.100.0). When `wraplines` is false, the `.line`
/// rule emits `flex-wrap: nowrap` so chord/lyric runs preserve the source
/// line structure instead of reflowing onto subsequent rows.
///
/// # Errors
///
/// Returns [`ChordSketchError::InvalidConfig`] when `config_json` cannot
/// be parsed.
#[must_use = "callers must handle render errors"]
pub fn render_html_css_with_config_json(
    config_json: Option<String>,
) -> Result<String, ChordSketchError> {
    let config = resolve_config(config_json)?;
    Ok(chordsketch_render_html::render_html_css_with_config(
        &config,
    ))
}

/// A single validation issue reported by [`validate`].
///
/// Mirrors the NAPI binding's `ValidationError` (#1990) and the UDL
/// dictionary of the same name in `chordsketch.udl`. Line and column are
/// one-based; `u32` matches the `u32` declaration in the UDL, which is
/// what every target language (Python / Kotlin / Swift / Ruby) sees.
#[derive(Debug)]
pub struct ValidationError {
    /// One-based line number where the issue was detected.
    pub line: u32,
    /// One-based column number where the issue was detected.
    pub column: u32,
    /// Human-readable description of the issue.
    pub message: String,
}

/// Validate ChordPro input and return any parse errors as structured
/// records. Returns an empty list if the input is valid.
#[must_use]
pub fn validate(input: String) -> Vec<ValidationError> {
    let result = chordsketch_chordpro::parse_multi_lenient(&input);
    result
        .results
        .into_iter()
        .flat_map(|r| r.errors.into_iter())
        .map(|e| ValidationError {
            // `line()` / `column()` are `usize`; clamp overflow at
            // `u32::MAX` so we never panic on conversion. A source long
            // enough to exceed `u32::MAX` lines is orders of magnitude
            // beyond any realistic song file.
            line: u32::try_from(e.line()).unwrap_or(u32::MAX),
            column: u32::try_from(e.column()).unwrap_or(u32::MAX),
            message: e.message,
        })
        .collect()
}

/// Return the ChordSketch library version.
#[must_use]
pub fn version() -> String {
    chordsketch_chordpro::version().to_string()
}

/// Look up an SVG chord diagram for the given chord name and
/// instrument. Mirrors the WASM `chord_diagram_svg` export
/// added in #2164 and the NAPI `chordDiagramSvg` export added
/// in #2167.
///
/// `instrument` accepts (case-insensitive): `"guitar"`,
/// `"ukulele"` (alias `"uke"`), or `"piano"` (aliases
/// `"keyboard"`, `"keys"`). `chord` is a standard ChordPro
/// chord name. Flat spellings are normalised to sharps via the
/// same path the core voicing-database lookup uses.
///
/// Returns `Ok(Some(svg))` for known `(chord, instrument)`
/// pairs, `Ok(None)` when the database has no entry, and
/// `Err(ChordSketchError::InvalidConfig)` when the instrument
/// is not supported.
///
/// # Errors
///
/// Returns [`ChordSketchError::InvalidConfig`] when
/// `instrument` is not one of the supported values.
#[must_use = "callers must handle the unknown-instrument error"]
pub fn chord_diagram_svg(
    chord: String,
    instrument: String,
) -> Result<Option<String>, ChordSketchError> {
    chord_diagram_svg_with_defines(chord, instrument, Vec::new())
}

/// Like [`chord_diagram_svg`], but consults song-level
/// `{define}` voicings before falling back to the built-in
/// voicing database. `defines` is a list of `(chord_name, raw)`
/// tuples — `raw` is the directive body (e.g.
/// `"base-fret 1 frets 3 3 0 0 1 3"`). Mirrors
/// `chordsketch_chordpro::voicings::lookup_diagram`'s
/// "song-level defines take priority" rule so user-defined
/// chords show up here exactly like the Rust HTML renderer's
/// `<section class="chord-diagrams">` block. Sister-site to
/// the wasm `chordDiagramSvgWithDefines` and NAPI
/// `chordDiagramSvgWithDefines` exports
/// (`.claude/rules/fix-propagation.md` §Bindings).
///
/// `defines` is bounded at parse time by the parser's
/// `MAX_METADATA_ENTRIES = 1000` cap; callers constructing
/// the list directly SHOULD stay under the same bound.
///
/// # Errors
///
/// Returns [`ChordSketchError::InvalidConfig`] when
/// `instrument` is not one of the supported values.
#[must_use = "callers must handle the unknown-instrument error"]
pub fn chord_diagram_svg_with_defines(
    chord: String,
    instrument: String,
    defines: Vec<ChordDefine>,
) -> Result<Option<String>, ChordSketchError> {
    use chordsketch_chordpro::chord_diagram::{render_keyboard_svg, render_svg};
    use chordsketch_chordpro::voicings::{lookup_diagram, lookup_keyboard_voicing};

    let defines_pairs: Vec<(String, String)> =
        defines.into_iter().map(|d| (d.name, d.raw)).collect();

    match instrument.to_ascii_lowercase().as_str() {
        "piano" | "keyboard" | "keys" => {
            // Keyboard voicings have their own `{define: … keys …}`
            // shape that the wasm surface doesn't yet thread through
            // either — match that gap here so the FFI behaviour
            // is at least consistent across bindings while keyboard
            // voicings remain a TODO.
            Ok(lookup_keyboard_voicing(&chord, &[]).map(|v| render_keyboard_svg(&v)))
        }
        "guitar" | "ukulele" | "uke" => {
            // `frets_shown = 5` matches the default ChordPro HTML
            // renderer (`crates/render-html` emits 5-fret diagrams
            // when no `{chordfrets}` directive is set), keeping
            // diagrams produced via UniFFI bindings (Python /
            // Swift / Kotlin / Ruby) visually consistent with
            // sheets rendered through the same binding.
            Ok(lookup_diagram(&chord, &defines_pairs, &instrument, 5).map(|d| render_svg(&d)))
        }
        other => Err(ChordSketchError::InvalidConfig {
            reason: format!(
                "unknown instrument {other:?}; expected one of \"guitar\", \"ukulele\", \"piano\""
            ),
        }),
    }
}

/// A single `{define: <name> <raw>}` voicing entry — the
/// `(chord_name, raw)` tuple [`chord_diagram_svg_with_defines`]
/// consults before falling back to the built-in voicing
/// database. `raw` is the directive body (e.g.
/// `"base-fret 1 frets 3 3 0 0 1 3"`), matching the same shape
/// `chordsketch_chordpro::voicings::lookup_diagram` accepts.
///
/// Exposed as a UniFFI record so callers in Python / Swift /
/// Kotlin / Ruby can build the list as a native struct array.
/// (Declared in `chordsketch.udl`. The Rust struct definition
/// matches the UDL `dictionary ChordDefine { string name; string
/// raw; };` declaration — UniFFI's UDL-driven scaffolding
/// expects the field names and types to line up exactly.)
#[derive(Clone, Debug)]
pub struct ChordDefine {
    /// Chord name (e.g. `"Gsus4"`, `"C#m7"`).
    pub name: String,
    /// Raw directive body — what comes after `{define: <name> `.
    pub raw: String,
}

/// Structured result for ChordPro ↔ iReal Pro conversions
/// (#2067 Phase 1).
///
/// Mirrors the WASM and NAPI `ConversionWithWarnings` shape so
/// every binding presents the same surface — `output` plus a
/// `warnings` list of human-readable diagnostics. Warning
/// strings are rendered via [`chordsketch_convert::ConversionWarning`]'s
/// `Display` impl so callers see one stable text format
/// regardless of which language they consume the binding from.
#[derive(Debug)]
pub struct ConversionWithWarnings {
    /// Converted output string.
    pub output: String,
    /// Warnings captured during conversion.
    pub warnings: Vec<String>,
}

/// Format a [`chordsketch_convert::ConversionWarning`] as a stable
/// `"<kind>: <message>"` string for FFI consumers.
fn format_conversion_warning(w: &chordsketch_convert::ConversionWarning) -> String {
    let kind = match w.kind {
        chordsketch_convert::WarningKind::LossyDrop => "lossy-drop",
        chordsketch_convert::WarningKind::Approximated => "approximated",
        chordsketch_convert::WarningKind::Unsupported => "unsupported",
        // `WarningKind` is `#[non_exhaustive]`; this catch-all keeps
        // the binding compiling if a future variant is added without
        // a matching arm here, falling back to the variant's `Debug`
        // form. Sister-binding fallback in WASM/NAPI does the same.
        _ => "warning",
    };
    format!("{kind}: {}", w.message)
}

/// Convert a ChordPro source string into an `irealb://` URL
/// (#2067 Phase 1).
///
/// Pipeline: `parse_multi_lenient` → first parsed song →
/// [`chordsketch_convert::chordpro_to_ireal`] →
/// [`chordsketch_ireal::irealb_serialize`].
///
/// Conversion is lossy: lyrics, fonts / colours, and capo are
/// dropped (iReal has no surface for them). Each drop appears in
/// the returned `warnings` list.
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the
/// converter rejects the source as unrepresentable in iReal.
#[must_use = "callers must handle conversion errors"]
pub fn convert_chordpro_to_irealb(
    input: String,
) -> Result<ConversionWithWarnings, ChordSketchError> {
    let parse_result = chordsketch_chordpro::parse_multi_lenient(&input);
    // `split_at_new_song` unconditionally pushes `&input[seg_start..]`
    // last, so `parse_multi_lenient` always returns at least one result;
    // `next()` is provably `Some` — use `expect` to make the invariant
    // explicit and catch any future regression immediately.
    let song = parse_result
        .results
        .into_iter()
        .next()
        .map(|r| r.song)
        .expect("parse_multi_lenient always returns at least one result");
    let converted = chordsketch_convert::chordpro_to_ireal(&song).map_err(|e| {
        ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        }
    })?;
    let url = chordsketch_ireal::irealb_serialize(&converted.output);
    Ok(ConversionWithWarnings {
        output: url,
        warnings: converted
            .warnings
            .iter()
            .map(format_conversion_warning)
            .collect(),
    })
}

/// Convert an `irealb://` URL into rendered ChordPro text
/// (#2067 Phase 1).
///
/// Pipeline: [`chordsketch_ireal::parse`] →
/// [`chordsketch_convert::ireal_to_chordpro`] →
/// [`chordsketch_render_text::render_song`].
///
/// The output is the rendered text representation of the
/// converted song, not raw ChordPro source — there is no
/// ChordPro source emitter in the workspace yet (deferred to a
/// follow-up PR). Bar boundaries (`|`) survive the conversion
/// (asserted in the per-binding tests); other surface details
/// follow `chordsketch-render-text`'s own formatting contract.
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the URL
/// is not a valid `irealb://` payload.
#[must_use = "callers must handle conversion errors"]
pub fn convert_irealb_to_chordpro_text(
    input: String,
) -> Result<ConversionWithWarnings, ChordSketchError> {
    let ireal =
        chordsketch_ireal::parse(&input).map_err(|e| ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        })?;
    let converted = chordsketch_convert::ireal_to_chordpro(&ireal).map_err(|e| {
        ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        }
    })?;
    let text = chordsketch_render_text::render_song(&converted.output);
    Ok(ConversionWithWarnings {
        output: text,
        warnings: converted
            .warnings
            .iter()
            .map(format_conversion_warning)
            .collect(),
    })
}

/// Render an `irealb://` URL as an iReal Pro-style SVG chart
/// (#2067 Phase 2a).
///
/// Pipeline: [`chordsketch_ireal::parse`] →
/// [`chordsketch_render_ireal::render_svg`] with the default
/// [`chordsketch_render_ireal::RenderOptions`].
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the URL
/// is not a valid `irealb://` payload. Successful renders never
/// fail — the SVG renderer is total once it has a parsed
/// [`chordsketch_ireal::IrealSong`].
#[must_use = "callers must handle conversion errors"]
pub fn render_ireal_svg(input: String) -> Result<String, ChordSketchError> {
    let ireal =
        chordsketch_ireal::parse(&input).map_err(|e| ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        })?;
    Ok(chordsketch_render_ireal::render_svg(
        &ireal,
        &chordsketch_render_ireal::RenderOptions::default(),
    ))
}

/// Parse an `irealb://` URL into an AST-shaped JSON string
/// (#2067 Phase 2b).
///
/// The returned JSON object mirrors the
/// [`chordsketch_ireal::IrealSong`] AST. Pair with
/// [`serialize_irealb`] for the inverse direction. Field
/// additions are non-breaking; field removals or renames require
/// a major version bump.
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the URL is
/// not a valid `irealb://` payload.
#[must_use = "callers must handle parse errors"]
pub fn parse_irealb(input: String) -> Result<String, ChordSketchError> {
    use chordsketch_ireal::ToJson;
    let song =
        chordsketch_ireal::parse(&input).map_err(|e| ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        })?;
    Ok(song.to_json_string())
}

/// Serialize an AST-shaped JSON string into an `irealb://` URL
/// (#2067 Phase 2b).
///
/// The input must match the JSON shape produced by
/// [`parse_irealb`]. Round-trip identity is guaranteed for any
/// JSON `parse_irealb` produced on the same library version.
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the input
/// is not valid JSON or does not match the AST shape (missing
/// required fields, out-of-range values).
#[must_use = "callers must handle serialization errors"]
pub fn serialize_irealb(input: String) -> Result<String, ChordSketchError> {
    use chordsketch_ireal::FromJson;
    let song = chordsketch_ireal::IrealSong::from_json_str(&input).map_err(|e| {
        ChordSketchError::ConversionFailed {
            reason: format!("invalid AST JSON: {e}"),
        }
    })?;
    Ok(chordsketch_ireal::irealb_serialize(&song))
}

/// Render an `irealb://` URL as an iReal Pro-style PNG image
/// (#2067 Phase 2c).
///
/// Pipeline: [`chordsketch_ireal::parse`] →
/// [`chordsketch_render_ireal::png::render_png`] with the default
/// [`chordsketch_render_ireal::png::PngOptions`] (300 DPI,
/// A4-equivalent canvas).
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the URL is
/// not a valid `irealb://` payload, or when the underlying
/// rasteriser fails.
#[must_use = "callers must handle render errors"]
pub fn render_ireal_png(input: String) -> Result<Vec<u8>, ChordSketchError> {
    let ireal =
        chordsketch_ireal::parse(&input).map_err(|e| ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        })?;
    chordsketch_render_ireal::png::render_png(
        &ireal,
        &chordsketch_render_ireal::png::PngOptions::default(),
    )
    .map_err(|e| ChordSketchError::ConversionFailed {
        reason: format!("PNG render failed: {e}"),
    })
}

/// Render an `irealb://` URL as a single-page A4 PDF document
/// (#2067 Phase 2c).
///
/// Pipeline: [`chordsketch_ireal::parse`] →
/// [`chordsketch_render_ireal::pdf::render_pdf`] with the default
/// [`chordsketch_render_ireal::pdf::PdfOptions`].
///
/// # Errors
///
/// Returns [`ChordSketchError::ConversionFailed`] when the URL is
/// not a valid `irealb://` payload, or when the underlying
/// converter fails.
#[must_use = "callers must handle render errors"]
pub fn render_ireal_pdf(input: String) -> Result<Vec<u8>, ChordSketchError> {
    let ireal =
        chordsketch_ireal::parse(&input).map_err(|e| ChordSketchError::ConversionFailed {
            reason: e.to_string(),
        })?;
    chordsketch_render_ireal::pdf::render_pdf(
        &ireal,
        &chordsketch_render_ireal::pdf::PdfOptions::default(),
    )
    .map_err(|e| ChordSketchError::ConversionFailed {
        reason: format!("PDF render failed: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_INPUT: &str = "{title: Test}\n[C]Hello";

    #[test]
    fn test_render_text() {
        let result = parse_and_render_text(MINIMAL_INPUT.to_string(), None, None);
        assert!(result.is_ok());
        let text = result.unwrap();
        assert!(text.contains("Test"));
        assert!(text.contains("Hello"));
    }

    #[test]
    fn test_render_html() {
        let result = parse_and_render_html(MINIMAL_INPUT.to_string(), None, None);
        assert!(result.is_ok());
        let html = result.unwrap();
        assert!(html.contains("Test"));
    }

    #[test]
    fn test_render_pdf() {
        let result = parse_and_render_pdf(MINIMAL_INPUT.to_string(), None, None);
        assert!(result.is_ok());
        let bytes = result.unwrap();
        assert!(bytes.starts_with(b"%PDF"));
    }

    #[test]
    fn test_render_with_transpose() {
        let result = parse_and_render_text(MINIMAL_INPUT.to_string(), None, Some(2));
        assert!(result.is_ok());
    }

    #[test]
    fn test_render_with_preset_config() {
        let result =
            parse_and_render_text(MINIMAL_INPUT.to_string(), Some("guitar".to_string()), None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_render_with_rrjson_config() {
        let result = parse_and_render_text(
            MINIMAL_INPUT.to_string(),
            Some(r#"{ "settings": { "transpose": 2 } }"#.to_string()),
            None,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_invalid_config() {
        let result = parse_and_render_text(
            MINIMAL_INPUT.to_string(),
            Some("{ invalid rrjson !!!".to_string()),
            None,
        );
        assert!(result.is_err());
        match result.unwrap_err() {
            ChordSketchError::InvalidConfig { reason } => {
                assert!(!reason.is_empty());
            }
            other => panic!("expected InvalidConfig, got {other:?}"),
        }
    }

    #[test]
    fn test_validate_valid_input() {
        let errors = validate(MINIMAL_INPUT.to_string());
        assert!(errors.is_empty());
    }

    #[test]
    fn test_validate_returns_errors_for_bad_input() {
        // An unclosed chord bracket is always a parse error, even in lenient mode.
        let errors = validate("{title: Test}\n[G".to_string());
        assert!(
            !errors.is_empty(),
            "unclosed chord should produce a parse error"
        );
        assert!(
            errors[0].message.contains("unclosed"),
            "error message should mention 'unclosed', got: {}",
            errors[0].message
        );
        assert!(errors[0].line >= 1, "line should be one-based");
        assert!(errors[0].column >= 1, "column should be one-based");
    }

    #[test]
    fn test_version() {
        let v = version();
        assert!(!v.is_empty());
    }

    #[test]
    fn test_chord_diagram_svg_known_guitar() {
        let svg = chord_diagram_svg("Am".to_string(), "guitar".to_string()).unwrap();
        let svg = svg.expect("Am should be in the built-in guitar voicing database");
        assert!(svg.contains("<svg"), "expected inline SVG, got: {svg}");
        assert!(svg.contains("Am"));
    }

    #[test]
    fn test_chord_diagram_svg_known_piano() {
        let svg = chord_diagram_svg("C".to_string(), "piano".to_string()).unwrap();
        let svg = svg.expect("C should be in the built-in piano voicing database");
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_chord_diagram_svg_unknown_chord_returns_none() {
        // A chord name the database has no voicing for must return
        // `Ok(None)` rather than an error — hosts pattern-match on
        // the optional to render a "chord not found" fallback.
        let svg = chord_diagram_svg("ZZZ7sus4".to_string(), "guitar".to_string()).unwrap();
        assert!(svg.is_none());
    }

    #[test]
    fn test_chord_diagram_svg_unknown_instrument_errors() {
        let err = chord_diagram_svg("C".to_string(), "theremin".to_string())
            .expect_err("unsupported instrument should reject");
        match err {
            ChordSketchError::InvalidConfig { reason } => {
                assert!(reason.contains("theremin"), "unexpected reason: {reason}");
            }
            _ => panic!("expected InvalidConfig, got: {err:?}"),
        }
    }

    #[test]
    fn test_chord_diagram_svg_instrument_aliases() {
        // `"uke"` should route through the same path as `"ukulele"`.
        let svg = chord_diagram_svg("Am".to_string(), "uke".to_string()).unwrap();
        assert!(svg.is_some());
        // `"keyboard"` should route through the piano branch.
        let svg = chord_diagram_svg("C".to_string(), "keyboard".to_string()).unwrap();
        assert!(svg.is_some());
    }

    #[test]
    fn test_render_succeeds_despite_parse_warnings() {
        // Input with an unclosed chord produces parse warnings, but the
        // lenient parser still yields a song that can be rendered.
        // Callers who want diagnostics should call validate() separately.
        let input = "{title: Warn}\n[C]Hello [G\nWorld".to_string();
        let result = parse_and_render_text(input.clone(), None, None);
        assert!(result.is_ok(), "render should succeed despite parse errors");
        let text = result.unwrap();
        assert!(text.contains("Warn"), "title should be rendered");

        // validate() surfaces the warnings that render silently discards.
        let warnings = validate(input);
        assert!(
            !warnings.is_empty(),
            "validate should report the unclosed chord"
        );
    }

    #[test]
    fn test_roundtrip_text() {
        let input = "{title: Roundtrip Test}\n{subtitle: FFI}\n\n[Am]First [G]line\n[C]Second line";
        let result = parse_and_render_text(input.to_string(), None, None);
        assert!(result.is_ok());
        let text = result.unwrap();
        assert!(text.contains("Roundtrip Test"));
        assert!(text.contains("First"));
        assert!(text.contains("Second"));
    }

    #[test]
    fn test_roundtrip_html() {
        let input = "{title: Roundtrip Test}\n[Am]Hello [G]World";
        let result = parse_and_render_html(input.to_string(), None, None);
        assert!(result.is_ok());
        let html = result.unwrap();
        assert!(html.contains("Roundtrip Test"));
        assert!(html.contains("Hello"));
    }

    #[test]
    fn test_roundtrip_pdf() {
        let input = "{title: PDF Roundtrip}\n[C]Test";
        let result = parse_and_render_pdf(input.to_string(), None, None);
        assert!(result.is_ok());
        let bytes = result.unwrap();
        assert!(!bytes.is_empty());
        assert!(bytes.starts_with(b"%PDF"));
    }

    // -- *_with_warnings variants (#1827) ---------------------------------

    #[test]
    fn test_render_text_with_warnings_returns_output() {
        let result =
            parse_and_render_text_with_warnings(MINIMAL_INPUT.to_string(), None, None).unwrap();
        assert!(result.output.contains("Test"));
        assert!(
            result.warnings.is_empty(),
            "minimal input produces no warnings; got {:?}",
            result.warnings
        );
    }

    #[test]
    fn test_render_html_with_warnings_returns_html() {
        let result =
            parse_and_render_html_with_warnings(MINIMAL_INPUT.to_string(), None, None).unwrap();
        assert!(result.output.contains("<html") || result.output.contains("<!DOCTYPE"));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_render_pdf_with_warnings_returns_pdf_bytes() {
        let result =
            parse_and_render_pdf_with_warnings(MINIMAL_INPUT.to_string(), None, None).unwrap();
        assert!(result.output.starts_with(b"%PDF"));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_render_text_with_warnings_captures_transpose_saturation() {
        // A `{transpose: 100}` directive combined with an API `transpose: 100`
        // exceeds the `i8` range (200 > 127); the renderer saturates and
        // emits a warning. Confirm the warning is captured as structured
        // data rather than silently vanishing to stderr.
        let input = "{title: T}\n{transpose: 100}\n[C]Hello";
        let result =
            parse_and_render_text_with_warnings(input.to_string(), None, Some(100)).unwrap();
        assert!(
            !result.warnings.is_empty(),
            "expected at least one transpose-saturation warning; got {:?}",
            result.warnings
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.to_lowercase().contains("transpose")),
            "at least one warning should mention 'transpose'; got {:?}",
            result.warnings
        );
    }

    #[test]
    fn test_render_text_with_warnings_honours_transpose() {
        // Plumbing regression guard: the wrapper must forward `transpose`
        // to the renderer. A refactor that dropped the parameter would
        // pass test_render_text_with_warnings_returns_output but fail here.
        let zero =
            parse_and_render_text_with_warnings(MINIMAL_INPUT.to_string(), None, Some(0)).unwrap();
        let shifted =
            parse_and_render_text_with_warnings(MINIMAL_INPUT.to_string(), None, Some(2)).unwrap();
        assert_ne!(
            zero.output, shifted.output,
            "transpose=2 must produce different output from transpose=0"
        );
    }

    #[test]
    fn test_render_text_with_warnings_honours_config_preset() {
        // Plumbing regression guard for `config_json` — asserts preset
        // resolution reaches the renderer, matching the `_with_options`
        // entry point's contract.
        let result = parse_and_render_text_with_warnings(
            MINIMAL_INPUT.to_string(),
            Some("guitar".to_string()),
            None,
        );
        assert!(result.is_ok(), "guitar preset must resolve: {result:?}");
    }

    #[test]
    fn test_render_text_with_warnings_invalid_config_errors() {
        // Invalid config surfaces through the same `InvalidConfig` error
        // variant as the plain `parse_and_render_text`.
        let result = parse_and_render_text_with_warnings(
            MINIMAL_INPUT.to_string(),
            Some("{ not valid rrjson".to_string()),
            None,
        );
        assert!(
            matches!(result, Err(ChordSketchError::InvalidConfig { .. })),
            "expected InvalidConfig; got {result:?}"
        );
    }

    // ---- iReal Pro conversion bindings (#2067 Phase 1) ----

    /// Reused tiny `irealb://` fixture from `chordsketch-convert`'s
    /// `from_ireal.rs` integration tests — a deterministic source for
    /// the `irealb_to_chordpro_text` direction.
    const TINY_IREAL_URL: &str = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

    #[test]
    fn test_convert_chordpro_to_irealb_returns_url() {
        // Smoke test: a minimal ChordPro source produces an
        // `irealb://`-prefixed URL. Asserts only the protocol scheme
        // because `irealb_serialize`'s exact body is the serializer's
        // own test surface (#2052).
        let result = convert_chordpro_to_irealb(MINIMAL_INPUT.to_string())
            .expect("conversion succeeds for valid ChordPro");
        assert!(
            result.output.starts_with("irealb://"),
            "expected irealb:// URL, got: {}",
            result.output
        );
    }

    #[test]
    fn test_convert_chordpro_to_irealb_empty_input_succeeds() {
        // Edge case: empty input. The lenient parser produces a
        // trailing empty `Song`, which converts to an empty
        // `IrealSong` with no warnings. Should not error.
        let result = convert_chordpro_to_irealb(String::new()).expect("empty input must not error");
        assert!(result.output.starts_with("irealb://"));
    }

    #[test]
    fn test_convert_irealb_to_chordpro_text_renders_barlines() {
        // Round-trip: parse the tiny URL, convert to a ChordPro AST,
        // render as text. The renderer's barline handling is the
        // structural integrity check (per `convert/tests/from_ireal.rs`).
        let result = convert_irealb_to_chordpro_text(TINY_IREAL_URL.to_string())
            .expect("conversion succeeds for known-good URL");
        assert!(!result.output.is_empty(), "rendered text must not be empty");
        assert!(
            result.output.contains('|'),
            "rendered text must preserve bar boundaries; got: {}",
            result.output
        );
    }

    #[test]
    fn test_convert_irealb_to_chordpro_text_invalid_url_errors() {
        // Invalid URL surfaces through `ConversionFailed` rather than
        // panicking. Distinct error variant so consumers can branch
        // on conversion vs config failures.
        let result = convert_irealb_to_chordpro_text("not a url".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }

    // ---- iReal Pro SVG render (#2067 Phase 2a) ----

    #[test]
    fn test_render_ireal_svg_emits_svg_document() {
        // Smoke test: a valid `irealb://` URL produces a string that
        // begins with `<svg`. Asserting only the prefix because the
        // exact SVG content is `chordsketch-render-ireal`'s test
        // surface, not this binding's.
        let svg = render_ireal_svg(TINY_IREAL_URL.to_string())
            .expect("render succeeds for known-good URL");
        assert!(
            svg.contains("<svg"),
            "expected SVG document, got: {}",
            &svg[..svg.len().min(200)]
        );
    }

    #[test]
    fn test_render_ireal_svg_invalid_url_errors() {
        // Sister-binding parity with
        // `test_convert_irealb_to_chordpro_text_invalid_url_errors`.
        let result = render_ireal_svg("not a url".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }

    // ---- iReal Pro AST round-trip (#2067 Phase 2b) ----

    #[test]
    fn test_parse_irealb_emits_ast_json() {
        let json = parse_irealb(TINY_IREAL_URL.to_string()).expect("parse succeeds");
        assert!(json.starts_with('{'), "expected JSON object, got: {json}");
        assert!(
            json.contains("\"sections\""),
            "JSON must include the sections array, got: {json}"
        );
        assert!(
            json.contains("\"key_signature\""),
            "JSON must include the key_signature field, got: {json}"
        );
    }

    #[test]
    fn test_parse_irealb_invalid_url_errors() {
        let result = parse_irealb("not a url".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }

    #[test]
    fn test_serialize_irealb_round_trip() {
        // parse → serialize → parse must yield byte-equal JSON. The
        // first → JSON edge is `chordsketch_ireal::ToJson`; the JSON
        // → URL → JSON loop pins the wire-format contract advertised
        // in the public docstring.
        let json1 = parse_irealb(TINY_IREAL_URL.to_string()).expect("parse succeeds");
        let url2 = serialize_irealb(json1.clone()).expect("serialize succeeds");
        assert!(
            url2.starts_with("irealb://"),
            "expected irealb:// URL, got: {url2}"
        );
        let json2 = parse_irealb(url2).expect("re-parse succeeds");
        assert_eq!(
            json1, json2,
            "AST JSON must be stable across a parse → serialize → parse round-trip"
        );
    }

    #[test]
    fn test_serialize_irealb_invalid_json_errors() {
        let result = serialize_irealb("{ not real json".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }

    #[test]
    fn test_serialize_irealb_missing_required_field_errors() {
        // `IrealSong::from_json_value` requires every documented field.
        // An empty object should be rejected, not silently filled with
        // defaults.
        let result = serialize_irealb("{}".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }

    // ---- iReal Pro PNG / PDF render (#2067 Phase 2c) ----

    #[test]
    fn test_render_ireal_png_emits_png_bytes() {
        let bytes = render_ireal_png(TINY_IREAL_URL.to_string())
            .expect("render succeeds for known-good URL");
        assert!(
            bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n",
            "expected PNG signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[test]
    fn test_render_ireal_png_invalid_url_errors() {
        let result = render_ireal_png("not a url".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }

    #[test]
    fn test_render_ireal_pdf_emits_pdf_bytes() {
        let bytes = render_ireal_pdf(TINY_IREAL_URL.to_string())
            .expect("render succeeds for known-good URL");
        assert!(
            bytes.starts_with(b"%PDF-"),
            "expected PDF signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[test]
    fn test_render_ireal_pdf_invalid_url_errors() {
        let result = render_ireal_pdf("not a url".to_string());
        assert!(
            matches!(result, Err(ChordSketchError::ConversionFailed { .. })),
            "expected ConversionFailed; got {result:?}"
        );
    }
}
