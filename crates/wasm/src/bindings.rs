//! `#[wasm_bindgen]` entry points for the `@chordsketch/wasm` /
//! `@chordsketch/wasm-export` packages.
//!
//! Every wasm-bindgen ABI thunk lives in this file. The proc-macro
//! expansion of `#[wasm_bindgen]` and `#[wasm_bindgen(start)]` emits
//! `extern "C"` glue against the `__wbindgen_*` runtime that the host
//! JS resolves at module load — those lines are unreachable from
//! `cargo test` (which links the lib as an rlib without the wasm
//! runtime) and from `cargo llvm-cov` (which instruments the same
//! native test binary). `codecov.yml` excludes this file from coverage
//! measurement for that reason; integration coverage of the actual ABI
//! thunks runs under `wasm-pack test --node` against the
//! `#[cfg(all(test, target_arch = "wasm32"))] mod wasm_tests` block in `lib.rs`
//! (issue #2352).
//!
//! Every function here is a thin wrapper around a `crate::*_inner` /
//! `crate::do_*` / `crate::*_core` helper in `lib.rs`. Business logic —
//! parsing, transposition, render-pipeline dispatch, JSON
//! serialisation — belongs in `lib.rs`. This file holds:
//!
//! - The `console_warn` JS import that backs `flush_warnings`.
//! - `JsValue`-returning helpers (`deserialize_options`, `resolve_config`,
//!   `render_string_inner`, …) that the `#[wasm_bindgen]` entry points
//!   compose into the public API.
//! - The `#[wasm_bindgen]` public entry points themselves.
//! - The `#[wasm_bindgen(typescript_custom_section)]` blocks that
//!   shape the emitted `.d.ts`.
//!
//! If you find yourself adding non-trivial logic here, move it down to
//! `lib.rs` and call it from a new wrapper — the unit-testable surface
//! lives there. The sister-site rule in
//! `.claude/rules/fix-propagation.md` requires that any new public API
//! added here also lands in `crates/napi/src/bindings.rs` and
//! `crates/ffi/src/lib.rs` in the same PR.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::{
    RenderOptions, chord_diagram_svg_inner, chord_diagram_svg_inner_with_options,
    chord_diagram_svg_inner_with_orientation, do_chord_typography, do_convert_chordpro_to_irealb,
    do_convert_irealb_to_chordpro_text, do_parse_chordpro, do_parse_irealb, do_render_ireal_svg,
    do_render_string, do_serialize_irealb, render_string_with_warnings_core, resolve_config_inner,
    validate_inner,
};

// `do_render_bytes` / `render_bytes_with_warnings_core` /
// `do_render_ireal_png` / `do_render_ireal_pdf` only compile when the
// `png-pdf` Cargo feature is on (gated to keep the lean
// `@chordsketch/wasm` bundle free of the resvg / svg2pdf transitive
// surface — see crate-level docstring + #2466). Import them
// conditionally so the lean bundle builds clean.
#[cfg(feature = "png-pdf")]
use crate::{
    do_render_bytes, do_render_ireal_pdf, do_render_ireal_png, render_bytes_with_warnings_core,
};

/// Set up the panic hook on module instantiation so any unexpected panic
/// in the renderer surfaces in the JavaScript console with a Rust
/// backtrace instead of an opaque `unreachable executed`. See #1052.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// JS `console.warn` binding, used by [`crate::flush_warnings`] to
/// surface render warnings (transpose saturation, chorus recall
/// limits, deny-listed metadata overrides) to developers in the
/// browser console.
///
/// On wasm32 this resolves to the global `console.warn`. On native test
/// targets it's a no-op so the unit tests in `lib.rs` (which run with
/// `cargo test`, not `wasm-pack test`) still compile and run.
///
/// See #1051 — the previous code path called `render_songs_with_transpose`,
/// which forwards warnings to `eprintln!`. In a browser WASM context
/// stderr is dropped; in Node.js it goes to a console nobody reads.
/// Routing warnings through `console.warn` makes them observable in dev
/// tools without changing the public API surface.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    pub(crate) fn console_warn(s: &str);
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn console_warn(_s: &str) {}

/// Decode a JS-supplied `options` value into a [`RenderOptions`]
/// struct.
///
/// Treats `undefined` and `null` as the default options object so the
/// `*_with_options` entry points can be called without an explicit
/// options argument from JS callers.
fn deserialize_options(options: JsValue) -> Result<RenderOptions, JsValue> {
    if options.is_undefined() || options.is_null() {
        Ok(RenderOptions::default())
    } else {
        serde_wasm_bindgen::from_value(options).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/// `JsValue`-error wrapper around [`resolve_config_inner`]. The single
/// source of truth for the `String` → `JsValue` mapping done by every
/// wasm-bindgen entry point.
fn resolve_config(opts: &RenderOptions) -> Result<chordsketch_chordpro::config::Config, JsValue> {
    resolve_config_inner(opts).map_err(|e| JsValue::from_str(&e))
}

/// Resolve config and dispatch a string-returning render call.
///
/// Single source of truth shared by `render_html` / `render_text` and
/// their `*_with_options` counterparts. Avoids the boilerplate duplication
/// flagged in #1059. Takes `RenderOptions` directly (not `JsValue`) so
/// the no-options entry points can call this on native test targets
/// without touching wasm-bindgen-imported types.
fn render_string_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> chordsketch_chordpro::render_result::RenderResult<String>,
) -> Result<String, JsValue> {
    let config = resolve_config(&opts)?;
    Ok(do_render_string(input, &config, opts.transpose, render_fn))
}

/// Resolve config and dispatch a bytes-returning render call.
///
/// See [`render_string_inner`]. Gated by `png-pdf` — only the PDF
/// renderer surface uses this helper (#2466).
#[cfg(feature = "png-pdf")]
fn render_bytes_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> chordsketch_chordpro::render_result::RenderResult<Vec<u8>>,
) -> Result<Vec<u8>, JsValue> {
    let config = resolve_config(&opts)?;
    Ok(do_render_bytes(input, &config, opts.transpose, render_fn))
}

