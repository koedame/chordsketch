//! Native Node.js addon for ChordSketch via [napi-rs](https://napi.rs/).
//!
//! Provides the same API as `@chordsketch/wasm` but as a prebuilt native
//! addon, offering better performance and no WASM overhead.

use chordsketch_chordpro::render_result::RenderResult;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Render options matching the WASM package API.
#[napi(object)]
pub struct RenderOptions {
    /// Semitone transposition offset. Defaults to 0.
    ///
    /// Must fit in `i8` (`-128..=127`). Values outside that range cause
    /// the call to reject with `Status::InvalidArg`, matching the CLI,
    /// UniFFI, and WASM bindings (issue #1826 — previously this binding
    /// silently clamped, which produced different output for the same
    /// input depending on which binding was used).
    pub transpose: Option<i32>,
    /// Configuration preset name (e.g., "guitar", "ukulele") or inline
    /// RRJSON configuration string.
    pub config: Option<String>,
}

/// Resolve a config from an optional preset name or RRJSON string.
///
/// Returns `Result<_, String>` (not `napi::Result`) so unit tests can
/// exercise this helper without pulling in `napi::Error`'s `Drop` impl,
/// which references `napi_reference_unref` / `napi_delete_reference` —
/// symbols the Node.js host resolves at runtime, so a native test
/// binary that links them fails with `undefined symbol`. The `#[napi]`
/// wrappers below convert the `String` error into `napi::Error` at the
/// binding boundary.
fn resolve_config_inner(
    config: Option<&str>,
) -> std::result::Result<chordsketch_chordpro::config::Config, String> {
    match config {
        Some(name) => {
            if let Some(preset) = chordsketch_chordpro::config::Config::preset(name) {
                Ok(preset)
            } else {
                chordsketch_chordpro::config::Config::parse(name).map_err(|e| {
                    format!("invalid config (not a known preset and not valid RRJSON): {e}")
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
/// code (#1083) and the previous `Result` return type was vestigial.
fn parse_songs(input: &str) -> Vec<chordsketch_chordpro::ast::Song> {
    let result = chordsketch_chordpro::parse_multi_lenient(input);
    result.results.into_iter().map(|r| r.song).collect()
}

/// Forward each warning in a [`RenderResult`] to `eprintln!` and unwrap the
/// output.
///
/// In a Node.js addon, `eprintln!` writes to process stderr, which is visible
/// to callers (unlike WASM in a browser context where stderr is silently
/// dropped). This matches the WASM binding's `flush_warnings` pattern: both
/// bindings now explicitly capture warnings via `render_songs_with_warnings`
/// rather than relying on the renderer's internal eprintln paths. See #1541.
fn flush_warnings<T>(result: RenderResult<T>) -> T {
    for w in &result.warnings {
        eprintln!("chordsketch: {w}");
    }
    result.output
}

/// Parse and render songs as a string, forwarding any render warnings to stderr.
///
/// Single source of truth for all string-output render calls. Accepts a
/// `render_fn` so it can be shared by text and HTML renderers. Pure
/// Rust — no `napi::Result` — so unit tests can exercise the full
/// parse → render → flush_warnings path natively. See
/// [`resolve_config_inner`] for the `napi::Error::Drop` linkage
/// rationale.
fn do_render_string(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<String>,
) -> String {
    let songs = parse_songs(input);
    flush_warnings(render_fn(&songs, transpose, config))
}

/// Parse and render songs as bytes, forwarding any render warnings to stderr.
///
/// See [`do_render_string`] — same pattern for PDF output.
fn do_render_bytes(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
) -> Vec<u8> {
    let songs = parse_songs(input);
    flush_warnings(render_fn(&songs, transpose, config))
}

/// Render ChordPro input as plain text using default configuration.
///
/// Use [`render_text_with_options`] to pass a config preset, inline RRJSON,
/// or transposition.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_text(input: String) -> Result<String> {
    Ok(do_render_string(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_text::render_songs_with_warnings,
    ))
}

/// Render ChordPro input as an HTML document using default configuration.
///
/// Use [`render_html_with_options`] to pass a config preset, inline RRJSON,
/// or transposition.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html(input: String) -> Result<String> {
    Ok(do_render_string(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_html::render_songs_with_warnings,
    ))
}

/// Render ChordPro input as a PDF document using default configuration
/// (returned as a Buffer).
///
/// Use [`render_pdf_with_options`] to pass a config preset, inline RRJSON,
/// or transposition.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_pdf(input: String) -> Result<Buffer> {
    let bytes = do_render_bytes(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_pdf::render_songs_with_warnings,
    );
    Ok(bytes.into())
}

/// Structured render result returned by the `*_with_warnings` family
/// (string outputs).
///
/// Callers that need warning-driven UI (inline banners, telemetry
/// aggregation, selective suppression) should use the `*_with_warnings`
/// entry points. The plain variants (`renderText`, `renderHtml`,
/// `renderPdf`) forward warnings to `eprintln!`, which lands on process
/// stderr — fine for CLI scripts but invisible to a React component
/// embedding the addon. See issue #1827.
#[napi(object)]
pub struct TextRenderWithWarnings {
    /// Rendered text or HTML output.
    pub output: String,
    /// Renderer warnings captured during the render pass.
    pub warnings: Vec<String>,
}

/// Structured render result for PDF output. See
/// [`TextRenderWithWarnings`] for the warnings contract.
#[napi(object)]
pub struct PdfRenderWithWarnings {
    /// PDF byte stream.
    pub output: Buffer,
    /// Renderer warnings captured during the render pass.
    pub warnings: Vec<String>,
}

/// String-returning render that captures warnings as structured data.
///
/// Shared by `render_text_with_warnings` and `render_html_with_warnings`
/// so both variants route through the same parse + render + capture
/// pipeline without the `flush_warnings` stderr side effect. Returns a
/// `(String, Vec<String>)` tuple so unit tests can drive it without
/// constructing the napi-coupled `TextRenderWithWarnings` struct (the
/// `#[napi(object)]` attribute is fine in native builds, but staying
/// in plain Rust types here keeps this helper symmetric with
/// `do_render_pdf_with_warnings`, which cannot return its struct
/// natively because of the `Buffer` field).
fn do_render_string_with_warnings(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<String>,
) -> (String, Vec<String>) {
    let songs = parse_songs(input);
    let result = render_fn(&songs, transpose, config);
    (result.output, result.warnings)
}

/// Render ChordPro input as plain text, returning both output and
/// captured warnings.
///
/// This is the structured variant of [`render_text`]. Warnings are
/// returned as an array of strings instead of being forwarded to
/// process stderr via `eprintln!`. Callers that do not need warnings
/// should keep using the plain `render_text`.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_text_with_warnings(input: String) -> Result<TextRenderWithWarnings> {
    let (output, warnings) = do_render_string_with_warnings(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_text::render_songs_with_warnings,
    );
    Ok(TextRenderWithWarnings { output, warnings })
}

/// Render ChordPro input as HTML, returning both output and captured
/// warnings.
///
/// See [`render_text_with_warnings`] for the warnings contract.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_with_warnings(input: String) -> Result<TextRenderWithWarnings> {
    let (output, warnings) = do_render_string_with_warnings(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_html::render_songs_with_warnings,
    );
    Ok(TextRenderWithWarnings { output, warnings })
}

/// Render ChordPro input as a PDF document, returning the byte stream
/// alongside captured warnings.
///
/// See [`render_text_with_warnings`] for the warnings contract.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_pdf_with_warnings(input: String) -> Result<PdfRenderWithWarnings> {
    let (bytes, warnings) =
        do_render_pdf_with_warnings(&input, &chordsketch_chordpro::config::Config::defaults(), 0);
    Ok(PdfRenderWithWarnings {
        output: bytes.into(),
        warnings,
    })
}

