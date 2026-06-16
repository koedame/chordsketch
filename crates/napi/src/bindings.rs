//! `#[napi]` entry points for the `@chordsketch/node` Node.js addon.
//!
//! Every Node-API ABI thunk lives in this file. The proc-macro expansion
//! of `#[napi]` / `#[napi(object)]` emits `extern "C"` glue against Node-
//! API runtime symbols (`napi_reference_unref`, `napi_create_buffer`, …)
//! that are only resolved by the host Node.js process at module load
//! time, not by `cargo test` and not by `cargo llvm-cov`'s instrumented
//! binary. Keeping those declarations in one place lets `codecov.yml`
//! exclude exactly the file whose lines llvm-cov cannot reach, leaving
//! `lib.rs` to report coverage of the pure-Rust helpers each wrapper
//! delegates to (see issue #2352 and the §Bindings note in
//! `codecov.yml`).
//!
//! Every function here is a thin wrapper around a `crate::do_*` /
//! `crate::*_inner` helper in `lib.rs`. Business logic — argument
//! validation, config resolution, render pipeline assembly, format
//! translation — belongs in `lib.rs`. This file holds:
//!
//! - `#[napi(object)]` structs whose `FromNapiValue` / `ToNapiValue`
//!   derives reference Node-API symbols.
//! - `napi::Result` wrappers that convert the helpers' `Result<_,
//!   String>` errors into `napi::Error`.
//! - `#[napi]` public entry points that call the helpers and assemble
//!   the napi-coupled return types (`Buffer`, `TextRenderWithWarnings`,
//!   etc.).
//!
//! If you find yourself adding non-trivial logic here, move it down to
//! `lib.rs` and call it from a new wrapper — the unit-testable surface
//! lives there. The sister-site rule in
//! `.claude/rules/fix-propagation.md` requires that any new public API
//! added here also lands in `crates/wasm/src/bindings.rs` and
//! `crates/ffi/src/lib.rs` in the same PR.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{
    chord_diagram_svg_inner, chord_diagram_svg_inner_with_orientation, chord_pitches_inner,
    do_convert_chordpro_to_irealb, do_convert_irealb_to_chordpro_text, do_parse_irealb,
    do_render_bytes, do_render_ireal_pdf, do_render_ireal_png, do_render_ireal_svg,
    do_render_pdf_with_warnings, do_render_string, do_render_string_with_warnings,
    do_serialize_irealb, render_html_css_with_options_inner, resolve_options_inner,
    validate_defines_pairs, validate_inner,
};

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

/// `napi::Result` wrapper around [`resolve_options_inner`]. Threads the
/// pure-Rust validation of `(config, transpose)` from `RenderOptions`
/// into the napi-Error world that every `#[napi]` entry point lives
/// in.
fn resolve_options(options: RenderOptions) -> Result<(chordsketch_chordpro::config::Config, i8)> {
    resolve_options_inner(options.config.as_deref(), options.transpose.unwrap_or(0))
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
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
/// Emits just the chord-over-lyrics `<article class="song">…</article>`
/// fragment without an enclosing `<html>` / `<head>` / `<body>` envelope.
/// Use this when the caller wants to embed the rendered chart inside an
/// existing page (React component, CMS shortcode, email template) and
/// supply its own document chrome. Pair with [`render_html_css`] to
/// obtain the matching stylesheet.
///
/// In contrast, [`render_html`] returns a full HTML5 document with the
/// canonical stylesheet inlined into a `<style>` block. Both share the
/// same renderer pipeline; the difference is only the outermost
/// wrapping (#2280). Body-only output is intentionally chosen for
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

/// Variant of [`render_html_css`] that honours `settings.wraplines` from
/// the supplied options (R6.100.0). When `wraplines` is false, the `.line`
/// rule emits `flex-wrap: nowrap` so chord/lyric runs preserve the source
/// line structure instead of reflowing onto subsequent rows.
///
/// See [`render_html_with_options`] for the `options` format.
#[must_use = "callers must handle render errors"]
#[napi]
pub fn render_html_css_with_options(options: RenderOptions) -> Result<String> {
    render_html_css_with_options_inner(options.config.as_deref())
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// A single validation issue reported by [`validate`]. Mirrors the
/// `ValidationError` interface in `crates/napi/index.d.ts`; the
/// `#[napi(object)]` attribute marshals this into a plain JS
/// `{line, column, message}` record.
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
    validate_inner(&input)
        .into_iter()
        .map(|p| ValidationError {
            line: p.line,
            column: p.column,
            message: p.message,
        })
        .collect()
}

/// Return the ChordSketch library version.
#[must_use]
#[napi]
pub fn version() -> String {
    chordsketch_chordpro::version().to_string()
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
    let pairs =
        validate_defines_pairs(defines).map_err(|msg| Error::new(Status::InvalidArg, msg))?;
    chord_diagram_svg_inner(&chord, &instrument, &pairs)
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// Constituent pitches of a chord as MIDI note numbers, for driving an
/// audio synth (#2650).
///
/// Returns a `Buffer` of ascending, de-duplicated MIDI note numbers
/// describing a block voicing (root, third, fifth, plus any extension /
/// altered / added tones, with a slash bass dropped one octave below the
/// root), or `null` when `chord` is not parseable as a chord.
///
/// Thin wrapper over the pure-Rust `chord_pitches_inner`. Sister-site to
/// the wasm `chordPitches` export and the FFI `chord_pitches` function
/// (`.claude/rules/fix-propagation.md` §Bindings).
#[must_use]
#[napi(js_name = "chordPitches")]
pub fn chord_pitches(chord: String) -> Option<Buffer> {
    chord_pitches_inner(&chord).map(Buffer::from)
}

/// Variant of [`chord_diagram_svg`] that takes a diagram orientation as
/// an optional string (#2572).
///
/// `orientation` accepts `"vertical"` (default) or `"horizontal"`
/// (case-insensitive). Horizontal mode is reader-view only per
/// ADR-0026. `None` and unrecognised values fall back to the default.
///
/// # Errors
///
/// Returns a napi `Error` with status `InvalidArg` when `instrument` is
/// not one of the supported values.
#[must_use = "callers must handle the unknown-instrument error"]
#[napi(js_name = "chordDiagramSvgWithOrientation")]
pub fn chord_diagram_svg_with_orientation(
    chord: String,
    instrument: String,
    orientation: Option<String>,
) -> Result<Option<String>> {
    chord_diagram_svg_inner_with_orientation(&chord, &instrument, &[], orientation.as_deref())
        .map_err(|msg| Error::new(Status::InvalidArg, msg))
}

/// Combination of [`chord_diagram_svg_with_defines`] and
/// [`chord_diagram_svg_with_orientation`] (#2572).
///
/// # Errors
///
/// Same as [`chord_diagram_svg_with_defines`].
#[must_use = "callers must handle the unknown-instrument error"]
#[napi(js_name = "chordDiagramSvgWithDefinesOrientation")]
pub fn chord_diagram_svg_with_defines_orientation(
    chord: String,
    instrument: String,
    defines: Vec<Vec<String>>,
    orientation: Option<String>,
) -> Result<Option<String>> {
    let pairs =
        validate_defines_pairs(defines).map_err(|msg| Error::new(Status::InvalidArg, msg))?;
    chord_diagram_svg_inner_with_orientation(&chord, &instrument, &pairs, orientation.as_deref())
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