/// Render ChordPro input as HTML using default configuration.
///
/// Returns the rendered HTML string. Use [`render_html_with_options`]
/// to pass a config preset or transposition.
///
/// The return type is `Result<String, JsValue>` for consistency with
/// the `*_with_options` variant — this function itself never errors
/// because the lenient parser always produces at least one song and
/// the default config never fails to resolve.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_html(input: &str) -> Result<String, JsValue> {
    render_string_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_html::render_songs_with_warnings,
    )
}

/// Render ChordPro input as plain text using default configuration.
///
/// Returns the rendered text string. Use [`render_text_with_options`]
/// to pass a config preset or transposition.
///
/// The return type is `Result<String, JsValue>` for consistency with
/// the `*_with_options` variant — this function itself never errors
/// because the lenient parser always produces at least one song and
/// the default config never fails to resolve.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_text(input: &str) -> Result<String, JsValue> {
    render_string_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_text::render_songs_with_warnings,
    )
}

/// Render ChordPro input as a PDF document using default configuration.
///
/// Returns the PDF as a `Uint8Array`. Use [`render_pdf_with_options`]
/// to pass a config preset or transposition.
///
/// The return type is `Result<Vec<u8>, JsValue>` for consistency with
/// the `*_with_options` variant — this function itself never errors
/// because the lenient parser always produces at least one song and
/// the default config never fails to resolve.
///
/// Only available when the `png-pdf` feature is enabled — i.e. in
/// the `@chordsketch/wasm-export` bundle (#2466). The lean
/// `@chordsketch/wasm` bundle omits this entry to keep the heavy
/// `chordsketch-render-pdf` transitive deps out of the playground
/// load path.
#[cfg(feature = "png-pdf")]
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_pdf(input: &str) -> Result<Vec<u8>, JsValue> {
    render_bytes_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_pdf::render_songs_with_warnings,
    )
}

/// Render ChordPro input as HTML with options.
///
/// `options` is a JavaScript object with optional fields:
/// - `transpose`: semitone offset (integer in `i8` range; the renderer
///   reduces modulo 12 internally)
/// - `config`: preset name ("guitar", "ukulele") or inline RRJSON string
///
/// `undefined` or `null` is accepted and treated as the default options
/// object.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_html_with_options(input: &str, options: JsValue) -> Result<String, JsValue> {
    render_string_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_html::render_songs_with_warnings,
    )
}

/// Render ChordPro input as plain text with options.
///
/// See [`render_html_with_options`] for the `options` format.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_text_with_options(input: &str, options: JsValue) -> Result<String, JsValue> {
    render_string_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_text::render_songs_with_warnings,
    )
}

/// Render ChordPro input as a PDF document with options.
///
/// See [`render_html_with_options`] for the `options` format.
///
/// Returns the PDF as a `Uint8Array`.
///
/// Only available with the `png-pdf` feature
/// (`@chordsketch/wasm-export`, #2466).
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[cfg(feature = "png-pdf")]
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_pdf_with_options(input: &str, options: JsValue) -> Result<Vec<u8>, JsValue> {
    render_bytes_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_pdf::render_songs_with_warnings,
    )
}

/// Render ChordPro input as a body-only HTML fragment using default
/// configuration.
///
/// Unlike [`render_html`], the returned string is just the
/// `<article class="song">...</article>` markup — no `<!DOCTYPE>`, `<html>`,
/// `<head>`, `<title>`, or embedded `<style>` block. Use this from
/// hosts that supply their own document envelope (the playground's
/// `<iframe srcdoc>`, the desktop Tauri shell, the VS Code WebView
/// preview) so the rendered chord-over-lyrics layout does not depend
/// on HTML5's nested-document recovery rules — see #2279.
///
/// Pair with [`render_html_css`] to obtain the matching stylesheet.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_html_body(input: &str) -> Result<String, JsValue> {
    render_string_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_html::render_songs_body_with_warnings,
    )
}

/// Render ChordPro input as a body-only HTML fragment with options.
///
/// See [`render_html_body`] for the body-only contract and
/// [`render_html_with_options`] for the `options` format.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_html_body_with_options(input: &str, options: JsValue) -> Result<String, JsValue> {
    render_string_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_html::render_songs_body_with_warnings,
    )
}

/// Return the canonical chord-over-lyrics CSS that
/// [`render_html`] / [`render_html_with_options`] embed inside
/// `<style>`.
///
/// Pair with [`render_html_body`] / [`render_html_body_with_options`]
/// when the consumer is supplying its own document envelope. The
/// contract is byte-stable; consumers can hash the result for
/// cache-busting filenames or compare it against an expected hash to
/// detect renderer-CSS drift across versions.
#[must_use]
#[wasm_bindgen]
pub fn render_html_css() -> String {
    chordsketch_render_html::render_html_css()
}

/// Variant of [`render_html_css`] that honours `settings.wraplines` from
/// the supplied options (R6.100.0). When `wraplines` is false, the `.line`
/// rule emits `flex-wrap: nowrap` so chord/lyric runs preserve the source
/// line structure instead of reflowing onto subsequent rows.
///
/// See [`render_html_with_options`] for the `options` format.
///
/// # Errors
///
/// Returns a `JsValue` error string if the `config` option value is not a
/// known preset and cannot be parsed as RRJSON.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen]
pub fn render_html_css_with_options(options: JsValue) -> Result<String, JsValue> {
    let opts = deserialize_options(options)?;
    let config = resolve_config(&opts)?;
    Ok(chordsketch_render_html::render_html_css_with_config(
        &config,
    ))
}