/// Shared implementation for the PDF `*_with_warnings` variants. Extracted
/// so [`render_pdf_with_warnings`] and
/// [`render_pdf_with_warnings_and_options`] route through the same
/// parse + render + capture pipeline. Returns a `(Vec<u8>, Vec<String>)`
/// tuple so unit tests can drive it without constructing
/// `PdfRenderWithWarnings`, whose `Buffer` field is napi-coupled.
fn do_render_pdf_with_warnings(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
) -> (Vec<u8>, Vec<String>) {
    let songs = parse_songs(input);
    let result = chordsketch_render_pdf::render_songs_with_warnings(&songs, transpose, config);
    (result.output, result.warnings)
}

/// Coerce a JS-supplied transposition value to `i8`, rejecting
/// out-of-range integers.
///
/// Every other binding (CLI via clap, UniFFI at the boundary, WASM via
/// `serde_wasm_bindgen`) rejects integers that do not fit in `i8`.
/// napi-rs has no built-in `i8` unmarshaling — the wire type is `i32` —
/// so the check has to run here at the first opportunity. Mapped to an
/// `InvalidArg` error at the `#[napi]` boundary by [`resolve_options`],
/// giving the same failure shape across all four bindings for the same
/// input (issue #1826). `render_html_css_with_options` does not appear
/// here because it has no `transpose` argument — the CSS renderer is
/// transpose-invariant.
///
/// The previous implementation clamped instead of rejecting, which
/// silently produced a different musical result for inputs outside
/// `-128..=127` compared with the other three bindings. See #1065 for
/// the earlier iteration of this divergence.
///
/// Pure Rust — see [`resolve_config_inner`] for the `napi::Error::Drop`
/// linkage rationale.
fn try_parse_transpose(raw: i32) -> std::result::Result<i8, String> {
    i8::try_from(raw).map_err(|_| {
        format!(
            "transpose value {raw} is out of range; expected an integer \
             in -128..=127 (matches CLI / UniFFI / WASM binding semantics)"
        )
    })
}

/// Pure-Rust resolution of the `(config, transpose)` pair that every
/// `*_with_options` entry point needs. Returns a `String` error so
/// unit tests can drive every options-validation branch without
/// constructing `napi::Error`. The `#[napi]` wrappers convert at the
/// boundary via [`resolve_options`].
fn resolve_options_inner(
    config: Option<&str>,
    transpose: i32,
) -> std::result::Result<(chordsketch_chordpro::config::Config, i8), String> {
    let config = resolve_config_inner(config)?;
    let transpose = try_parse_transpose(transpose)?;
    Ok((config, transpose))
}

/// `napi::Result` wrapper around [`resolve_options_inner`]. Single
/// source of truth for the `String` → `napi::Error` mapping done by
/// every `*_with_options` entry point.
fn resolve_options(options: RenderOptions) -> Result<(chordsketch_chordpro::config::Config, i8)> {
    resolve_options_inner(options.config.as_deref(), options.transpose.unwrap_or(0))
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// Render ChordPro input as plain text with options.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_text_with_options(input: String, options: RenderOptions) -> Result<String> {
    let (config, transpose) = resolve_options(options)?;
    Ok(do_render_string(
        &input,
        &config,
        transpose,
        chordsketch_render_text::render_songs_with_warnings,
    ))
}

/// Render ChordPro input as an HTML document with options.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_with_options(input: String, options: RenderOptions) -> Result<String> {
    let (config, transpose) = resolve_options(options)?;
    Ok(do_render_string(
        &input,
        &config,
        transpose,
        chordsketch_render_html::render_songs_with_warnings,
    ))
}

/// Render ChordPro input as a PDF document with options (returned as a Buffer).
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_pdf_with_options(input: String, options: RenderOptions) -> Result<Buffer> {
    let (config, transpose) = resolve_options(options)?;
    let bytes = do_render_bytes(
        &input,
        &config,
        transpose,
        chordsketch_render_pdf::render_songs_with_warnings,
    );
    Ok(bytes.into())
}

/// Render ChordPro input as plain text with options, returning both output
/// and captured warnings.
///
/// Combines the `options` payload of [`render_text_with_options`] with the
/// structured-warning capture of [`render_text_with_warnings`] (#1895).
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_text_with_warnings_and_options(
    input: String,
    options: RenderOptions,
) -> Result<TextRenderWithWarnings> {
    let (config, transpose) = resolve_options(options)?;
    let (output, warnings) = do_render_string_with_warnings(
        &input,
        &config,
        transpose,
        chordsketch_render_text::render_songs_with_warnings,
    );
    Ok(TextRenderWithWarnings { output, warnings })
}

/// Render ChordPro input as HTML with options, returning both output and
/// captured warnings.
///
/// See [`render_text_with_warnings_and_options`] for the contract.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_with_warnings_and_options(
    input: String,
    options: RenderOptions,
) -> Result<TextRenderWithWarnings> {
    let (config, transpose) = resolve_options(options)?;
    let (output, warnings) = do_render_string_with_warnings(
        &input,
        &config,
        transpose,
        chordsketch_render_html::render_songs_with_warnings,
    );
    Ok(TextRenderWithWarnings { output, warnings })
}

/// Render ChordPro input as a PDF document with options, returning the byte
/// stream alongside captured warnings.
///
/// See [`render_text_with_warnings_and_options`] for the contract.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_pdf_with_warnings_and_options(
    input: String,
    options: RenderOptions,
) -> Result<PdfRenderWithWarnings> {
    let (config, transpose) = resolve_options(options)?;
    let (bytes, warnings) = do_render_pdf_with_warnings(&input, &config, transpose);
    Ok(PdfRenderWithWarnings {
        output: bytes.into(),
        warnings,
    })
}

/// Render ChordPro input as a body-only HTML fragment using default
/// configuration.
///
/// Unlike [`render_html`], the returned string is just the
/// `<div class="song">...</div>` markup — no `<!DOCTYPE>`, `<html>`,
/// `<head>`, `<title>`, or embedded `<style>` block. Use this from
/// hosts that supply their own document envelope so the rendered
/// chord-over-lyrics layout does not depend on HTML5's nested-document
/// recovery rules — see #2279.
///
/// Pair with [`render_html_css`] to obtain the matching stylesheet.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_body(input: String) -> Result<String> {
    Ok(do_render_string(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_html::render_songs_body_with_warnings,
    ))
}

/// Render ChordPro input as a body-only HTML fragment with options.
///
/// See [`render_html_body`] for the body-only contract.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_body_with_options(input: String, options: RenderOptions) -> Result<String> {
    let (config, transpose) = resolve_options(options)?;
    Ok(do_render_string(
        &input,
        &config,
        transpose,
        chordsketch_render_html::render_songs_body_with_warnings,
    ))
}

/// Render ChordPro input as a body-only HTML fragment, returning both
/// output and captured warnings.
///
/// See [`render_html_body`] for the body-only contract and
/// [`render_text_with_warnings`] for the warnings contract.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_body_with_warnings(input: String) -> Result<TextRenderWithWarnings> {
    let (output, warnings) = do_render_string_with_warnings(
        &input,
        &chordsketch_chordpro::config::Config::defaults(),
        0,
        chordsketch_render_html::render_songs_body_with_warnings,
    );
    Ok(TextRenderWithWarnings { output, warnings })
}

/// Render ChordPro input as a body-only HTML fragment with options,
/// returning both output and captured warnings.
///
/// Combines the options payload of [`render_html_body_with_options`]
/// with the structured-warning capture of
/// [`render_html_body_with_warnings`].
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_body_with_warnings_and_options(
    input: String,
    options: RenderOptions,
) -> Result<TextRenderWithWarnings> {
    let (config, transpose) = resolve_options(options)?;
    let (output, warnings) = do_render_string_with_warnings(
        &input,
        &config,
        transpose,
        chordsketch_render_html::render_songs_body_with_warnings,
    );
    Ok(TextRenderWithWarnings { output, warnings })
}

/// Returns the canonical chord-over-lyrics CSS that
/// [`render_html`] / [`render_html_with_options`] embed inside
/// `<style>`.
///
/// Pair with [`render_html_body`] / [`render_html_body_with_options`]
/// when the consumer is supplying its own document envelope.
#[must_use]
#[napi]
pub fn render_html_css() -> String {
    chordsketch_render_html::render_html_css()
}

/// Pure-Rust implementation of [`render_html_css_with_options`].
fn render_html_css_with_options_inner(config: Option<&str>) -> std::result::Result<String, String> {
    let config = resolve_config_inner(config)?;
    Ok(chordsketch_render_html::render_html_css_with_config(
        &config,
    ))
}

/// Variant of [`render_html_css`] that honours `settings.wraplines` from
/// the supplied options (R6.100.0). When `wraplines` is false, the `.line`
/// rule emits `flex-wrap: nowrap` so chord/lyric runs preserve the source
/// line structure instead of reflowing onto subsequent rows.
///
/// See [`render_html_with_options`] for the `options` format.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_css_with_options(options: RenderOptions) -> napi::Result<String> {
    render_html_css_with_options_inner(options.config.as_deref())
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// A single validation issue reported by [`validate`]. Mirrors the
/// `ValidationError` interface in `crates/napi/index.d.ts`; the `#[napi(object)]`
/// attribute marshals this into a plain JS `{line, column, message}` record.
///
/// Line and column are one-based, matching the rest of the public API and
/// the numbers a typical editor diagnostic expects. They are `u32` so
/// napi-rs can marshal them as plain JS `number`s; overflow is impossible
/// in practice — a ChordPro source long enough to exceed `u32::MAX` lines
/// is orders of magnitude above any realistic song file.
#[napi(object)]
pub struct ValidationError {
    /// One-based line number where the issue was detected.
    pub line: u32,
    /// One-based column number where the issue was detected.
    pub column: u32,
    /// Human-readable description of the issue.
    pub message: String,
}

/// Validate ChordPro input and return any parse errors as structured
/// records. Returns an empty array if the input is valid.
///
/// The shape matches the TypeScript `ValidationError[]` declaration in
/// `index.d.ts`. Prior to #1990 this function returned `Vec<String>`; the
/// previous spelling is gone in this version rather than kept as a
/// compatibility shim — the structured form is strictly richer and the
/// package has no pinned consumers that depend on the string form.
#[must_use]
#[napi]
pub fn validate(input: String) -> Vec<ValidationError> {
    let result = chordsketch_chordpro::parse_multi_lenient(&input);
    result
        .results
        .into_iter()
        .flat_map(|r| r.errors.into_iter())
        .map(|e| ValidationError {
            // `line()` / `column()` are `usize`; clamp the (astronomically
            // unlikely) overflow at `u32::MAX` so we never panic on
            // conversion.
            line: u32::try_from(e.line()).unwrap_or(u32::MAX),
            column: u32::try_from(e.column()).unwrap_or(u32::MAX),
            message: e.message,
        })
        .collect()
}

/// Return the ChordSketch library version.
#[must_use]
#[napi]
pub fn version() -> String {
    chordsketch_chordpro::version().to_string()
}

/// Pure-Rust implementation of [`chord_diagram_svg`] /
/// [`chord_diagram_svg_with_defines`]. `defines` is a slice of
/// `(name, raw)` pairs matching
/// `chordsketch_chordpro::voicings::lookup_diagram`'s contract —
/// the built-in voicing database is consulted only when no entry
/// in `defines` matches the chord name.
fn chord_diagram_svg_inner(
    chord: &str,
    instrument: &str,
    defines: &[(String, String)],
) -> std::result::Result<Option<String>, String> {
    use chordsketch_chordpro::chord_diagram::{render_keyboard_svg, render_svg};
    use chordsketch_chordpro::voicings::{lookup_diagram, lookup_keyboard_voicing};

    match instrument.to_ascii_lowercase().as_str() {
        "piano" | "keyboard" | "keys" => {
            // Keyboard voicings have their own `{define: … keys …}`
            // shape; the wasm sister-site does not thread defines
            // through this branch either. Match that gap here so
            // NAPI behaviour stays consistent.
            Ok(lookup_keyboard_voicing(chord, &[]).map(|v| render_keyboard_svg(&v)))
        }
        "guitar" | "ukulele" | "uke" => {
            // `frets_shown = 5` matches the default ChordPro HTML
            // renderer (`crates/render-html` emits 5-fret diagrams
            // when no `{chordfrets}` directive is set), keeping
            // diagrams produced via NAPI visually consistent with
            // sheets rendered through the same binding.
            Ok(lookup_diagram(chord, defines, instrument, 5).map(|d| render_svg(&d)))
        }
        other => Err(format!(
            "unknown instrument {other:?}; expected one of \"guitar\", \"ukulele\", \"piano\""
        )),
    }
}