/// Structured render result returned by the `*_with_warnings` family.
///
/// Serialized to a plain JS object `{ output, warnings }` where
/// `warnings` is an array of strings captured from the renderer's
/// internal `RenderResult::warnings` instead of being forwarded to
/// `console.warn`. See issue #1827 — callers embedding the WASM
/// package in a UI need structured access to show warnings inline
/// or suppress them programmatically.
#[derive(Serialize)]
struct StringWithWarnings {
    output: String,
    warnings: Vec<String>,
}

/// String-returning render that captures warnings instead of
/// forwarding them to `console.warn`.
///
/// Accepts `RenderOptions` so the same inner routine serves both the
/// no-options `render_*_with_warnings` family (which passes
/// `RenderOptions::default()`) and the `render_*_with_warnings_and_options`
/// family introduced in #1895. Config resolution is shared with
/// `render_string_inner` via [`resolve_config`]. Wasm-bindgen wrapper
/// over [`crate::render_string_with_warnings_core`] — the wrapper
/// exists solely to pack `(output, warnings)` into a `JsValue` via
/// `serde_wasm_bindgen::to_value`, which can only be called on a
/// wasm32 target / under `wasm-pack test --node`.
fn render_string_with_warnings_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> chordsketch_chordpro::render_result::RenderResult<String>,
) -> Result<JsValue, JsValue> {
    let (output, warnings) = render_string_with_warnings_core(input, &opts, render_fn)
        .map_err(|e| JsValue::from_str(&e))?;
    let payload = StringWithWarnings { output, warnings };
    serde_wasm_bindgen::to_value(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Bytes-returning render that captures warnings and returns a JS
/// object `{ output: Uint8Array, warnings: string[] }`.
///
/// Built manually via `js_sys::Object` so the PDF bytes reach JS as a
/// proper `Uint8Array` rather than the plain array `serde_wasm_bindgen`
/// would produce from a `Vec<u8>` field.
///
/// Accepts `RenderOptions` to match [`render_string_with_warnings_inner`].
/// The wasm32 path constructs a `js_sys::Object` with a `Uint8Array`
/// output; on native tests we fall back to the serde serialization
/// (which is dead-code unless a test deliberately exercises this
/// shell — `wasm-pack test --node` covers the `Uint8Array` path).
#[cfg(all(feature = "png-pdf", target_arch = "wasm32"))]
fn render_bytes_with_warnings_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> chordsketch_chordpro::render_result::RenderResult<Vec<u8>>,
) -> Result<JsValue, JsValue> {
    let (bytes, warnings) = render_bytes_with_warnings_core(input, &opts, render_fn)
        .map_err(|e| JsValue::from_str(&e))?;
    let obj = js_sys::Object::new();
    let arr = js_sys::Uint8Array::from(bytes.as_slice());
    js_sys::Reflect::set(&obj, &JsValue::from_str("output"), &arr.into())?;
    let warnings_js =
        serde_wasm_bindgen::to_value(&warnings).map_err(|e| JsValue::from_str(&e.to_string()))?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("warnings"), &warnings_js)?;
    Ok(obj.into())
}

#[cfg(all(feature = "png-pdf", not(target_arch = "wasm32")))]
fn render_bytes_with_warnings_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> chordsketch_chordpro::render_result::RenderResult<Vec<u8>>,
) -> Result<JsValue, JsValue> {
    // On native test targets, js_sys types are unavailable. Fall back to
    // a serde serialization so the unit tests can at least round-trip
    // the *structure* of the return value (the byte payload lands as a
    // plain array, which is fine for shape-only tests).
    let (bytes, warnings) = render_bytes_with_warnings_core(input, &opts, render_fn)
        .map_err(|e| JsValue::from_str(&e))?;
    #[derive(Serialize)]
    struct BytesWithWarnings {
        output: Vec<u8>,
        warnings: Vec<String>,
    }
    serde_wasm_bindgen::to_value(&BytesWithWarnings {
        output: bytes,
        warnings,
    })
    .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Render ChordPro input as HTML and return `{ output, warnings }`.
///
/// Unlike [`render_html`], this variant captures renderer warnings as
/// structured data instead of forwarding them to `console.warn`.
/// Callers that need warning-driven UI (inline dev banners, telemetry
/// aggregation, selective suppression) should use this entry point.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderHtmlWithWarnings)]
pub fn render_html_with_warnings(input: &str) -> Result<JsValue, JsValue> {
    render_string_with_warnings_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_html::render_songs_with_warnings,
    )
}

/// Render ChordPro input as plain text and return `{ output, warnings }`.
///
/// See [`render_html_with_warnings`] for the warnings contract.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderTextWithWarnings)]
pub fn render_text_with_warnings(input: &str) -> Result<JsValue, JsValue> {
    render_string_with_warnings_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_text::render_songs_with_warnings,
    )
}

/// Render ChordPro input as a PDF byte stream and return
/// `{ output: Uint8Array, warnings: string[] }`.
///
/// See [`render_html_with_warnings`] for the warnings contract.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure.
// `renderPdfWithWarnings` is gated by `png-pdf` —
// only present in the `@chordsketch/wasm-export` build (#2466).
#[cfg(feature = "png-pdf")]
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderPdfWithWarnings)]
pub fn render_pdf_with_warnings(input: &str) -> Result<JsValue, JsValue> {
    render_bytes_with_warnings_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_pdf::render_songs_with_warnings,
    )
}

/// Render ChordPro input as HTML with options and return
/// `{ output, warnings }`.
///
/// Combines the `options` payload of [`render_html_with_options`] with
/// the structured-warning capture of [`render_html_with_warnings`].
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderHtmlWithWarningsAndOptions)]
pub fn render_html_with_warnings_and_options(
    input: &str,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    render_string_with_warnings_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_html::render_songs_with_warnings,
    )
}

/// Render ChordPro input as plain text with options and return
/// `{ output, warnings }`.
///
/// See [`render_html_with_warnings_and_options`] for the contract.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderTextWithWarningsAndOptions)]
pub fn render_text_with_warnings_and_options(
    input: &str,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    render_string_with_warnings_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_text::render_songs_with_warnings,
    )
}

/// Render ChordPro input as a PDF byte stream with options and return
/// `{ output: Uint8Array, warnings: string[] }`.
///
/// See [`render_html_with_warnings_and_options`] for the contract.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
// `renderPdfWithWarningsAndOptions` is gated by `png-pdf` —
// only present in the `@chordsketch/wasm-export` build (#2466).
#[cfg(feature = "png-pdf")]
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderPdfWithWarningsAndOptions)]
pub fn render_pdf_with_warnings_and_options(
    input: &str,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    render_bytes_with_warnings_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_pdf::render_songs_with_warnings,
    )
}

/// Render ChordPro input as a body-only HTML fragment and return
/// `{ output, warnings }`.
///
/// Body-only counterpart to [`render_html_with_warnings`]; returns the
/// `<article class="song">...</article>` markup without `<!DOCTYPE>` /
/// `<html>` / `<head>` / `<style>`. See [`render_html_body`] for the
/// fragment contract and [`render_html_with_warnings`] for the
/// warnings contract.
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderHtmlBodyWithWarnings)]
pub fn render_html_body_with_warnings(input: &str) -> Result<JsValue, JsValue> {
    render_string_with_warnings_inner(
        input,
        RenderOptions::default(),
        chordsketch_render_html::render_songs_body_with_warnings,
    )
}

/// Render ChordPro input as a body-only HTML fragment with options
/// and return `{ output, warnings }`.
///
/// Combines the `options` payload of [`render_html_body_with_options`]
/// with the structured-warning capture of
/// [`render_html_body_with_warnings`].
///
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderHtmlBodyWithWarningsAndOptions)]
pub fn render_html_body_with_warnings_and_options(
    input: &str,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    render_string_with_warnings_inner(
        input,
        deserialize_options(options)?,
        chordsketch_render_html::render_songs_body_with_warnings,
    )
}

/// Returns the ChordSketch library version.
#[must_use]
#[wasm_bindgen]
pub fn version() -> String {
    chordsketch_chordpro::version().to_string()
}

/// Render a chord diagram to SVG for the given chord name and
/// instrument.
///
/// `instrument` accepts (case-insensitive): `"guitar"`, `"ukulele"`
/// (alias `"uke"`), or `"piano"` (aliases `"keyboard"`, `"keys"`).
/// `chord` is a standard ChordPro chord name (e.g. `"Am"`, `"C#m7"`,
/// `"Bb"`). Flat spellings are normalised to sharps via the same
/// path the core crate uses for its built-in voicing database
/// lookup.
///
/// Returns `None` (JavaScript `null`) when the chord or instrument
/// is not known to the built-in voicing database. Hosts typically
/// render a plain-text fallback (`"Chord not found"`) for that
/// case; see the `<ChordDiagram>` component in `@chordsketch/react`
/// for the reference UI.
///
/// Output is inline SVG (`<svg>…</svg>`), suitable for injection
/// into the DOM via `innerHTML` or React's
/// `dangerouslySetInnerHTML`. Viewers that can rasterise SVG
/// (every modern browser) display the diagram directly; consumers
/// that need raster output can pipe the SVG through a library like
/// `resvg` or `canvg`.
///
/// # Errors
///
/// Returns a `JsValue` error string on unknown instrument. Unknown
/// chords are signalled by returning `Option::None`, not an error.
#[must_use = "callers must handle the unknown-instrument error"]
#[wasm_bindgen]
pub fn chord_diagram_svg(chord: &str, instrument: &str) -> Result<Option<String>, JsValue> {
    chord_diagram_svg_inner(chord, instrument, &[]).map_err(|e| JsValue::from_str(&e))
}

/// Variant of [`chord_diagram_svg`] that consults song-level
/// `{define}` directives before falling back to the built-in
/// voicing database.
///
/// `defines` is a JS array of `[name, raw]` tuples, where `name`
/// is the chord identifier (`"Gsus4"`) and `raw` is the
/// space-separated property body the directive carries
/// (`"base-fret 1 frets 3 3 0 0 1 3"`). The React JSX walker
/// emits each `{define: <name> <raw>}` directive into this shape
/// so user-defined chord voicings show up under
/// `<ChordDiagram>` exactly the way they do in the Rust HTML
/// renderer's `<section class="chord-diagrams">` block.
///
/// Mirrors `chordsketch_chordpro::voicings::lookup_diagram`'s
/// "song-level defines take priority" rule. Sister-site to the
/// Rust HTML renderer's `lookup_diagram` call inside
/// `render-html`'s chord-diagrams emission.
///
/// # Errors
///
/// Returns a `JsValue` error string when:
///   * `instrument` is not one of `"guitar"` / `"ukulele"` /
///     `"piano"` (or their aliases).
///   * `defines` is not a deserialisable `[[string, string], …]`
///     array.
#[must_use = "callers must handle the unknown-instrument error"]
#[wasm_bindgen(js_name = chordDiagramSvgWithDefines)]
pub fn chord_diagram_svg_with_defines(
    chord: &str,
    instrument: &str,
    defines: JsValue,
) -> Result<Option<String>, JsValue> {
    let defines_vec: Vec<(String, String)> = if defines.is_undefined() || defines.is_null() {
        Vec::new()
    } else {
        serde_wasm_bindgen::from_value(defines)
            .map_err(|e| JsValue::from_str(&format!("invalid defines argument: {e}")))?
    };
    chord_diagram_svg_inner(chord, instrument, &defines_vec).map_err(|e| JsValue::from_str(&e))
}