/// Look up an SVG chord diagram for the given chord name and
/// instrument, mirroring the WASM `chord_diagram_svg` export
/// added in #2164.
///
/// `instrument` accepts (case-insensitive): `"guitar"`,
/// `"ukulele"` (alias `"uke"`), or `"piano"` (aliases
/// `"keyboard"`, `"keys"`). `chord` is a standard ChordPro
/// chord name. Flat spellings are normalised to sharps via the
/// same path the core voicing-database lookup uses.
///
/// Returns the inline SVG string, or `null` (JavaScript `null`)
/// when the built-in voicing database has no entry for this
/// `(chord, instrument)` pair. Hosts typically render a
/// "chord not found" fallback for that case.
///
/// # Errors
///
/// Returns a napi `Error` with status `InvalidArg` when
/// `instrument` is not one of the supported values.
#[must_use = "callers must handle the unknown-instrument error"]
#[napi]
pub fn chord_diagram_svg(chord: String, instrument: String) -> Result<Option<String>> {
    chord_diagram_svg_inner(&chord, &instrument, &[])
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// Like [`chord_diagram_svg`], but consults song-level
/// `{define}` voicings before falling back to the built-in
/// voicing database. `defines` is a list of `[name, raw]`
/// tuples — `raw` is the directive body (e.g.
/// `"base-fret 1 frets 3 3 0 0 1 3"`). Mirrors
/// `chordsketch_chordpro::voicings::lookup_diagram`'s
/// "song-level defines take priority" rule so user-defined
/// chords show up here exactly like the Rust HTML renderer's
/// `<section class="chord-diagrams">` block. Sister-site to
/// the wasm `chordDiagramSvgWithDefines` and FFI
/// `chord_diagram_svg_with_defines` exports
/// (`.claude/rules/fix-propagation.md` §Bindings).
///
/// # Errors
///
/// Returns a napi `Error` with status `InvalidArg` when
/// `instrument` is not one of the supported values.
#[must_use = "callers must handle the unknown-instrument error"]
#[napi(js_name = "chordDiagramSvgWithDefines")]
pub fn chord_diagram_svg_with_defines(
    chord: String,
    instrument: String,
    defines: Vec<Vec<String>>,
) -> Result<Option<String>> {
    // napi-rs's `tuple` support is limited; accept `Array<[name,
    // raw]>` as `Vec<Vec<String>>` and reject malformed inner
    // arrays at the boundary. Each entry must have exactly two
    // elements; anything else is a caller error.
    let mut pairs: Vec<(String, String)> = Vec::with_capacity(defines.len());
    for (i, entry) in defines.into_iter().enumerate() {
        if entry.len() != 2 {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "defines[{i}] must be [name, raw] (length 2); got length {}",
                    entry.len()
                ),
            ));
        }
        let mut it = entry.into_iter();
        let name = it.next().expect("length checked above");
        let raw = it.next().expect("length checked above");
        pairs.push((name, raw));
    }
    chord_diagram_svg_inner(&chord, &instrument, &pairs)
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// Structured result for ChordPro ↔ iReal Pro conversions
/// (#2067 Phase 1).
///
/// Mirrors the FFI / WASM `ConversionWithWarnings` shape so every
/// binding exposes the same surface: `output` is the converted
/// string, `warnings` is a list of human-readable diagnostics.
#[napi(object)]
pub struct ConversionWithWarnings {
    /// Converted output string.
    pub output: String,
    /// Warnings captured during conversion.
    pub warnings: Vec<String>,
}

/// Format a [`chordsketch_convert::ConversionWarning`] as a stable
/// `"<kind>: <message>"` string. Keeps WASM / NAPI / FFI in lockstep.
fn format_conversion_warning(w: &chordsketch_convert::ConversionWarning) -> String {
    let kind = match w.kind {
        chordsketch_convert::WarningKind::LossyDrop => "lossy-drop",
        chordsketch_convert::WarningKind::Approximated => "approximated",
        chordsketch_convert::WarningKind::Unsupported => "unsupported",
        // `WarningKind` is `#[non_exhaustive]`; fall back to a generic
        // tag so a future variant addition does not silently break
        // this binding's compilation. Sister bindings do the same.
        _ => "warning",
    };
    format!("{kind}: {}", w.message)
}

/// Run the ChordPro → iReal pipeline and return `(url, warnings)`.
///
/// Returns `Result<_, String>` (not `napi::Result`) so the Rust unit
/// tests in this file can exercise the conversion logic without
/// pulling in `napi::Error`'s `Drop` impl, which references
/// `napi_reference_unref` / `napi_delete_reference`. Those symbols are
/// only resolved at runtime by the Node.js host, so a test binary
/// that links them fails with `undefined symbol` (this NAPI crate's
/// existing test pattern is to call the underlying chordpro logic
/// directly for the same reason). The `#[napi]` wrapper below maps
/// the `String` error into `napi::Error` at the binding boundary.
fn do_convert_chordpro_to_irealb(
    input: &str,
) -> std::result::Result<(String, Vec<String>), String> {
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    // `split_at_new_song` unconditionally pushes `&input[seg_start..]`
    // last, so `parse_multi_lenient` always returns at least one result;
    // `next()` is provably `Some`.
    let song = parse_result
        .results
        .into_iter()
        .next()
        .map(|r| r.song)
        .expect("parse_multi_lenient always returns at least one result");
    let converted = chordsketch_convert::chordpro_to_ireal(&song)
        .map_err(|e| format!("conversion failed: {e}"))?;
    let url = chordsketch_ireal::irealb_serialize(&converted.output);
    Ok((
        url,
        converted
            .warnings
            .iter()
            .map(format_conversion_warning)
            .collect(),
    ))
}

/// Run the iReal → ChordPro pipeline and return `(rendered_text, warnings)`.
///
/// Same `Result<_, String>` contract as
/// [`do_convert_chordpro_to_irealb`] — see that function's note for
/// why the helper does not return `napi::Result`.
fn do_convert_irealb_to_chordpro_text(
    input: &str,
) -> std::result::Result<(String, Vec<String>), String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    let converted = chordsketch_convert::ireal_to_chordpro(&ireal)
        .map_err(|e| format!("conversion failed: {e}"))?;
    let text = chordsketch_render_text::render_song(&converted.output);
    Ok((
        text,
        converted
            .warnings
            .iter()
            .map(format_conversion_warning)
            .collect(),
    ))
}

/// Convert a ChordPro source string into an `irealb://` URL
/// (#2067 Phase 1).
///
/// Lossy: lyrics, fonts / colours, capo are dropped (iReal has no
/// surface for them). Each drop appears in the returned `warnings`.
///
/// # Errors
///
/// Rejects with status `GenericFailure` when the converter
/// surfaces a [`chordsketch_convert::ConversionError`].
#[must_use = "callers must handle conversion errors"]
#[napi]
pub fn convert_chordpro_to_irealb(input: String) -> Result<ConversionWithWarnings> {
    let (output, warnings) = do_convert_chordpro_to_irealb(&input)
        .map_err(|reason| Error::new(Status::GenericFailure, reason))?;
    Ok(ConversionWithWarnings { output, warnings })
}