/// Variant of [`chord_diagram_svg`] that takes a diagram orientation as
/// an optional string.
///
/// `orientation` accepts `"vertical"` (default) or `"horizontal"`
/// (case-insensitive). Horizontal mode is reader-view only per
/// ADR-0026. `null` / `undefined` / unrecognised values silently fall
/// back to the default, matching `resolve_orientation`.
///
/// # Errors
///
/// Same as [`chord_diagram_svg`].
#[must_use = "callers must handle the unknown-instrument error"]
#[wasm_bindgen(js_name = chordDiagramSvgWithOrientation, skip_typescript)]
pub fn chord_diagram_svg_with_orientation(
    chord: &str,
    instrument: &str,
    orientation: Option<String>,
) -> Result<Option<String>, JsValue> {
    chord_diagram_svg_inner_with_orientation(chord, instrument, &[], orientation.as_deref())
        .map_err(|e| JsValue::from_str(&e))
}

/// Combination of [`chord_diagram_svg_with_defines`] and
/// [`chord_diagram_svg_with_orientation`] — the full surface used by the
/// React JSX walker when a song carries both `{define}` directives and a
/// `{+config.diagrams.orientation}` override.
///
/// # Errors
///
/// Returns a `JsValue` error string when:
///   * `instrument` is not one of `"guitar"` / `"ukulele"` / `"piano"`
///     (or their aliases).
///   * `defines` is not a deserialisable `[[string, string], …]` array.
#[must_use = "callers must handle the unknown-instrument error"]
#[wasm_bindgen(js_name = chordDiagramSvgWithDefinesOrientation, skip_typescript)]
pub fn chord_diagram_svg_with_defines_orientation(
    chord: &str,
    instrument: &str,
    defines: JsValue,
    orientation: Option<String>,
) -> Result<Option<String>, JsValue> {
    let defines_vec: Vec<(String, String)> = if defines.is_undefined() || defines.is_null() {
        Vec::new()
    } else {
        serde_wasm_bindgen::from_value(defines)
            .map_err(|e| JsValue::from_str(&format!("invalid defines argument: {e}")))?
    };
    chord_diagram_svg_inner_with_orientation(
        chord,
        instrument,
        &defines_vec,
        orientation.as_deref(),
    )
    .map_err(|e| JsValue::from_str(&e))
}

/// Compact-size counterpart of [`chord_diagram_svg_with_defines_orientation`]
/// — the chordsketch extension surface used by the React JSX walker when a
/// song carries `{diagrams: inline}` / `{diagrams: hover}`.
///
/// Renders the smaller above-a-lyric layout ([`DiagramSize::Compact`]
/// in the core) while honouring the same `{define}` voicings and
/// orientation knob as the regular export. The compact SVG carries an
/// extra `chord-diagram-compact` (or `keyboard-diagram-compact`) class on
/// its root element.
///
/// # Errors
///
/// Returns a `JsValue` error string when:
///   * `instrument` is not one of `"guitar"` / `"ukulele"` / `"piano"`
///     (or their aliases).
///   * `defines` is not a deserialisable `[[string, string], …]` array.
#[must_use = "callers must handle the unknown-instrument error"]
#[wasm_bindgen(js_name = chordDiagramSvgWithDefinesOrientationCompact, skip_typescript)]
pub fn chord_diagram_svg_with_defines_orientation_compact(
    chord: &str,
    instrument: &str,
    defines: JsValue,
    orientation: Option<String>,
) -> Result<Option<String>, JsValue> {
    let defines_vec: Vec<(String, String)> = if defines.is_undefined() || defines.is_null() {
        Vec::new()
    } else {
        serde_wasm_bindgen::from_value(defines)
            .map_err(|e| JsValue::from_str(&format!("invalid defines argument: {e}")))?
    };
    chord_diagram_svg_inner_with_options(
        chord,
        instrument,
        &defines_vec,
        orientation.as_deref(),
        true,
    )
    .map_err(|e| JsValue::from_str(&e))
}

/// Validate ChordPro input and return any parse errors as structured
/// records.
///
/// Returns a JS array of `{line, column, message}` objects — empty if the
/// input is valid. Matches the NAPI binding's `ValidationError[]` shape
/// (#1990) and the FFI binding's `ValidationError` dictionary (#2009).
///
/// # Errors
///
/// Returns a `JsValue` error string if serialisation fails. In practice,
/// `serde_wasm_bindgen::to_value` only fails on programmer error, so
/// this is a defensive return path — callers can treat it as infallible
/// in normal use.
// Tell wasm-bindgen to skip its auto-generated TypeScript declaration for
// `validate` (which would emit `validate(input: string): any` because the
// Rust signature returns `JsValue`) and inject our own precise one via the
// `typescript_custom_section` block below. See #2018 for the rationale —
// downstream TypeScript consumers of `@chordsketch/wasm` should see the
// same `ValidationError[]` shape the NAPI binding already provides.
#[wasm_bindgen(js_name = validate, skip_typescript)]
pub fn validate(input: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&validate_inner(input))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(typescript_custom_section)]
const VALIDATION_ERROR_TS: &'static str = r#"
/**
 * A single validation issue reported by {@link validate}.
 *
 * Matches the NAPI (`@chordsketch/node`) `ValidationError` interface and the
 * UDL `ValidationError` dictionary exposed by the FFI bindings.
 */
export interface ValidationError {
  /** One-based line number where the issue was detected. */
  line: number;
  /** One-based column number where the issue was detected. */
  column: number;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Validate ChordPro input and return any parse errors as structured records.
 *
 * Returns an empty array if the input is valid.
 */
export function validate(input: string): ValidationError[];

/**
 * Layout orientation for the orientation-aware chord-diagram exports.
 *
 * `"horizontal"` renders the Japanese tablature layout (nut on the left,
 * reader-view — high pitch on top); see ADR-0026. `null` / `undefined` /
 * unrecognised strings fall back to `"vertical"`.
 */
export type ChordDiagramOrientation = "vertical" | "horizontal";

/**
 * Render a chord diagram in the requested orientation.
 *
 * Returns `null` when the chord is not in the built-in voicing database.
 * Throws on unknown instrument.
 */
export function chordDiagramSvgWithOrientation(
  chord: string,
  instrument: string,
  orientation?: ChordDiagramOrientation | null,
): string | null;

/**
 * Render a chord diagram in the requested orientation, consulting song-level
 * `{define}` voicings first. `defines` is an array of `[name, raw]` tuples.
 */
export function chordDiagramSvgWithDefinesOrientation(
  chord: string,
  instrument: string,
  defines: Array<[string, string]>,
  orientation?: ChordDiagramOrientation | null,
): string | null;

/**
 * Compact-size variant of {@link chordDiagramSvgWithDefinesOrientation} — a
 * chordsketch extension for diagrams shown directly above a lyric line (the
 * `{diagrams: inline}` / `{diagrams: hover}` modes). The geometry is smaller
 * but the chord-name title and finger glyphs stay legible (not a CSS scale).
 * The returned SVG carries an extra `chord-diagram-compact` (fretted) or
 * `keyboard-diagram-compact` (piano) class on its root element.
 *
 * Returns `null` when the chord is not in the built-in voicing database.
 * Throws on unknown instrument.
 */
export function chordDiagramSvgWithDefinesOrientationCompact(
  chord: string,
  instrument: string,
  defines: Array<[string, string]>,
  orientation?: ChordDiagramOrientation | null,
): string | null;
"#;

/// Serializable shape returned by [`parse_chordpro_with_warnings`]
/// and [`parse_chordpro_with_warnings_and_options`].
///
/// Mirrors the `ConversionWithWarnings` shape used by the
/// `convertChordpro*` exports so the React surface can plumb
/// warnings through a uniform `{ ast, warnings }` channel
/// regardless of which wasm function it called. `ast` carries the
/// JSON document produced by [`crate::do_parse_chordpro`];
/// `warnings` is the list of recoverable `ParseError` messages the
/// lenient parser surfaced (each formatted via the `Display` impl).
#[derive(Debug, Serialize)]
struct ParseChordproResult {
    ast: String,
    warnings: Vec<String>,
    /// Transposed `{key}` directive value, present only when
    /// `transpose != 0` AND the source carried a `{key}` directive
    /// whose value parses as a chord (`Chord::detail.is_some()`).
    /// `null` otherwise — the React surface should fall back to
    /// rendering only the original key string in that case. See
    /// `do_parse_chordpro` for the source-of-truth computation.
    #[serde(rename = "transposedKey", skip_serializing_if = "Option::is_none")]
    transposed_key: Option<String>,
    /// Map of `original {key:} directive value → transposed
    /// value`, covering every `{key:}` directive in the song
    /// (primary + mid-song). Present only when `transpose != 0`
    /// AND at least one `{key:}` value parsed as a chord.
    ///
    /// Lets the React JSX walker render mid-song `{key:}` chips
    /// with the canonically-transposed value too — without this
    /// channel the walker only knew the song-primary's
    /// transposition and fell back to the authored value for
    /// every other directive, diverging from the Rust text /
    /// HTML / PDF renderers (#2525).
    ///
    /// Entries where transpose is a no-op (e.g. modal `{key: C
    /// dorian}` values that don't parse) are intentionally
    /// omitted so the walker can treat presence-in-map as
    /// "show the pair".
    #[serde(
        rename = "transposedKeyDirectives",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    transposed_key_directives: std::collections::BTreeMap<String, String>,
}

/// Parse a ChordPro source string into an AST JSON document.
///
/// Returns the parsed [`chordsketch_chordpro::ast::Song`] as a
/// JSON object matching the shape declared in
/// `packages/react/src/chordpro-ast.ts`. Recoverable parse issues
/// are surfaced through the lenient parser's warnings channel and
/// drop on the floor at this entry point; a structured
/// `withWarnings` variant is tracked as a follow-up and not part
/// of this PR.
///
/// # Errors
///
/// Returns a `JsValue` error string when the parser cannot start
/// (e.g., input exceeds the lenient parser's hard preconditions).
#[must_use = "callers must handle parse errors"]
#[wasm_bindgen(js_name = parseChordpro)]
pub fn parse_chordpro(input: &str) -> Result<String, JsValue> {
    do_parse_chordpro(input, None)
        .map(|(json, _, _, _)| json)
        .map_err(|e| JsValue::from_str(&e))
}

/// Parse a ChordPro source string with optional render options
/// (transpose, config preset). Same JSON shape as
/// [`parse_chordpro`]; this entry point mirrors the
/// `*_with_options` pattern used by the renderer bindings so the
/// React preview can drive transpose without re-rendering through
/// the demoted Rust HTML renderer.
#[must_use = "callers must handle parse errors"]
#[wasm_bindgen(js_name = parseChordproWithOptions)]
pub fn parse_chordpro_with_options(input: &str, options: JsValue) -> Result<String, JsValue> {
    let opts = deserialize_options(options)?;
    do_parse_chordpro(input, Some(&opts))
        .map(|(json, _, _, _)| json)
        .map_err(|e| JsValue::from_str(&e))
}

/// `parse_chordpro` with the lenient parser's recovered
/// `ParseError`s plumbed through as `warnings: string[]`.
///
/// Closes the silent-failure gap surfaced by the auto-review on
/// PR #2455 — `parse_chordpro` itself drops the warnings tuple
/// element on the floor (`.map(|(json, _)| json)`) so the
/// information is unavailable to the React preview, hiding
/// recoverable parse issues from the user. This entry point is
/// the canonical surface for the React hook
/// (`useChordproAst`); the no-warnings entry points stay around
/// for callers that genuinely don't care.
///
/// # Errors
///
/// Same as [`parse_chordpro`] — only hard preconditions fail.
#[must_use = "callers must handle parse errors"]
#[wasm_bindgen(js_name = parseChordproWithWarnings)]
pub fn parse_chordpro_with_warnings(input: &str) -> Result<JsValue, JsValue> {
    let (ast, warnings, transposed_key, transposed_key_directives) =
        do_parse_chordpro(input, None).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&ParseChordproResult {
        ast,
        warnings,
        transposed_key,
        transposed_key_directives,
    })
    .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Same as [`parse_chordpro_with_warnings`] but threads the
/// `RenderOptions` payload (transpose / config) so the React
/// preview can drive transpose without losing the warnings
/// channel.
#[must_use = "callers must handle parse errors"]
#[wasm_bindgen(js_name = parseChordproWithWarningsAndOptions)]
pub fn parse_chordpro_with_warnings_and_options(
    input: &str,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    let opts = deserialize_options(options)?;
    let (ast, warnings, transposed_key, transposed_key_directives) =
        do_parse_chordpro(input, Some(&opts)).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&ParseChordproResult {
        ast,
        warnings,
        transposed_key,
        transposed_key_directives,
    })
    .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Convert a ChordPro source string into an `irealb://` URL
/// (#2067 Phase 1).
///
/// Lossy: lyrics, fonts / colours, and capo are dropped (iReal has
/// no surface for them). Each drop appears in the returned
/// `warnings` list.
///
/// # Errors
///
/// Returns a `JsValue` error string when the converter rejects the
/// source as unrepresentable in iReal.
#[must_use = "callers must handle conversion errors"]
#[wasm_bindgen(js_name = convertChordproToIrealb)]
pub fn convert_chordpro_to_irealb(input: &str) -> Result<JsValue, JsValue> {
    let payload = do_convert_chordpro_to_irealb(input).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
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
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload.
#[must_use = "callers must handle conversion errors"]
#[wasm_bindgen(js_name = convertIrealbToChordproText)]
pub fn convert_irealb_to_chordpro_text(input: &str) -> Result<JsValue, JsValue> {
    let payload = do_convert_irealb_to_chordpro_text(input).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
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
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload.
#[must_use = "callers must handle conversion errors"]
#[wasm_bindgen(js_name = renderIrealSvg)]
pub fn render_ireal_svg(input: &str) -> Result<String, JsValue> {
    do_render_ireal_svg(input).map_err(|e| JsValue::from_str(&e))
}

/// Parse an `irealb://` URL into an AST-shaped JSON string
/// (#2067 Phase 2b).
///
/// Returns the song as a JSON object whose shape mirrors
/// [`chordsketch_ireal::IrealSong`]. The format is the
/// AST wire format and follows the AST's stability promise:
/// new optional fields may appear in minor releases; renames or
/// removals require a major bump. Pair with [`serialize_irealb`]
/// for the inverse direction.
///
/// # Errors
///
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload.
#[must_use = "callers must handle parse errors"]
#[wasm_bindgen(js_name = parseIrealb)]
pub fn parse_irealb(input: &str) -> Result<String, JsValue> {
    do_parse_irealb(input).map_err(|e| JsValue::from_str(&e))
}

/// Serialize an AST-shaped JSON string into an `irealb://` URL
/// (#2067 Phase 2b).
///
/// The input must match the JSON shape produced by [`parse_irealb`].
/// Round-trip identity is guaranteed for any JSON that came out of
/// `parse_irealb` on the same library version.
///
/// # Errors
///
/// Returns a `JsValue` error string when the input is not valid JSON
/// or does not match the AST shape (e.g. missing required fields,
/// out-of-range values).
#[must_use = "callers must handle serialization errors"]
#[wasm_bindgen(js_name = serializeIrealb)]
pub fn serialize_irealb(input: &str) -> Result<String, JsValue> {
    do_serialize_irealb(input).map_err(|e| JsValue::from_str(&e))
}

/// Wasm-exposed wrapper around the pure-Rust `do_chord_typography`
/// helper in `lib.rs`. See [`renderIrealSvg`](render_ireal_svg)'s
/// span-layout surface for the typography-span vocabulary the JSON
/// output uses.
///
/// # Errors
///
/// Returns a `JsValue` error string when `chord_json` is not valid
/// AST-shaped JSON.
#[must_use = "callers must handle JSON-shape errors"]
#[wasm_bindgen(js_name = chordTypography)]
pub fn chord_typography(chord_json: &str) -> Result<String, JsValue> {
    do_chord_typography(chord_json).map_err(|e| JsValue::from_str(&e))
}

/// Render an `irealb://` URL as an iReal Pro-style PNG image
/// (#2067 Phase 2c).
///
/// Pipeline: `chordsketch_ireal::parse` →
/// `chordsketch_render_ireal::png::render_png` with default
/// `PngOptions` (300 DPI, A4-equivalent canvas). Returned as a
/// `Uint8Array` of the encoded PNG bytes.
///
/// Only available with the `png-pdf` feature
/// (`@chordsketch/wasm-export`, #2466).
///
/// # Errors
///
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload, or when the underlying rasteriser fails
/// (e.g. internal SVG parse error).
#[cfg(feature = "png-pdf")]
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderIrealPng)]
pub fn render_ireal_png(input: &str) -> Result<Vec<u8>, JsValue> {
    do_render_ireal_png(input).map_err(|e| JsValue::from_str(&e))
}

/// Render an `irealb://` URL as a single-page A4 PDF document
/// (#2067 Phase 2c).
///
/// Pipeline: `chordsketch_ireal::parse` →
/// `chordsketch_render_ireal::pdf::render_pdf` with default
/// `PdfOptions`. Returned as a `Uint8Array` of the PDF byte stream.
///
/// Only available with the `png-pdf` feature
/// (`@chordsketch/wasm-export`, #2466).
///
/// # Errors
///
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload, or when the underlying converter fails.
#[cfg(feature = "png-pdf")]
#[must_use = "callers must handle render errors"]
#[wasm_bindgen(js_name = renderIrealPdf)]
pub fn render_ireal_pdf(input: &str) -> Result<Vec<u8>, JsValue> {
    do_render_ireal_pdf(input).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(typescript_custom_section)]
const RENDER_IREAL_SVG_TS: &'static str = r#"
/**
 * Render an `irealb://` URL as an iReal Pro-style SVG chart
 * (#2067 Phase 2a).
 *
 * Output is a complete, self-contained `<svg>` document.
 *
 * @throws when the input is not a valid `irealb://` payload.
 */
export function renderIrealSvg(input: string): string;
"#;

// The `renderIrealPng` / `renderIrealPdf` TypeScript declarations
// only appear in the heavy bundle (`@chordsketch/wasm-export`)
// per #2466 — they reference exports that are themselves gated
// by `cfg(feature = "png-pdf")` above, so emitting the TS shape
// from the lean build would publish a typed API that does not
// exist at runtime.
#[cfg(feature = "png-pdf")]
#[wasm_bindgen(typescript_custom_section)]
const RENDER_IREAL_PNG_PDF_TS: &'static str = r#"
/**
 * Render an `irealb://` URL as a PNG image (#2067 Phase 2c).
 *
 * Pipeline: parse → SVG render → resvg rasterise. Output is the
 * encoded PNG byte stream at the renderer's default 300 DPI.
 *
 * @throws when the input is not a valid `irealb://` payload, or when
 *         the underlying rasteriser fails.
 */
export function renderIrealPng(input: string): Uint8Array;

/**
 * Render an `irealb://` URL as a single-page A4 PDF document
 * (#2067 Phase 2c).
 *
 * Pipeline: parse → SVG render → svg2pdf conversion. Output is the
 * PDF byte stream; vector content scales without resolution loss.
 *
 * @throws when the input is not a valid `irealb://` payload, or when
 *         the underlying converter fails.
 */
export function renderIrealPdf(input: string): Uint8Array;
"#;

#[wasm_bindgen(typescript_custom_section)]
const PARSE_SERIALIZE_IREALB_TS: &'static str = r#"
/**
 * Parse an `irealb://` URL into an AST-shaped JSON string
 * (#2067 Phase 2b).
 *
 * The returned JSON mirrors the `IrealSong` AST in
 * `chordsketch-ireal`. Pair with {@link serializeIrealb} for the
 * inverse direction. Field additions are non-breaking; field
 * removals or renames require a major version bump.
 *
 * @throws when the input is not a valid `irealb://` payload.
 */
export function parseIrealb(input: string): string;

/**
 * Serialize an AST-shaped JSON string into an `irealb://` URL
 * (#2067 Phase 2b).
 *
 * The input must match the JSON shape produced by
 * {@link parseIrealb}. Round-trips are stable for any JSON
 * `parseIrealb` produced on the same library version.
 *
 * @throws when the input is not valid JSON or does not match the
 *         AST shape.
 */
export function serializeIrealb(input: string): string;
"#;

#[wasm_bindgen(typescript_custom_section)]
const CONVERSION_WITH_WARNINGS_TS: &'static str = r#"
/**
 * Result returned by {@link convertChordproToIrealb} and
 * {@link convertIrealbToChordproText} (#2067 Phase 1).
 *
 * `output` is the converted string (an `irealb://` URL or rendered
 * ChordPro text, depending on direction). `warnings` is a list of
 * `"<kind>: <message>"` diagnostic strings describing information
 * that was dropped or approximated during the conversion.
 *
 * Matches the NAPI `ConversionWithWarnings` interface and the FFI
 * `ConversionWithWarnings` dictionary.
 */
export interface ConversionWithWarnings {
  /** Converted output string. */
  output: string;
  /** Conversion warnings (lossy drops, approximations, unsupported). */
  warnings: string[];
}

/**
 * Convert a ChordPro source string into an `irealb://` URL.
 *
 * Lossy: lyrics, fonts / colours, capo are dropped because iReal
 * has no surface for them. Every drop surfaces in
 * {@link ConversionWithWarnings.warnings}.
 *
 * @throws when the converter rejects the source as unrepresentable
 *         in iReal.
 */
export function convertChordproToIrealb(input: string): ConversionWithWarnings;

/**
 * Convert an `irealb://` URL into rendered ChordPro text.
 *
 * The output is the `chordsketch-render-text` rendering of the
 * converted song, not raw ChordPro source.
 *
 * @throws when the input is not a valid `irealb://` payload.
 */
export function convertIrealbToChordproText(input: string): ConversionWithWarnings;
"#;