/// Convert an `irealb://` URL into rendered ChordPro text
/// (#2067 Phase 1).
///
/// Output is the `chordsketch-render-text` rendering of the
/// converted song, not raw ChordPro source — there is no source
/// emitter in the workspace yet (deferred to a follow-up PR).
///
/// # Errors
///
/// Rejects with status `GenericFailure` when the URL is not a
/// valid `irealb://` payload.
#[must_use = "callers must handle conversion errors"]
#[napi]
pub fn convert_irealb_to_chordpro_text(input: String) -> Result<ConversionWithWarnings> {
    let (output, warnings) = do_convert_irealb_to_chordpro_text(&input)
        .map_err(|reason| Error::new(Status::GenericFailure, reason))?;
    Ok(ConversionWithWarnings { output, warnings })
}

/// Run the iReal SVG-render pipeline; native helper so the Rust
/// unit tests can exercise the path without linking against
/// `napi::Error`'s `Drop` impl. See `do_convert_chordpro_to_irealb`
/// for the full rationale.
fn do_render_ireal_svg(input: &str) -> std::result::Result<String, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    Ok(chordsketch_render_ireal::render_svg(
        &ireal,
        &chordsketch_render_ireal::RenderOptions::default(),
    ))
}

/// Render an `irealb://` URL as an iReal Pro-style SVG chart
/// (#2067 Phase 2a).
///
/// Pipeline: `chordsketch_ireal::parse` →
/// `chordsketch_render_ireal::render_svg` with default
/// `RenderOptions`.
///
/// # Errors
///
/// Rejects with status `GenericFailure` when the URL is not a
/// valid `irealb://` payload.
#[must_use = "callers must handle conversion errors"]
#[napi]
pub fn render_ireal_svg(input: String) -> Result<String> {
    do_render_ireal_svg(&input).map_err(|reason| Error::new(Status::GenericFailure, reason))
}

/// Run the iReal URL → AST JSON pipeline; native helper. See
/// [`do_convert_chordpro_to_irealb`] for the `Result<_, String>`
/// rationale.
fn do_parse_irealb(input: &str) -> std::result::Result<String, String> {
    use chordsketch_ireal::ToJson;
    let song = chordsketch_ireal::parse(input).map_err(|e| format!("parse failed: {e}"))?;
    Ok(song.to_json_string())
}

/// Run the AST JSON → iReal URL pipeline; native helper.
fn do_serialize_irealb(input: &str) -> std::result::Result<String, String> {
    use chordsketch_ireal::FromJson;
    let song = chordsketch_ireal::IrealSong::from_json_str(input)
        .map_err(|e| format!("invalid AST JSON: {e}"))?;
    Ok(chordsketch_ireal::irealb_serialize(&song))
}

/// Parse an `irealb://` URL into an AST-shaped JSON string
/// (#2067 Phase 2b).
///
/// The returned JSON object mirrors the `IrealSong` AST in
/// `chordsketch-ireal`. Pair with [`serialize_irealb`] for the
/// inverse direction. Field additions are non-breaking; field
/// removals or renames require a major version bump.
///
/// # Errors
///
/// Rejects with status `GenericFailure` when the URL is not a
/// valid `irealb://` payload.
#[must_use = "callers must handle parse errors"]
#[napi]
pub fn parse_irealb(input: String) -> Result<String> {
    do_parse_irealb(&input).map_err(|reason| Error::new(Status::GenericFailure, reason))
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
/// Rejects with status `GenericFailure` when the input is not
/// valid JSON or does not match the AST shape (missing required
/// fields, out-of-range values).
#[must_use = "callers must handle serialization errors"]
#[napi]
pub fn serialize_irealb(input: String) -> Result<String> {
    do_serialize_irealb(&input).map_err(|reason| Error::new(Status::GenericFailure, reason))
}

/// Run the iReal PNG-rasterise pipeline; native helper so the Rust
/// unit tests can exercise the path without linking against
/// `napi::Error`'s `Drop` impl. See `do_render_ireal_svg` for the
/// full rationale.
fn do_render_ireal_png(input: &str) -> std::result::Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::png::render_png(
        &ireal,
        &chordsketch_render_ireal::png::PngOptions::default(),
    )
    .map_err(|e| format!("PNG render failed: {e}"))
}

/// Run the iReal PDF-render pipeline; native helper.
fn do_render_ireal_pdf(input: &str) -> std::result::Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::pdf::render_pdf(
        &ireal,
        &chordsketch_render_ireal::pdf::PdfOptions::default(),
    )
    .map_err(|e| format!("PDF render failed: {e}"))
}

/// Render an `irealb://` URL as an iReal Pro-style PNG image
/// (#2067 Phase 2c).
///
/// Pipeline: `chordsketch_ireal::parse` →
/// `chordsketch_render_ireal::png::render_png` with default
/// `PngOptions` (300 DPI). Returned as a `Buffer` so Node.js
/// callers can write it directly to a file or stream.
///
/// # Errors
///
/// Rejects with status `GenericFailure` when the URL is not a
/// valid `irealb://` payload, or when the underlying rasteriser
/// fails.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_ireal_png(input: String) -> Result<Buffer> {
    let bytes =
        do_render_ireal_png(&input).map_err(|reason| Error::new(Status::GenericFailure, reason))?;
    Ok(bytes.into())
}

/// Render an `irealb://` URL as a single-page A4 PDF document
/// (#2067 Phase 2c).
///
/// Pipeline: `chordsketch_ireal::parse` →
/// `chordsketch_render_ireal::pdf::render_pdf` with default
/// `PdfOptions`. Returned as a `Buffer` of the PDF byte stream.
///
/// # Errors
///
/// Rejects with status `GenericFailure` when the URL is not a
/// valid `irealb://` payload, or when the underlying converter
/// fails.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_ireal_pdf(input: String) -> Result<Buffer> {
    let bytes =
        do_render_ireal_pdf(&input).map_err(|reason| Error::new(Status::GenericFailure, reason))?;
    Ok(bytes.into())
}

// Unit tests exercise the pure-Rust helpers (`do_render_*`,
// `resolve_*_inner`, `try_parse_transpose`, `chord_diagram_svg_inner`,
// `do_convert_*`, `do_render_ireal_*`, `do_parse_irealb`,
// `do_serialize_irealb`, …) that every `#[napi] pub fn` wraps. The
// `#[napi]` wrappers themselves cannot be called from `cargo test --lib`
// because their return types reference `napi::Error`, whose `Drop` impl
// links against `napi_reference_unref` / `napi_delete_reference` —
// symbols only resolved by the Node.js host at runtime. The wrappers'
// bodies are 1–3 line shims around the helpers, so exercising the
// helpers covers the binding's full business logic.
#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_INPUT: &str = "{title: Test}\n[C]Hello";

    #[test]
    fn test_render_text_returns_content() {
        // Drives the pure-Rust `do_render_string` helper that
        // `render_text` / `render_text_with_options` /
        // `render_html_body_with_options` all delegate to.
        let text = do_render_string(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
            chordsketch_render_text::render_songs_with_warnings,
        );
        assert!(!text.is_empty());
        assert!(text.contains("Test"));
    }

    #[test]
    fn test_render_html_returns_content() {
        let html = do_render_string(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
            chordsketch_render_html::render_songs_with_warnings,
        );
        assert!(!html.is_empty());
        assert!(html.contains("Test"));
    }

    #[test]
    fn test_render_pdf_returns_bytes() {
        let bytes = do_render_bytes(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
            chordsketch_render_pdf::render_songs_with_warnings,
        );
        assert!(!bytes.is_empty());
        assert!(bytes.starts_with(b"%PDF"));
    }

    #[test]
    fn test_do_render_string_with_warnings_returns_tuple() {
        // `*_with_warnings` family routes through this. Empty warning
        // list on minimal input pins the contract: no spurious
        // diagnostics for valid documents.
        let (output, warnings) = do_render_string_with_warnings(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
            chordsketch_render_text::render_songs_with_warnings,
        );
        assert!(output.contains("Test"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_do_render_string_with_warnings_captures_saturation() {
        // Out-of-range transpose produces a renderer warning, which the
        // helper must surface in the second tuple element so that the
        // `#[napi]` wrapper can wrap it into `TextRenderWithWarnings`.
        let (_, warnings) = do_render_string_with_warnings(
            "{title: T}\n{transpose: 100}\n[C]Hello",
            &chordsketch_chordpro::config::Config::defaults(),
            100,
            chordsketch_render_text::render_songs_with_warnings,
        );
        assert!(
            !warnings.is_empty(),
            "out-of-musical-range transpose must surface as a warning"
        );
    }

    #[test]
    fn test_do_render_pdf_with_warnings_returns_tuple() {
        let (bytes, warnings) = do_render_pdf_with_warnings(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
        );
        assert!(bytes.starts_with(b"%PDF"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_version_returns_nonempty_string() {
        let v = chordsketch_chordpro::version();
        assert!(!v.is_empty());
    }

    #[test]
    fn test_try_parse_transpose_in_range_passes_through() {
        // After #1826, parse_transpose rejects out-of-range i32 values
        // so the NAPI binding matches the CLI / UniFFI / WASM "reject"
        // contract rather than silently clamping. Tests use the pure-
        // Rust helper `try_parse_transpose` (see its doc comment) so
        // that `cargo test --lib` does not have to link Node-API.
        use super::try_parse_transpose;
        assert_eq!(try_parse_transpose(0).unwrap(), 0);
        assert_eq!(try_parse_transpose(7).unwrap(), 7);
        assert_eq!(try_parse_transpose(-7).unwrap(), -7);
        assert_eq!(try_parse_transpose(12).unwrap(), 12);
        assert_eq!(try_parse_transpose(-12).unwrap(), -12);
        // Boundary values pass through.
        assert_eq!(try_parse_transpose(127).unwrap(), 127);
        assert_eq!(try_parse_transpose(-128).unwrap(), -128);
    }

    #[test]
    fn test_try_parse_transpose_out_of_range_rejected() {
        // Every value one step past the i8 boundary must error with a
        // message that carries the offending value.
        use super::try_parse_transpose;
        for bad in [128_i32, 129, 200, 1_000_000, i32::MAX] {
            let msg = try_parse_transpose(bad).unwrap_err();
            assert!(
                msg.contains("out of range") && msg.contains(&bad.to_string()),
                "positive out-of-range {bad} must report its value; got {msg:?}"
            );
        }
        for bad in [-129_i32, -200, -1_000_000, i32::MIN] {
            let msg = try_parse_transpose(bad).unwrap_err();
            assert!(
                msg.contains("out of range") && msg.contains(&bad.to_string()),
                "negative out-of-range {bad} must report its value; got {msg:?}"
            );
        }
    }

    #[test]
    fn test_validate_returns_empty_for_valid_input() {
        let result = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let errors: Vec<_> = result.results.into_iter().flat_map(|r| r.errors).collect();
        assert!(errors.is_empty());
    }

    #[test]
    fn test_validate_returns_errors_for_bad_input() {
        let result = chordsketch_chordpro::parse_multi_lenient("{title: Test}\n[G");
        let errors: Vec<_> = result.results.into_iter().flat_map(|r| r.errors).collect();
        assert!(!errors.is_empty());
    }

    #[test]
    fn test_preset_config_resolves() {
        assert!(chordsketch_chordpro::config::Config::preset("guitar").is_some());
        assert!(chordsketch_chordpro::config::Config::preset("nonexistent").is_none());
    }

    #[test]
    fn test_invalid_config_fails() {
        assert!(chordsketch_chordpro::config::Config::parse("{ invalid rrjson !!!").is_err());
    }

    #[test]
    fn test_valid_rrjson_config_parses() {
        assert!(
            chordsketch_chordpro::config::Config::parse(r#"{ "settings": { "transpose": 2 } }"#)
                .is_ok()
        );
    }

    /// Verifies that `render_songs_with_warnings` captures warnings rather than
    /// silently discarding them. The saturation input ({transpose: 100} in
    /// source + 100 CLI transpose = 200 > 127) reliably triggers a "transpose
    /// clamped" warning from the renderer. This is the regression test for
    /// #1541: previously `render_songs_with_transpose` was called instead,
    /// which routed warnings to internal eprintln and made them invisible
    /// to the napi binding.
    #[test]
    fn test_render_songs_with_warnings_captures_saturation_warning() {
        let input = "{title: T}\n{transpose: 100}\n[C]Hello";
        let result = chordsketch_chordpro::parse_multi_lenient(input);
        let songs: Vec<_> = result.results.into_iter().map(|r| r.song).collect();
        let render_result = chordsketch_render_text::render_songs_with_warnings(
            &songs,
            100,
            &chordsketch_chordpro::config::Config::defaults(),
        );
        assert!(
            !render_result.warnings.is_empty(),
            "expected at least one transpose saturation warning, got none"
        );
        assert!(
            !render_result.output.is_empty(),
            "render output must not be empty"
        );
    }

    // -- *_with_warnings exposes structured warnings (#1827) ---------------
    //
    // The `#[napi]` wrappers `render_*_with_warnings` return
    // `napi::Result<TextRenderWithWarnings>` / `napi::Result<PdfRenderWithWarnings>`,
    // whose error path references Node-API symbols via `Drop`. Tests
    // therefore bypass the wrapper and exercise the underlying
    // chordsketch-chordpro renderer directly, mirroring the pattern used by
    // `test_try_parse_transpose_*` for issue #1826.

    #[test]
    fn test_with_warnings_captures_core_output() {
        let result = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let songs: Vec<_> = result.results.into_iter().map(|r| r.song).collect();
        let text = chordsketch_render_text::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        );
        assert!(!text.output.is_empty());
        assert!(
            text.warnings.is_empty(),
            "minimal input should produce no warnings; got {:?}",
            text.warnings
        );
        let html = chordsketch_render_html::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        );
        assert!(html.output.contains("<html"));
        assert!(html.warnings.is_empty());
        let pdf = chordsketch_render_pdf::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        );
        assert!(pdf.output.starts_with(b"%PDF"));
        assert!(pdf.warnings.is_empty());
    }

    #[test]
    fn test_text_render_with_warnings_struct_fields_exist() {
        // Compile-time check that `TextRenderWithWarnings::output` is
        // a String and `.warnings` is a Vec<String> — these field names
        // and types are part of the public #[napi(object)] API, so a
        // rename is a breaking change that should be deliberate.
        let v = super::TextRenderWithWarnings {
            output: String::from("ok"),
            warnings: vec!["w".to_string()],
        };
        assert_eq!(v.output, "ok");
        assert_eq!(v.warnings, vec!["w".to_string()]);
    }

    // -- *_with_warnings_and_options (#1895) ------------------------------
    //
    // The new `render_*_with_warnings_and_options` wrappers cannot be
    // called directly from `cargo test --lib` because their return types
    // (`Result<_, napi::Error>` and `Buffer`) reference Node-API symbols
    // via `Drop`. The same constraint applies to every other `#[napi]` in
    // this file, so the established pattern is to exercise the underlying
    // chordsketch-chordpro code paths that the wrapper delegates to.
    //
    // The wrapper body is a three-line delegation:
    //   1. `resolve_config(options.config)?`
    //   2. `parse_transpose(options.transpose.unwrap_or(0))?`
    //   3. `do_render_*_with_warnings(&input, &config, transpose, …)`
    //
    // Step 1 is exercised by `test_with_warnings_captures_core_output`
    // (via `Config::defaults`). Step 2 is exercised by
    // `test_try_parse_transpose_*`. Step 3 — the plumbing that carries
    // `transpose` through the renderer — is covered below.

    #[test]
    fn test_transpose_option_changes_text_render_output() {
        // Regression guard: a refactor of
        // `render_text_with_warnings_and_options` that forgot to thread
        // `opts.transpose` into the renderer would compile (`0` is the
        // default) but silently ignore the option. The pure renderer
        // call below proves the core renderer responds to `transpose`,
        // which pins down exactly the contract the wrapper promises.
        let result = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let songs: Vec<_> = result.results.into_iter().map(|r| r.song).collect();
        let zero = chordsketch_render_text::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        )
        .output;
        let shifted = chordsketch_render_text::render_songs_with_warnings(
            &songs,
            2,
            &chordsketch_chordpro::config::Config::defaults(),
        )
        .output;
        assert_ne!(
            zero, shifted,
            "transpose=2 must produce different output from transpose=0"
        );
    }

    #[test]
    fn test_transpose_option_changes_html_render_output() {
        // Same plumbing guard for the HTML variant.
        let result = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let songs: Vec<_> = result.results.into_iter().map(|r| r.song).collect();
        let zero = chordsketch_render_html::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        )
        .output;
        let shifted = chordsketch_render_html::render_songs_with_warnings(
            &songs,
            2,
            &chordsketch_chordpro::config::Config::defaults(),
        )
        .output;
        assert_ne!(
            zero, shifted,
            "transpose=2 must produce different output from transpose=0"
        );
    }

    #[test]
    fn test_transpose_option_changes_pdf_render_output() {
        // Same plumbing guard for the PDF variant.
        let result = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let songs: Vec<_> = result.results.into_iter().map(|r| r.song).collect();
        let zero = chordsketch_render_pdf::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        )
        .output;
        let shifted = chordsketch_render_pdf::render_songs_with_warnings(
            &songs,
            2,
            &chordsketch_chordpro::config::Config::defaults(),
        )
        .output;
        assert_ne!(zero, shifted, "transpose=2 must alter the PDF byte stream");
        assert!(zero.starts_with(b"%PDF"));
    }

    #[test]
    fn test_config_option_preset_resolves() {
        // Minimal regression guard that the preset-name path of
        // `resolve_config` used by `*_with_warnings_and_options` still
        // returns a `Some(...)`. The preset's effect on rendered output
        // depends on which config option it sets and what the input
        // exercises, which is covered by the Config tests in
        // chordsketch-chordpro; this test just pins the name-lookup contract
        // so a future rename of the "guitar" preset would surface here.
        let preset = chordsketch_chordpro::config::Config::preset("guitar");
        assert!(preset.is_some(), "the 'guitar' preset must be available");
    }

    // ---- iReal Pro conversion bindings (#2067 Phase 1) ----

    /// Reused tiny `irealb://` fixture from
    /// `chordsketch-convert/tests/from_ireal.rs`.
    const TINY_IREAL_URL: &str = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

    #[test]
    fn test_convert_chordpro_to_irealb_helper() {
        // Exercises the napi-free helper so a regression in the
        // pipeline surfaces in Rust unit tests, not only via Jest.
        let (url, _warnings) = super::do_convert_chordpro_to_irealb(MINIMAL_INPUT).unwrap();
        assert!(
            url.starts_with("irealb://"),
            "expected irealb:// URL, got: {url}"
        );
    }

    #[test]
    fn test_convert_chordpro_to_irealb_empty_input_succeeds() {
        // Edge case: empty input. The lenient parser always returns at
        // least one segment, so conversion must succeed without error.
        let (url, _warnings) = super::do_convert_chordpro_to_irealb("").unwrap();
        assert!(url.starts_with("irealb://"));
    }

    #[test]
    fn test_convert_irealb_to_chordpro_text_helper() {
        let (text, _warnings) = super::do_convert_irealb_to_chordpro_text(TINY_IREAL_URL).unwrap();
        assert!(!text.is_empty(), "rendered text must not be empty");
        assert!(
            text.contains('|'),
            "rendered text must preserve bar boundaries; got: {text}"
        );
    }

    #[test]
    fn test_convert_irealb_to_chordpro_text_invalid_url_errors() {
        let result = super::do_convert_irealb_to_chordpro_text("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- iReal Pro SVG render (#2067 Phase 2a) ----

    #[test]
    fn test_render_ireal_svg_emits_svg_document() {
        let svg = super::do_render_ireal_svg(TINY_IREAL_URL).unwrap();
        assert!(
            svg.contains("<svg"),
            "expected SVG document, got: {}",
            &svg[..svg.len().min(200)]
        );
    }

    #[test]
    fn test_render_ireal_svg_invalid_url_errors() {
        let result = super::do_render_ireal_svg("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- iReal Pro AST round-trip (#2067 Phase 2b) ----

    #[test]
    fn test_parse_irealb_emits_ast_json() {
        let json = super::do_parse_irealb(TINY_IREAL_URL).unwrap();
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
        let result = super::do_parse_irealb("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_serialize_irealb_round_trip() {
        // parse → serialize → parse must yield byte-equal JSON.
        let json1 = super::do_parse_irealb(TINY_IREAL_URL).unwrap();
        let url2 = super::do_serialize_irealb(&json1).unwrap();
        assert!(
            url2.starts_with("irealb://"),
            "expected irealb:// URL, got: {url2}"
        );
        let json2 = super::do_parse_irealb(&url2).unwrap();
        assert_eq!(
            json1, json2,
            "AST JSON must be stable across a parse → serialize → parse round-trip"
        );
    }

    #[test]
    fn test_serialize_irealb_invalid_json_errors() {
        let result = super::do_serialize_irealb("{ not real json");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_serialize_irealb_missing_required_field_errors() {
        // `IrealSong::from_json_value` requires every documented field.
        // An empty object should be rejected, not silently filled with
        // defaults.
        let result = super::do_serialize_irealb("{}");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- iReal Pro PNG / PDF render (#2067 Phase 2c) ----

    #[test]
    fn test_render_ireal_png_emits_png_bytes() {
        let bytes = super::do_render_ireal_png(TINY_IREAL_URL).unwrap();
        assert!(
            bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n",
            "expected PNG signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[test]
    fn test_render_ireal_png_invalid_url_errors() {
        let result = super::do_render_ireal_png("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_render_ireal_pdf_emits_pdf_bytes() {
        let bytes = super::do_render_ireal_pdf(TINY_IREAL_URL).unwrap();
        assert!(
            bytes.starts_with(b"%PDF-"),
            "expected PDF signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[test]
    fn test_render_ireal_pdf_invalid_url_errors() {
        let result = super::do_render_ireal_pdf("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- pure-Rust helpers behind every `*_with_options` napi wrapper ----

    #[test]
    fn test_resolve_config_inner_default_when_none() {
        let cfg = resolve_config_inner(None).unwrap();
        // Default config equals the workspace default; assert against
        // the public constructor to pin the equality contract.
        let expected = chordsketch_chordpro::config::Config::defaults();
        assert_eq!(format!("{cfg:?}"), format!("{expected:?}"));
    }

    #[test]
    fn test_resolve_config_inner_preset_resolves() {
        // Every supported preset must round-trip through the helper.
        for preset in ["guitar", "ukulele"] {
            assert!(
                resolve_config_inner(Some(preset)).is_ok(),
                "preset {preset:?} must resolve"
            );
        }
    }

    #[test]
    fn test_resolve_config_inner_inline_rrjson_parses() {
        let cfg = resolve_config_inner(Some(r#"{ "settings": { "transpose": 2 } }"#));
        assert!(cfg.is_ok(), "valid inline RRJSON must parse, got {cfg:?}");
    }

    #[test]
    fn test_resolve_config_inner_invalid_rrjson_errors() {
        let err = resolve_config_inner(Some("{ invalid rrjson !!!")).unwrap_err();
        assert!(
            err.contains("not a known preset and not valid RRJSON"),
            "error must point at both failure modes; got {err:?}"
        );
    }

    #[test]
    fn test_resolve_options_inner_pairs_config_and_transpose() {
        // Config came from the preset path; transpose is forwarded
        // unchanged because 5 fits in i8.
        let (cfg, transpose) = resolve_options_inner(Some("guitar"), 5).unwrap();
        let preset = chordsketch_chordpro::config::Config::preset("guitar")
            .expect("guitar preset must exist");
        assert_eq!(format!("{cfg:?}"), format!("{preset:?}"));
        assert_eq!(transpose, 5);
    }

    #[test]
    fn test_resolve_options_inner_propagates_transpose_overflow() {
        let err = resolve_options_inner(None, 200).unwrap_err();
        assert!(
            err.contains("out of range"),
            "out-of-range transpose (200) must propagate as a validation error; got {err:?}"
        );
    }

    #[test]
    fn test_resolve_options_inner_propagates_config_error() {
        let err = resolve_options_inner(Some("not a preset and not valid"), 0).unwrap_err();
        assert!(
            err.contains("not a known preset and not valid RRJSON"),
            "config error must propagate; got {err:?}"
        );
    }

    #[test]
    fn test_render_html_css_with_options_inner_default() {
        let css = render_html_css_with_options_inner(None).unwrap();
        // Same canonical chord-block CSS as `render_html_css()`.
        assert!(css.contains(".chord-block"));
        assert!(css.contains(".lyrics"));
    }

    #[test]
    fn test_render_html_css_with_options_inner_invalid_config_errors() {
        let err = render_html_css_with_options_inner(Some("{ invalid rrjson !!!")).unwrap_err();
        assert!(err.contains("not a known preset and not valid RRJSON"));
    }

    #[test]
    fn test_chord_diagram_svg_inner_guitar_known_chord_returns_svg() {
        let svg = chord_diagram_svg_inner("C", "guitar", &[]).unwrap();
        let svg = svg.expect("guitar C must have a built-in diagram");
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_chord_diagram_svg_inner_ukulele_alias_resolves() {
        // "uke" is documented as an alias for "ukulele".
        let svg = chord_diagram_svg_inner("C", "uke", &[]).unwrap();
        assert!(svg.is_some(), "ukulele C must resolve via the uke alias");
    }

    #[test]
    fn test_chord_diagram_svg_inner_piano_keyboard_aliases_resolve() {
        for alias in ["piano", "keyboard", "keys"] {
            let result = chord_diagram_svg_inner("C", alias, &[]);
            assert!(
                result.is_ok(),
                "{alias:?} must be accepted as a piano alias; got {result:?}"
            );
        }
    }

    #[test]
    fn test_chord_diagram_svg_inner_unknown_chord_returns_none() {
        // Unknown chord under a known instrument must yield Ok(None),
        // not Err — the docstring promises hosts can render their own
        // fallback for misses.
        let result = chord_diagram_svg_inner("XYZ-not-a-chord", "guitar", &[]).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_chord_diagram_svg_inner_unknown_instrument_errors() {
        let err = chord_diagram_svg_inner("C", "harmonica", &[]).unwrap_err();
        assert!(
            err.contains("unknown instrument") && err.contains("harmonica"),
            "error must name the offending instrument; got {err:?}"
        );
    }

    #[test]
    fn test_chord_diagram_svg_inner_instrument_lookup_is_case_insensitive() {
        // The wrapper documents the instrument argument as case-
        // insensitive; the helper's `to_ascii_lowercase` must honour
        // that promise for every alias.
        for variant in ["GUITAR", "Guitar", "gUiTaR"] {
            let svg = chord_diagram_svg_inner("C", variant, &[])
                .unwrap_or_else(|e| panic!("case variant {variant:?} must not error; got {e:?}"));
            assert!(
                svg.is_some(),
                "case variant {variant:?} must find a guitar-C diagram; got None"
            );
        }
    }

    #[test]
    fn test_parse_songs_always_returns_at_least_one() {
        // Lenient parser contract pinned at the binding boundary: the
        // `*_with_options` wrappers rely on this to skip an `is_empty`
        // guard. See #1083 for the prior dead-code removal.
        for input in ["", "no directives", MINIMAL_INPUT] {
            let songs = parse_songs(input);
            assert!(
                !songs.is_empty(),
                "parse_songs({input:?}) returned an empty Vec"
            );
        }
    }
}
