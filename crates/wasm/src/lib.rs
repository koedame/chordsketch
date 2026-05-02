//! WebAssembly bindings for ChordSketch.
//!
//! Exposes ChordPro parsing and rendering (HTML, plain text, PDF) to
//! JavaScript/TypeScript via `wasm-bindgen`.

use chordsketch_chordpro::render_result::RenderResult;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Set up the panic hook on module instantiation so any unexpected panic
/// in the renderer surfaces in the JavaScript console with a Rust
/// backtrace instead of an opaque `unreachable executed`. See #1052.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// JS `console.warn` binding, used to surface render warnings (transpose
/// saturation, chorus recall limits, deny-listed metadata overrides) to
/// developers in the browser console.
///
/// On wasm32 this resolves to the global `console.warn`. On native test
/// targets it's a no-op so the unit tests in this file (which run with
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
    fn console_warn(s: &str);
}

#[cfg(not(target_arch = "wasm32"))]
fn console_warn(_s: &str) {}

/// Render options passed from JavaScript.
#[derive(Deserialize, Default)]
struct RenderOptions {
    /// Semitone transposition offset. Any `i8` value is accepted; the
    /// renderer reduces modulo 12 internally. (Aligning with the CLI,
    /// UniFFI bindings, and napi-rs binding behavior — see #1053, #1065.)
    #[serde(default)]
    transpose: i8,
    /// Configuration preset name (e.g., "guitar", "ukulele") or inline
    /// RRJSON configuration string.
    #[serde(default)]
    config: Option<String>,
}

/// Resolve a [`chordsketch_chordpro::config::Config`] from the options.
///
/// Pure-Rust core: returns a plain `String` error so unit tests can
/// drive every config-parse branch without constructing a `JsValue`
/// (which on native test targets panics on any wasm-bindgen-imported
/// method call). The wasm-bindgen call sites convert via
/// [`resolve_config`].
///
/// Sister-site note: the napi binding's equivalent helper takes
/// `Option<&str>` because its caller (`resolve_options_inner`) also
/// dispatches `try_parse_transpose` against the same options struct.
/// Wasm's `RenderOptions.transpose` is already an `i8` (validated by
/// `serde_wasm_bindgen` at deserialise time), so this helper only
/// owns the config-parse branch and takes `&RenderOptions` directly
/// to match the call sites that already hold a borrowed options
/// reference. The semantic contract — return `String` error for the
/// "not a preset and not valid RRJSON" case — is identical across
/// both bindings.
fn resolve_config_inner(
    opts: &RenderOptions,
) -> std::result::Result<chordsketch_chordpro::config::Config, String> {
    match &opts.config {
        Some(name) => {
            // Try as a preset first, then as inline RRJSON.
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

/// `JsValue`-error wrapper around [`resolve_config_inner`]. The single
/// source of truth for the `String` → `JsValue` mapping done by every
/// wasm-bindgen entry point.
fn resolve_config(opts: &RenderOptions) -> Result<chordsketch_chordpro::config::Config, JsValue> {
    resolve_config_inner(opts).map_err(|e| JsValue::from_str(&e))
}

/// Forward each warning in a [`RenderResult`] to `console.warn` and
/// unwrap the output. Single source of truth for the warning side
/// effect, called by both [`do_render_string`] and [`do_render_bytes`].
/// See #1109.
fn flush_warnings<T>(result: RenderResult<T>) -> T {
    for w in &result.warnings {
        console_warn(&format!("chordsketch: {w}"));
    }
    result.output
}

/// Parse input and render songs.
///
/// Calls the renderer's `*_with_warnings` variant and forwards each
/// captured warning to `console.warn` (#1051) before returning the
/// rendered string.
///
/// `parse_multi_lenient` always returns at least one `ParseResult`
/// (`split_at_new_song` unconditionally pushes the trailing segment, even
/// for empty input — see `chordsketch_chordpro::parser`), so the resulting
/// `Vec<Song>` is never empty and the previous `is_empty()` guard was
/// dead code (#1083). The return type stays `Result` because
/// `render_html_with_options` and friends use the same `JsValue` error
/// channel for their config-parse failures.
fn do_render_string(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<String>,
) -> Result<String, JsValue> {
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    Ok(flush_warnings(render_fn(&songs, transpose, config)))
}

/// Parse input and render songs, returning a `Vec<u8>` result.
///
/// See [`do_render_string`] for the note on console-routed warnings and
/// the lenient parser always producing at least one song.
fn do_render_bytes(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
) -> Result<Vec<u8>, JsValue> {
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    Ok(flush_warnings(render_fn(&songs, transpose, config)))
}

/// Decode a JS-supplied `options` value into a `RenderOptions` struct.
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
    ) -> RenderResult<String>,
) -> Result<String, JsValue> {
    let config = resolve_config(&opts)?;
    do_render_string(input, &config, opts.transpose, render_fn)
}

/// Resolve config and dispatch a bytes-returning render call.
///
/// See [`render_string_inner`].
fn render_bytes_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
) -> Result<Vec<u8>, JsValue> {
    let config = resolve_config(&opts)?;
    do_render_bytes(input, &config, opts.transpose, render_fn)
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
/// # Errors
///
/// Returns a `JsValue` error string on parse failure or invalid options.
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
/// `<div class="song">...</div>` markup — no `<!DOCTYPE>`, `<html>`,
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

/// Pure-Rust core for the `*_with_warnings` family: parse + render +
/// capture warnings, returning `(output, warnings)`. Unit-testable
/// without touching the wasm-bindgen serialisation boundary.
fn render_string_with_warnings_core(
    input: &str,
    opts: &RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<String>,
) -> std::result::Result<(String, Vec<String>), String> {
    let config = resolve_config_inner(opts)?;
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    let result = render_fn(&songs, opts.transpose, &config);
    Ok((result.output, result.warnings))
}

/// String-returning render that captures warnings instead of
/// forwarding them to `console.warn`.
///
/// Accepts `RenderOptions` so the same inner routine serves both the
/// no-options `render_*_with_warnings` family (which passes
/// `RenderOptions::default()`) and the `render_*_with_warnings_and_options`
/// family introduced in #1895. Config resolution is shared with
/// `render_string_inner` via [`resolve_config`]. Wasm-bindgen wrapper
/// over [`render_string_with_warnings_core`] — the wrapper exists
/// solely to pack `(output, warnings)` into a `JsValue` via
/// `serde_wasm_bindgen::to_value`, which can only be called on a
/// wasm32 target / under `wasm-pack test --node`.
fn render_string_with_warnings_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<String>,
) -> Result<JsValue, JsValue> {
    let (output, warnings) = render_string_with_warnings_core(input, &opts, render_fn)
        .map_err(|e| JsValue::from_str(&e))?;
    let payload = StringWithWarnings { output, warnings };
    serde_wasm_bindgen::to_value(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Pure-Rust core for the bytes-returning `*_with_warnings` family.
/// See [`render_string_with_warnings_core`] for the rationale.
fn render_bytes_with_warnings_core(
    input: &str,
    opts: &RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
) -> std::result::Result<(Vec<u8>, Vec<String>), String> {
    let config = resolve_config_inner(opts)?;
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    let result = render_fn(&songs, opts.transpose, &config);
    Ok((result.output, result.warnings))
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
#[cfg(target_arch = "wasm32")]
fn render_bytes_with_warnings_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
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

#[cfg(not(target_arch = "wasm32"))]
fn render_bytes_with_warnings_inner(
    input: &str,
    opts: RenderOptions,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
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
/// `<div class="song">...</div>` markup without `<!DOCTYPE>` /
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
    use chordsketch_chordpro::chord_diagram::{render_keyboard_svg, render_svg};
    use chordsketch_chordpro::voicings::{lookup_diagram, lookup_keyboard_voicing};

    match instrument.to_ascii_lowercase().as_str() {
        "piano" | "keyboard" | "keys" => {
            Ok(lookup_keyboard_voicing(chord, &[]).map(|v| render_keyboard_svg(&v)))
        }
        "guitar" | "ukulele" | "uke" => {
            // `frets_shown = 5` matches the default ChordPro HTML
            // renderer (`crates/render-html` emits 5-fret diagrams
            // when no `{chordfrets}` directive is set) so diagrams
            // produced by `<ChordDiagram>` visually match the
            // sheet output from `<ChordSheet>` for the same chord.
            Ok(lookup_diagram(chord, &[], instrument, 5).map(|d| render_svg(&d)))
        }
        other => Err(JsValue::from_str(&format!(
            "unknown instrument {other:?}; expected one of \"guitar\", \"ukulele\", \"piano\""
        ))),
    }
}

/// A single validation issue reported by [`validate`].
///
/// Serialised to a plain JS `{line, column, message}` object via
/// `serde_wasm_bindgen`. Matches the NAPI / FFI `ValidationError`
/// declarations after #2009. Line and column are one-based (editor
/// diagnostic convention).
#[derive(Serialize)]
struct ValidationErrorPayload {
    line: u32,
    column: u32,
    message: String,
}

/// Shared inner helper used by both the wasm-bindgen wrapper and native
/// unit tests. Keeping this free of any wasm-bindgen imports means
/// `cargo test -p chordsketch-wasm` runs without hitting the "cannot
/// call wasm-bindgen imported functions on non-wasm targets" panic that
/// `serde_wasm_bindgen::to_value` triggers off-target.
fn validate_inner(input: &str) -> Vec<ValidationErrorPayload> {
    let result = chordsketch_chordpro::parse_multi_lenient(input);
    result
        .results
        .into_iter()
        .flat_map(|r| r.errors.into_iter())
        .map(|e| ValidationErrorPayload {
            line: u32::try_from(e.line()).unwrap_or(u32::MAX),
            column: u32::try_from(e.column()).unwrap_or(u32::MAX),
            message: e.message,
        })
        .collect()
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
"#;

// ---- iReal Pro conversion bindings (#2067 Phase 1) ----

/// Serializable shape returned by both conversion entry points.
///
/// Mirrors the NAPI `ConversionWithWarnings` and the UDL
/// `ConversionWithWarnings` dictionary so every binding presents
/// the same surface — `output` is the converted string, `warnings`
/// is a list of `"<kind>: <message>"` diagnostic strings.
///
/// `Debug` is required for the `{result:?}` formatter used by the
/// `assert!` calls in the unit tests below.
#[derive(Debug, Serialize)]
struct ConversionWithWarnings {
    output: String,
    warnings: Vec<String>,
}

/// Format a [`chordsketch_convert::ConversionWarning`] as a stable
/// `"<kind>: <message>"` string. Mirror of NAPI / FFI's helper.
fn format_conversion_warning(w: &chordsketch_convert::ConversionWarning) -> String {
    let kind = match w.kind {
        chordsketch_convert::WarningKind::LossyDrop => "lossy-drop",
        chordsketch_convert::WarningKind::Approximated => "approximated",
        chordsketch_convert::WarningKind::Unsupported => "unsupported",
        // `WarningKind` is `#[non_exhaustive]`; falling back to a
        // generic tag here keeps the binding compiling against a
        // future variant. Sister bindings do the same.
        _ => "warning",
    };
    format!("{kind}: {}", w.message)
}

/// Run the ChordPro → iReal pipeline; native-test helper used by
/// the wasm wrapper and by Rust unit tests in this file.
fn do_convert_chordpro_to_irealb(input: &str) -> Result<ConversionWithWarnings, String> {
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
    Ok(ConversionWithWarnings {
        output: url,
        warnings: converted
            .warnings
            .iter()
            .map(format_conversion_warning)
            .collect(),
    })
}

/// Run the iReal → ChordPro pipeline; native-test helper used by
/// the wasm wrapper and by Rust unit tests.
fn do_convert_irealb_to_chordpro_text(input: &str) -> Result<ConversionWithWarnings, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    let converted = chordsketch_convert::ireal_to_chordpro(&ireal)
        .map_err(|e| format!("conversion failed: {e}"))?;
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

/// Run the iReal SVG-render pipeline; native helper used by the
/// wasm wrapper and the unit tests.
fn do_render_ireal_svg(input: &str) -> Result<String, String> {
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
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload.
#[must_use = "callers must handle conversion errors"]
#[wasm_bindgen(js_name = renderIrealSvg)]
pub fn render_ireal_svg(input: &str) -> Result<String, JsValue> {
    do_render_ireal_svg(input).map_err(|e| JsValue::from_str(&e))
}

/// Run the iReal URL → AST JSON pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
fn do_parse_irealb(input: &str) -> Result<String, String> {
    use chordsketch_ireal::ToJson;
    let song = chordsketch_ireal::parse(input).map_err(|e| format!("parse failed: {e}"))?;
    Ok(song.to_json_string())
}

/// Run the AST JSON → iReal URL pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
fn do_serialize_irealb(input: &str) -> Result<String, String> {
    use chordsketch_ireal::FromJson;
    let song = chordsketch_ireal::IrealSong::from_json_str(input)
        .map_err(|e| format!("invalid AST JSON: {e}"))?;
    Ok(chordsketch_ireal::irealb_serialize(&song))
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

/// Run the iReal PNG-rasterise pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
fn do_render_ireal_png(input: &str) -> Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::png::render_png(
        &ireal,
        &chordsketch_render_ireal::png::PngOptions::default(),
    )
    .map_err(|e| format!("PNG render failed: {e}"))
}

/// Run the iReal PDF-render pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
fn do_render_ireal_pdf(input: &str) -> Result<Vec<u8>, String> {
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
/// `PngOptions` (300 DPI, A4-equivalent canvas). Returned as a
/// `Uint8Array` of the encoded PNG bytes.
///
/// # Errors
///
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload, or when the underlying rasteriser fails
/// (e.g. internal SVG parse error).
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
/// # Errors
///
/// Returns a `JsValue` error string when the URL is not a valid
/// `irealb://` payload, or when the underlying converter fails.
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

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_INPUT: &str = "{title: Test}\n[C]Hello";

    #[test]
    fn test_render_html_returns_content() {
        let result = render_html(MINIMAL_INPUT);
        assert!(result.is_ok());
        let html = result.unwrap();
        assert!(!html.is_empty());
        assert!(html.contains("Test"));
    }

    #[test]
    fn test_render_text_returns_content() {
        let result = render_text(MINIMAL_INPUT);
        assert!(result.is_ok());
        let text = result.unwrap();
        assert!(!text.is_empty());
        assert!(text.contains("Test"));
    }

    #[test]
    fn test_render_pdf_returns_bytes() {
        let result = render_pdf(MINIMAL_INPUT);
        assert!(result.is_ok());
        let bytes = result.unwrap();
        assert!(!bytes.is_empty());
        // PDF files start with %PDF
        assert!(bytes.starts_with(b"%PDF"));
    }

    #[test]
    fn test_empty_input_returns_ok() {
        // Lenient parser produces an empty song even for blank input.
        let result = render_html("");
        assert!(result.is_ok());
    }

    #[test]
    fn test_render_html_body_omits_document_envelope() {
        let body = render_html_body(MINIMAL_INPUT).unwrap();
        // Body-only contract — none of the document-level wrappers
        // emitted by `render_html` may appear here.
        assert!(!body.contains("<!DOCTYPE"));
        assert!(!body.contains("<html"));
        assert!(!body.contains("</html>"));
        assert!(!body.contains("<head"));
        assert!(!body.contains("<style"));
        assert!(!body.contains("<title>"));
        // The song markup itself must still be present.
        assert!(body.contains("<div class=\"song\">"));
    }

    #[test]
    fn test_render_html_css_returns_canonical_block() {
        let css = render_html_css();
        // Pin the load-bearing selectors that make the
        // chord-over-lyrics layout work.
        assert!(css.contains(".chord-block"));
        assert!(css.contains(".lyrics"));
        // The full-document renderer embeds *exactly* this string —
        // assert lockstep so future divergence between the WASM
        // export and the embedded copy is caught immediately.
        let full = render_html(MINIMAL_INPUT).unwrap();
        assert!(full.contains(&css));
    }

    #[test]
    fn test_version_returns_string() {
        let v = version();
        assert!(!v.is_empty());
    }

    // The following tests cover the chordsketch-chordpro APIs that
    // `resolve_config` delegates to (Config::preset and Config::parse).
    // They do NOT exercise resolve_config itself or the JsValue boundary —
    // for that, see the `wasm_tests` module below (gated to wasm32 and
    // run via `wasm-pack test --node` in CI).

    #[test]
    fn config_parse_invalid_rrjson_returns_err() {
        let result = chordsketch_chordpro::config::Config::parse("{ invalid rrjson !!!");
        assert!(result.is_err(), "invalid RRJSON should fail to parse");
    }

    #[test]
    fn config_preset_known_and_unknown_names() {
        assert!(
            chordsketch_chordpro::config::Config::preset("guitar").is_some(),
            "guitar preset should exist"
        );
        assert!(
            chordsketch_chordpro::config::Config::preset("nonexistent").is_none(),
            "unknown preset should return None"
        );
    }

    #[test]
    fn config_parse_valid_rrjson_returns_ok() {
        let result =
            chordsketch_chordpro::config::Config::parse(r#"{ "settings": { "transpose": 2 } }"#);
        assert!(result.is_ok(), "valid RRJSON should parse successfully");
    }

    // Native tests exercise `validate_inner` directly rather than the
    // wasm-bindgen wrapper, because `serde_wasm_bindgen::to_value` calls
    // imported JS machinery that does not exist on non-wasm targets.
    // The wasm-side serialisation and JS-observable shape are covered by
    // the `wasm_tests` module below (run via `wasm-pack test --node`).

    #[test]
    fn test_validate_returns_empty_for_valid_input() {
        let errors = validate_inner(MINIMAL_INPUT);
        assert!(errors.is_empty(), "valid input should produce no errors");
    }

    #[test]
    fn test_validate_returns_errors_for_bad_input() {
        let errors = validate_inner("{title: Test}\n[G");
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
    fn test_validate_returns_empty_for_empty_input() {
        let errors = validate_inner("");
        assert!(errors.is_empty(), "empty input should produce no errors");
    }

    // -- *_with_warnings captures structured output (#1827) ----------------
    //
    // The `#[wasm_bindgen]` wrappers `render_*_with_warnings` call
    // `serde_wasm_bindgen::to_value`, which is a wasm-bindgen-imported
    // function and panics on native test targets. Tests therefore
    // exercise the underlying core renderer directly — the same code
    // path that the wrapper wraps — which is sufficient to guard the
    // structural contract (output + warnings are captured, not
    // discarded). Integration of the serde boundary is covered by the
    // wasm-bindgen-test module below and by the npm package's Jest
    // suite.

    #[test]
    fn test_with_warnings_core_renderers_return_output_and_empty_warnings_on_clean_input() {
        let parse = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let songs: Vec<_> = parse.results.into_iter().map(|r| r.song).collect();
        let text = chordsketch_render_text::render_songs_with_warnings(
            &songs,
            0,
            &chordsketch_chordpro::config::Config::defaults(),
        );
        assert!(!text.output.is_empty());
        assert!(text.warnings.is_empty());
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

    // ---- iReal Pro conversion bindings (#2067 Phase 1) ----

    /// Reused tiny `irealb://` fixture from
    /// `chordsketch-convert/tests/from_ireal.rs`.
    const TINY_IREAL_URL: &str = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

    #[test]
    fn test_convert_chordpro_to_irealb_helper() {
        // `do_convert_chordpro_to_irealb` is a native helper that does not
        // call any wasm-bindgen imports, so it can run under `cargo test`.
        // The actual `#[wasm_bindgen]` wrapper is exercised by `wasm-pack
        // test --node` via the `wasm_tests` module below.
        let payload = do_convert_chordpro_to_irealb(MINIMAL_INPUT).unwrap();
        assert!(
            payload.output.starts_with("irealb://"),
            "expected irealb:// URL, got: {}",
            payload.output
        );
    }

    #[test]
    fn test_convert_chordpro_to_irealb_empty_input_succeeds() {
        // Edge case: empty input. The lenient parser always returns at
        // least one segment, so conversion must succeed (empty IrealSong).
        let payload = do_convert_chordpro_to_irealb("").unwrap();
        assert!(payload.output.starts_with("irealb://"));
    }

    #[test]
    fn test_convert_irealb_to_chordpro_text_helper() {
        let payload = do_convert_irealb_to_chordpro_text(TINY_IREAL_URL).unwrap();
        assert!(
            !payload.output.is_empty(),
            "rendered text must not be empty"
        );
        assert!(
            payload.output.contains('|'),
            "rendered text must preserve bar boundaries; got: {}",
            payload.output
        );
    }

    #[test]
    fn test_convert_irealb_to_chordpro_text_invalid_url_errors() {
        let result = do_convert_irealb_to_chordpro_text("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- iReal Pro SVG render (#2067 Phase 2a) ----

    #[test]
    fn test_render_ireal_svg_emits_svg_document() {
        let svg = do_render_ireal_svg(TINY_IREAL_URL).unwrap();
        assert!(
            svg.contains("<svg"),
            "expected SVG document, got: {}",
            &svg[..svg.len().min(200)]
        );
    }

    #[test]
    fn test_render_ireal_svg_invalid_url_errors() {
        let result = do_render_ireal_svg("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- iReal Pro AST round-trip (#2067 Phase 2b) ----

    #[test]
    fn test_parse_irealb_emits_ast_json() {
        let json = do_parse_irealb(TINY_IREAL_URL).unwrap();
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
        let result = do_parse_irealb("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_serialize_irealb_round_trip() {
        // parse → serialize → parse must yield byte-equal JSON. The
        // first → JSON edge is `chordsketch_ireal::ToJson`; the JSON
        // → URL → JSON loop pins the wire-format contract advertised
        // in the public docstring.
        let json1 = do_parse_irealb(TINY_IREAL_URL).unwrap();
        let url2 = do_serialize_irealb(&json1).unwrap();
        assert!(
            url2.starts_with("irealb://"),
            "expected irealb:// URL, got: {url2}"
        );
        let json2 = do_parse_irealb(&url2).unwrap();
        assert_eq!(
            json1, json2,
            "AST JSON must be stable across a parse → serialize → parse round-trip"
        );
    }

    #[test]
    fn test_serialize_irealb_invalid_json_errors() {
        let result = do_serialize_irealb("{ not real json");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_serialize_irealb_missing_required_field_errors() {
        // `IrealSong::from_json_value` requires `title`, `composer`,
        // `style`, `key_signature`, `time_signature`, `tempo`,
        // `transpose`, `sections`. An empty object is missing all of
        // them; the deserializer must reject rather than fabricate.
        let result = do_serialize_irealb("{}");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- iReal Pro PNG / PDF render (#2067 Phase 2c) ----

    #[test]
    fn test_render_ireal_png_emits_png_bytes() {
        let bytes = do_render_ireal_png(TINY_IREAL_URL).unwrap();
        assert!(
            bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n",
            "expected PNG signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[test]
    fn test_render_ireal_png_invalid_url_errors() {
        let result = do_render_ireal_png("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_render_ireal_pdf_emits_pdf_bytes() {
        let bytes = do_render_ireal_pdf(TINY_IREAL_URL).unwrap();
        assert!(
            bytes.starts_with(b"%PDF-"),
            "expected PDF signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[test]
    fn test_render_ireal_pdf_invalid_url_errors() {
        let result = do_render_ireal_pdf("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- pure-Rust cores behind every `*_with_warnings*` wrapper -------

    #[test]
    fn test_resolve_config_inner_default() {
        let opts = RenderOptions::default();
        let cfg = resolve_config_inner(&opts).unwrap();
        let expected = chordsketch_chordpro::config::Config::defaults();
        assert_eq!(format!("{cfg:?}"), format!("{expected:?}"));
    }

    #[test]
    fn test_resolve_config_inner_preset_resolves() {
        let opts = RenderOptions {
            transpose: 0,
            config: Some("guitar".to_string()),
        };
        assert!(resolve_config_inner(&opts).is_ok());
    }

    #[test]
    fn test_resolve_config_inner_inline_rrjson_parses() {
        let opts = RenderOptions {
            transpose: 0,
            config: Some(r#"{ "settings": { "transpose": 2 } }"#.to_string()),
        };
        assert!(resolve_config_inner(&opts).is_ok());
    }

    #[test]
    fn test_resolve_config_inner_invalid_rrjson_errors() {
        let opts = RenderOptions {
            transpose: 0,
            config: Some("{ invalid rrjson !!!".to_string()),
        };
        let err = resolve_config_inner(&opts).unwrap_err();
        assert!(
            err.contains("not a known preset and not valid RRJSON"),
            "error must point at both failure modes; got {err:?}"
        );
    }

    #[test]
    fn test_render_string_with_warnings_core_emits_output_and_no_warnings_on_clean_input() {
        // Drives the pure-Rust core that every `render_*_with_warnings*`
        // wasm-bindgen wrapper delegates to.
        let (output, warnings) = render_string_with_warnings_core(
            MINIMAL_INPUT,
            &RenderOptions::default(),
            chordsketch_render_html::render_songs_with_warnings,
        )
        .unwrap();
        assert!(output.contains("<html"), "must emit a full HTML document");
        assert!(output.contains("Test"), "must reach the rendered title");
        assert!(warnings.is_empty(), "minimal input should have no warnings");
    }

    #[test]
    fn test_render_string_with_warnings_core_captures_saturation_warning() {
        // Saturating transpose = renderer must surface a warning rather
        // than dropping it. Pins the contract for the wasm wrapper.
        let opts = RenderOptions {
            transpose: 100,
            config: None,
        };
        let (_output, warnings) = render_string_with_warnings_core(
            "{title: T}\n{transpose: 100}\n[C]Hello",
            &opts,
            chordsketch_render_text::render_songs_with_warnings,
        )
        .unwrap();
        assert!(
            !warnings.is_empty(),
            "out-of-musical-range transpose must surface a warning"
        );
    }

    #[test]
    fn test_render_string_with_warnings_core_propagates_config_error() {
        let opts = RenderOptions {
            transpose: 0,
            config: Some("not a preset and not valid".to_string()),
        };
        let err = render_string_with_warnings_core(
            MINIMAL_INPUT,
            &opts,
            chordsketch_render_text::render_songs_with_warnings,
        )
        .unwrap_err();
        assert!(err.contains("not a known preset and not valid RRJSON"));
    }

    #[test]
    fn test_render_string_with_warnings_core_text_route() {
        let (output, _) = render_string_with_warnings_core(
            MINIMAL_INPUT,
            &RenderOptions::default(),
            chordsketch_render_text::render_songs_with_warnings,
        )
        .unwrap();
        // Text path emits no HTML envelope.
        assert!(!output.contains("<html"));
        assert!(output.contains("Test"));
    }

    #[test]
    fn test_render_bytes_with_warnings_core_emits_pdf_signature() {
        let (bytes, warnings) = render_bytes_with_warnings_core(
            MINIMAL_INPUT,
            &RenderOptions::default(),
            chordsketch_render_pdf::render_songs_with_warnings,
        )
        .unwrap();
        assert!(bytes.starts_with(b"%PDF"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_render_bytes_with_warnings_core_propagates_config_error() {
        let opts = RenderOptions {
            transpose: 0,
            config: Some("{ broken }".to_string()),
        };
        let err = render_bytes_with_warnings_core(
            MINIMAL_INPUT,
            &opts,
            chordsketch_render_pdf::render_songs_with_warnings,
        )
        .unwrap_err();
        assert!(err.contains("not a known preset"));
    }

    #[test]
    fn test_render_string_inner_threads_transpose() {
        // Plumbing guard: a refactor that forgot to forward
        // `opts.transpose` into the renderer would compile but silently
        // ignore the option.
        let zero = render_string_inner(
            MINIMAL_INPUT,
            RenderOptions::default(),
            chordsketch_render_text::render_songs_with_warnings,
        )
        .unwrap();
        let shifted = render_string_inner(
            MINIMAL_INPUT,
            RenderOptions {
                transpose: 2,
                config: None,
            },
            chordsketch_render_text::render_songs_with_warnings,
        )
        .unwrap();
        assert_ne!(zero, shifted, "transpose=2 must alter rendered text");
    }

    #[test]
    fn test_render_bytes_inner_threads_transpose() {
        let zero = render_bytes_inner(
            MINIMAL_INPUT,
            RenderOptions::default(),
            chordsketch_render_pdf::render_songs_with_warnings,
        )
        .unwrap();
        let shifted = render_bytes_inner(
            MINIMAL_INPUT,
            RenderOptions {
                transpose: 2,
                config: None,
            },
            chordsketch_render_pdf::render_songs_with_warnings,
        )
        .unwrap();
        assert_ne!(zero, shifted, "transpose=2 must alter PDF byte stream");
        assert!(zero.starts_with(b"%PDF"));
    }

    // Note: `render_string_inner` / `render_bytes_inner` Err-path tests
    // are intentionally absent here. Their error variant is `JsValue`,
    // whose `Drop` calls a wasm-bindgen-imported function that panics
    // on non-wasm32 targets. The Err path is exercised at the
    // pure-Rust core level by `test_resolve_config_inner_*` and
    // `test_render_string_with_warnings_core_propagates_config_error`,
    // and at the JS boundary by the wasm32 integration tests below.
}

/// Integration tests that exercise the actual `#[wasm_bindgen]` ->
/// `JsValue` boundary. These cannot run under native `cargo test`
/// because `JsValue` and `console_warn` are wasm-bindgen imports;
/// `wasm_bindgen_test` arranges a JS host (Node.js or a headless
/// browser) to back them.
///
/// Run via `wasm-pack test --node crates/wasm`. CI runs this in
/// `.github/workflows/wasm.yml`. See #1055, #1108.
#[cfg(all(test, target_arch = "wasm32"))]
mod wasm_tests {
    use super::*;
    use js_sys::{Array, Reflect};
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_test::wasm_bindgen_test;

    const MINIMAL_INPUT: &str = "{title: Test}\n[C]Hello";

    /// `render_html_with_options` accepts a real JS object and produces
    /// HTML containing the rendered title. Exercises the
    /// `serde_wasm_bindgen::from_value` deserialization path that
    /// native tests bypass.
    #[wasm_bindgen_test]
    fn render_html_with_options_object() {
        let opts = js_sys::Object::new();
        Reflect::set(&opts, &"transpose".into(), &JsValue::from(2)).unwrap();
        Reflect::set(&opts, &"config".into(), &JsValue::from_str("guitar")).unwrap();
        let result = render_html_with_options(MINIMAL_INPUT, opts.into()).unwrap();
        assert!(result.contains("Test"));
    }

    /// `render_*_with_options(undefined)` is the spelling the no-options
    /// entry points use to delegate. The deserializer treats `undefined`
    /// as the default `RenderOptions`.
    #[wasm_bindgen_test]
    fn render_html_with_options_undefined() {
        let result = render_html_with_options(MINIMAL_INPUT, JsValue::UNDEFINED).unwrap();
        assert!(result.contains("Test"));
    }

    #[wasm_bindgen_test]
    fn render_html_with_options_null() {
        let result = render_html_with_options(MINIMAL_INPUT, JsValue::NULL).unwrap();
        assert!(result.contains("Test"));
    }

    /// A non-numeric `transpose` (string) fails deserialization with a JS
    /// error, matching the `RenderOptions::transpose: i8` declaration.
    /// `serde_wasm_bindgen` rejects the type mismatch before the value
    /// ever reaches `parse_transpose`.
    #[wasm_bindgen_test]
    fn render_html_with_options_invalid_transpose_type() {
        let opts = js_sys::Object::new();
        Reflect::set(
            &opts,
            &"transpose".into(),
            &JsValue::from_str("not a number"),
        )
        .unwrap();
        let result = render_html_with_options(MINIMAL_INPUT, opts.into());
        assert!(
            result.is_err(),
            "string transpose should fail to deserialize"
        );
    }

    /// Invalid `config` strings (neither a known preset nor valid RRJSON)
    /// produce a `JsValue` error string from `resolve_config`.
    #[wasm_bindgen_test]
    fn render_html_with_options_invalid_config() {
        let opts = js_sys::Object::new();
        Reflect::set(
            &opts,
            &"config".into(),
            &JsValue::from_str("{ not valid rrjson"),
        )
        .unwrap();
        let result = render_html_with_options(MINIMAL_INPUT, opts.into());
        assert!(result.is_err(), "invalid config should fail to resolve");
        let err = result.unwrap_err();
        let msg = err.as_string().unwrap_or_default();
        assert!(
            msg.contains("invalid config"),
            "error should mention invalid config, got: {msg}"
        );
    }

    /// `render_pdf_with_options` returns a `Uint8Array` (mapped from
    /// `Vec<u8>` by wasm-bindgen). Verify the magic header.
    #[wasm_bindgen_test]
    fn render_pdf_with_options_undefined_returns_pdf() {
        let result = render_pdf_with_options(MINIMAL_INPUT, JsValue::UNDEFINED).unwrap();
        assert!(result.len() > 4);
        assert_eq!(&result[0..4], b"%PDF");
    }

    // -- *_with_warnings_and_options (#1895) ------------------------------

    /// `render_html_with_warnings_and_options(undefined)` degrades to the
    /// defaults path and returns `{ output, warnings }`.
    #[wasm_bindgen_test]
    fn render_html_with_warnings_and_options_undefined() {
        let v = render_html_with_warnings_and_options(MINIMAL_INPUT, JsValue::UNDEFINED).unwrap();
        let output = js_sys::Reflect::get(&v, &"output".into()).unwrap();
        assert!(output.as_string().unwrap_or_default().contains("Test"));
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        // Array::is_array is the strict check; plain objects would also pass
        // is_object() so we need the stronger predicate to catch a future
        // refactor that accidentally returns a record instead of an array.
        assert!(
            Array::is_array(&warnings),
            "warnings must be a JS array (got {warnings:?})"
        );
    }

    /// A `transpose` option changes the rendered output, proving the
    /// option is actually wired through to the renderer rather than
    /// silently ignored.
    #[wasm_bindgen_test]
    fn render_html_with_warnings_and_options_transpose_differs() {
        let no_opts =
            render_html_with_warnings_and_options(MINIMAL_INPUT, JsValue::UNDEFINED).unwrap();
        let base = js_sys::Reflect::get(&no_opts, &"output".into())
            .unwrap()
            .as_string()
            .unwrap();

        let opts = js_sys::Object::new();
        Reflect::set(&opts, &"transpose".into(), &JsValue::from(2)).unwrap();
        let transposed = render_html_with_warnings_and_options(MINIMAL_INPUT, opts.into()).unwrap();
        let shifted = js_sys::Reflect::get(&transposed, &"output".into())
            .unwrap()
            .as_string()
            .unwrap();

        assert_ne!(
            base, shifted,
            "transpose=2 must produce different output from transpose=0"
        );
    }

    /// Invalid `config` strings surface through the same `JsValue` error
    /// channel as `render_*_with_options`.
    #[wasm_bindgen_test]
    fn render_html_with_warnings_and_options_invalid_config() {
        let opts = js_sys::Object::new();
        Reflect::set(
            &opts,
            &"config".into(),
            &JsValue::from_str("{ not valid rrjson"),
        )
        .unwrap();
        let result = render_html_with_warnings_and_options(MINIMAL_INPUT, opts.into());
        assert!(result.is_err(), "invalid config should fail to resolve");
    }

    /// Ensure the text variant is wired up through the same inner path —
    /// a quick smoke test so a future refactor that forgets to plumb
    /// `opts.transpose` in one variant fails loudly.
    #[wasm_bindgen_test]
    fn render_text_with_warnings_and_options_smoke() {
        let v = render_text_with_warnings_and_options(MINIMAL_INPUT, JsValue::UNDEFINED).unwrap();
        let output = js_sys::Reflect::get(&v, &"output".into()).unwrap();
        assert!(output.as_string().unwrap_or_default().contains("Test"));
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        assert!(
            Array::is_array(&warnings),
            "warnings must be a JS array (got {warnings:?})"
        );
    }

    /// PDF variant: confirm the magic header is preserved when routed
    /// through the options-aware `*_with_warnings` path.
    #[wasm_bindgen_test]
    fn render_pdf_with_warnings_and_options_returns_pdf_bytes() {
        let v = render_pdf_with_warnings_and_options(MINIMAL_INPUT, JsValue::UNDEFINED).unwrap();
        let output = js_sys::Reflect::get(&v, &"output".into()).unwrap();
        let bytes = js_sys::Uint8Array::from(output);
        assert!(bytes.length() > 4);
        let header = {
            let mut buf = [0u8; 4];
            bytes.slice(0, 4).copy_to(&mut buf);
            buf
        };
        assert_eq!(&header, b"%PDF");
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        assert!(
            Array::is_array(&warnings),
            "warnings must be a JS array (got {warnings:?})"
        );
    }

    // -- *_with_warnings (no-options) at the JsValue boundary (#1894) -----
    //
    // The `*_and_options` siblings above already exercise the options
    // path; these tests pin the plain no-options entry points so a
    // future refactor of the delegation shape can't silently drop the
    // `{ output, warnings }` shape or the Uint8Array payload type.

    /// `renderTextWithWarnings` returns `{ output: string, warnings: string[] }`
    /// at the JS boundary. Clean input → empty warnings array.
    #[wasm_bindgen_test]
    fn render_text_with_warnings_returns_object_with_output_and_warnings() {
        let v = render_text_with_warnings(MINIMAL_INPUT).unwrap();
        let output = js_sys::Reflect::get(&v, &"output".into()).unwrap();
        assert!(
            output.is_string(),
            "output must be a JS string (got {output:?})"
        );
        // `is_string()` is already asserted, so the `as_string()` conversion
        // is infallible — use `unwrap` instead of `unwrap_or_default` per
        // `.claude/rules/code-style.md` (reserve fallbacks for genuinely
        // unknown states).
        assert!(
            output.as_string().unwrap().contains("Test"),
            "output must contain the rendered title"
        );
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        assert!(
            Array::is_array(&warnings),
            "warnings must be a JS array (got {warnings:?})"
        );
        // Clean minimal input produces no warnings — pin the contract so a
        // future regression that emits spurious warnings for clean songs
        // fails loudly.
        let arr = Array::from(&warnings);
        assert_eq!(
            arr.length(),
            0,
            "clean input must produce no warnings; got {} entries",
            arr.length(),
        );
    }

    /// `renderHtmlWithWarnings` — same structural check.
    #[wasm_bindgen_test]
    fn render_html_with_warnings_returns_object_with_output_and_warnings() {
        let v = render_html_with_warnings(MINIMAL_INPUT).unwrap();
        let output = js_sys::Reflect::get(&v, &"output".into()).unwrap();
        assert!(output.is_string(), "output must be a JS string");
        // Match the text variant: also confirm the render reached the
        // title so an empty-string `output` field does not pass the test.
        assert!(
            output.as_string().unwrap().contains("Test"),
            "output must contain the rendered title"
        );
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        assert!(Array::is_array(&warnings), "warnings must be a JS array");
        let arr = Array::from(&warnings);
        assert_eq!(arr.length(), 0, "clean input must produce no warnings");
    }

    /// `renderPdfWithWarnings` returns `output` as a `Uint8Array` (not a
    /// plain array — the `cfg(not(target_arch = "wasm32"))` serde
    /// fallback would produce a plain array, which the wasm test host
    /// MUST NOT hit).
    #[wasm_bindgen_test]
    fn render_pdf_with_warnings_returns_uint8array_output() {
        let v = render_pdf_with_warnings(MINIMAL_INPUT).unwrap();
        let output = js_sys::Reflect::get(&v, &"output".into()).unwrap();
        // `Uint8Array::from(value)` panics on non-Uint8Array input, so
        // check with `instanceof` first for a clean failure message.
        assert!(
            output.is_instance_of::<js_sys::Uint8Array>(),
            "output must be a Uint8Array (got {output:?})"
        );
        let bytes = js_sys::Uint8Array::from(output);
        assert!(bytes.length() > 4, "PDF output must have bytes");
        let mut header = [0u8; 4];
        bytes.slice(0, 4).copy_to(&mut header);
        assert_eq!(&header, b"%PDF");
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        assert!(Array::is_array(&warnings), "warnings must be a JS array");
    }

    /// Warning-triggering input: `{capo: 999}` is out of range
    /// (`validate_capo` accepts 1..=24) and unconditionally emits a
    /// warning through the core `push_warning` helper.
    /// `render_text_with_warnings` must capture it into the `warnings`
    /// array rather than forwarding to `console.warn` (the contract
    /// that distinguishes this variant from `render_text`).
    ///
    /// `{transpose: N}` was tried first but is the wrong trigger for
    /// this test: the saturation path in the text renderer only fires
    /// when an external transpose is ALSO supplied
    /// (`combine_transpose(file_offset, cli_transpose)` in
    /// `crates/render-text/src/lib.rs` L167-177). The no-options
    /// `render_text_with_warnings` passes `transpose: 0` to the
    /// renderer, so a file-only `{transpose: 100}` combines to 100
    /// and does not saturate — no warning emitted, assertion fails.
    #[wasm_bindgen_test]
    fn render_text_with_warnings_captures_out_of_range_capo_warning() {
        let v = render_text_with_warnings("{title: T}\n{capo: 999}\n[C]Hello").unwrap();
        let warnings = js_sys::Reflect::get(&v, &"warnings".into()).unwrap();
        assert!(Array::is_array(&warnings), "warnings must be a JS array");
        let arr = Array::from(&warnings);
        assert!(
            arr.length() >= 1,
            "expected at least one warning from a {{capo: 999}} source (got {} entries)",
            arr.length(),
        );
        // Pin the message shape so a future rename of the validate_capo
        // warning template surfaces here instead of silently decoupling
        // this regression gate from the real warning path.
        let first = arr.get(0).as_string().unwrap_or_default();
        assert!(
            first.contains("capo"),
            "warning should mention `capo`; got: {first}",
        );
    }

    /// `version()` returns a non-empty string through the `JsValue`
    /// boundary.
    #[wasm_bindgen_test]
    fn version_returns_nonempty_string() {
        let v = version();
        assert!(!v.is_empty());
    }

    // -- bare public entry points (#1982) --------------------------------
    //
    // The `_with_options` variants have explicit JS-boundary tests above,
    // but the bare `render_text` / `render_html` / `render_pdf` and
    // `render_text_with_options` entry points only had native `#[test]`
    // coverage. Add wasm-side tests so a future regression in the bare
    // delegation path is caught by `wasm-pack test --node` in CI.

    #[wasm_bindgen_test]
    fn render_html_bare_js_boundary() {
        let result = render_html(MINIMAL_INPUT).unwrap();
        assert!(result.contains("Test"));
    }

    #[wasm_bindgen_test]
    fn render_text_bare_js_boundary() {
        let result = render_text(MINIMAL_INPUT).unwrap();
        assert!(result.contains("Test"));
    }

    #[wasm_bindgen_test]
    fn render_pdf_bare_js_boundary() {
        let bytes = render_pdf(MINIMAL_INPUT).unwrap();
        assert!(bytes.len() > 4);
        assert_eq!(&bytes[0..4], b"%PDF");
    }

    #[wasm_bindgen_test]
    fn render_text_with_options_js_boundary() {
        let opts = js_sys::Object::new();
        Reflect::set(&opts, &"transpose".into(), &JsValue::from(2)).unwrap();
        let result = render_text_with_options(MINIMAL_INPUT, opts.into()).unwrap();
        assert!(result.contains("Test"));
    }

    // -- validate JS-boundary tests (#2009) ------------------------------
    //
    // `validate` now serialises to an array of `{line, column, message}`
    // objects via `serde_wasm_bindgen`. These tests run in a real JS host
    // so the returned `JsValue` can be introspected as an array.

    #[wasm_bindgen_test]
    fn validate_returns_empty_array_for_valid_input() {
        let result = validate(MINIMAL_INPUT).unwrap();
        let arr: Array = result.dyn_into().expect("validate should return an array");
        assert_eq!(arr.length(), 0, "valid input should produce no errors");
    }

    #[wasm_bindgen_test]
    fn validate_returns_structured_errors_for_bad_input() {
        // Unclosed chord bracket produces at least one parse error.
        let result = validate("{title: Test}\n[G").unwrap();
        let arr: Array = result.dyn_into().expect("validate should return an array");
        assert!(
            arr.length() > 0,
            "bad input should produce at least one error"
        );

        let first = arr.get(0);
        // Each entry is a plain object with line/column/message.
        let line = Reflect::get(&first, &"line".into()).unwrap();
        let column = Reflect::get(&first, &"column".into()).unwrap();
        let message = Reflect::get(&first, &"message".into()).unwrap();

        assert!(
            line.as_f64().unwrap_or_default() >= 1.0,
            "line should be one-based"
        );
        assert!(
            column.as_f64().unwrap_or_default() >= 1.0,
            "column should be one-based"
        );
        let msg = message.as_string().unwrap_or_default();
        assert!(
            msg.contains("unclosed"),
            "error message should mention 'unclosed', got: {msg}"
        );
    }

    /// Smoke test that the `start` panic hook function exists and is
    /// callable through the wasm-bindgen boundary. We don't trigger an
    /// actual panic (it would abort the test runner), but calling
    /// `set_once` a second time is safe and exercises the symbol.
    #[wasm_bindgen_test]
    fn start_panic_hook_callable() {
        start();
        // Calling twice exercises the `Once` semantics in
        // `console_error_panic_hook` and confirms the symbol resolves.
        start();
    }

    /// Build a sentinel input that GUARANTEES the renderer emits at
    /// least one warning, render it, and assert that `console.warn`
    /// was called with the expected prefix at least once. This is the
    /// regression test for #1051 (warnings going to `eprintln!` and
    /// silently disappearing in WASM contexts).
    ///
    /// Sentinel: a `{transpose: 100}` directive in the source combined
    /// with a CLI `transpose: 100` exceeds the `i8` range (200 > 127),
    /// so `chordsketch_chordpro::transpose::combine_transpose` saturates
    /// and the renderer pushes a `transpose offset ... clamped to ...`
    /// warning. See `crates/render-text/src/lib.rs` line 124-131.
    /// (The HTML and PDF renderers have identical saturation paths;
    /// we exercise text here because it has the smallest output.)
    ///
    /// Implementation note: we monkey-patch `console.warn` for the
    /// duration of the test, capture each call into a JS array, then
    /// restore the original. We assert BOTH `captured.length() >= 1`
    /// (so a future regression that drops warnings on the floor would
    /// fail loudly — see #1111) AND that every captured entry starts
    /// with the `chordsketch:` prefix.
    #[wasm_bindgen_test]
    fn render_forwards_warnings_to_console_warn() {
        // Save the original `console.warn`.
        let console = js_sys::Reflect::get(&js_sys::global(), &"console".into()).unwrap();
        let original_warn = js_sys::Reflect::get(&console, &"warn".into()).unwrap();

        // Install a capturing replacement: a JS function that pushes
        // its first argument into a known JS array.
        let captured = Array::new();
        let captured_clone = captured.clone();
        let capture_fn = wasm_bindgen::closure::Closure::wrap(Box::new(move |msg: JsValue| {
            captured_clone.push(&msg);
        })
            as Box<dyn FnMut(JsValue)>);
        Reflect::set(
            &console,
            &"warn".into(),
            capture_fn.as_ref().unchecked_ref(),
        )
        .unwrap();

        // Sentinel: in-file {transpose: 100} + CLI transpose: 100 = 200,
        // which exceeds i8 range and produces a saturation warning.
        let opts = js_sys::Object::new();
        Reflect::set(&opts, &"transpose".into(), &JsValue::from(100)).unwrap();
        let _ = render_text_with_options("{title: T}\n{transpose: 100}\n[C]Hello", opts.into())
            .unwrap();

        // Restore the original `console.warn`.
        Reflect::set(&console, &"warn".into(), &original_warn).unwrap();
        // Drop the closure to free the wasm-bindgen reference.
        drop(capture_fn);

        assert!(
            captured.length() >= 1,
            "expected at least one console.warn call from the saturation-triggering input, got {}",
            captured.length()
        );
        for i in 0..captured.length() {
            let entry = captured.get(i).as_string().unwrap_or_default();
            assert!(
                entry.starts_with("chordsketch:"),
                "console.warn entry should start with 'chordsketch:', got: {entry}"
            );
        }
    }

    // ---- iReal Pro SVG render (#2067 Phase 2a) ----

    /// Tiny `irealb://` fixture; reused in `mod wasm_tests` so the
    /// public-API test does not depend on `mod tests`'s `const`.
    const TINY_IREAL_URL_WASM: &str = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

    /// Exercises the public `renderIrealSvg` wrapper through the
    /// actual `JsValue` boundary. Asserts that the returned string
    /// looks like an SVG document (the exact body is the
    /// `chordsketch-render-ireal` crate's test surface).
    #[wasm_bindgen_test]
    fn render_ireal_svg_emits_svg_document() {
        let svg = render_ireal_svg(TINY_IREAL_URL_WASM).unwrap();
        assert!(
            svg.contains("<svg"),
            "expected SVG document, got: {}",
            &svg[..svg.len().min(200)]
        );
    }

    /// Invalid URL surfaces as a `JsValue` error, not a panic.
    #[wasm_bindgen_test]
    fn render_ireal_svg_invalid_url_errors() {
        let result = render_ireal_svg("not a url");
        assert!(result.is_err(), "expected JsValue Err for invalid URL");
    }

    // ---- iReal Pro AST round-trip (#2067 Phase 2b) ----

    /// `parseIrealb` returns a JSON string the JS side can `JSON.parse`,
    /// and the parsed object exposes the AST-level fields (`title`,
    /// `sections`, …). Confirms the boundary contract for the typed
    /// d.ts wrapper without dragging in a serde DTO.
    #[wasm_bindgen_test]
    fn parse_irealb_emits_ast_json() {
        let json = parse_irealb(TINY_IREAL_URL_WASM).unwrap();
        assert!(json.starts_with('{'), "expected JSON object, got: {json}");
        assert!(
            json.contains("\"sections\""),
            "JSON must include the sections array, got: {json}"
        );
    }

    /// Invalid URL surfaces as a `JsValue` error, not a panic.
    #[wasm_bindgen_test]
    fn parse_irealb_invalid_url_errors() {
        let result = parse_irealb("not a url");
        assert!(result.is_err(), "expected JsValue Err for invalid URL");
    }

    /// Round-trip: `serializeIrealb(parseIrealb(url))` produces an
    /// `irealb://` URL whose re-parse matches the original JSON.
    #[wasm_bindgen_test]
    fn serialize_irealb_round_trip() {
        let json1 = parse_irealb(TINY_IREAL_URL_WASM).unwrap();
        let url2 = serialize_irealb(&json1).unwrap();
        assert!(
            url2.starts_with("irealb://"),
            "expected irealb:// URL, got: {url2}"
        );
        let json2 = parse_irealb(&url2).unwrap();
        assert_eq!(
            json1, json2,
            "AST JSON must be stable across a parse → serialize → parse round-trip"
        );
    }

    /// Invalid JSON surfaces as a `JsValue` error, not a panic.
    #[wasm_bindgen_test]
    fn serialize_irealb_invalid_json_errors() {
        let result = serialize_irealb("{ not real json");
        assert!(result.is_err(), "expected JsValue Err for invalid JSON");
    }

    /// An empty JSON object (missing every required `IrealSong` field)
    /// surfaces as a `JsValue` error, not a panic or a silently
    /// default-filled song.
    #[wasm_bindgen_test]
    fn serialize_irealb_missing_required_field_errors() {
        let result = serialize_irealb("{}");
        assert!(
            result.is_err(),
            "expected JsValue Err for missing required fields"
        );
    }

    // ---- iReal Pro PNG / PDF render (#2067 Phase 2c) ----

    /// Exercises the public `renderIrealPng` wrapper through the
    /// actual `JsValue` boundary. Asserts the returned `Uint8Array`
    /// starts with the PNG magic bytes.
    #[wasm_bindgen_test]
    fn render_ireal_png_emits_png_bytes() {
        let bytes = render_ireal_png(TINY_IREAL_URL_WASM).unwrap();
        assert!(
            bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n",
            "expected PNG signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    /// Invalid URL surfaces as a `JsValue` error, not a panic.
    #[wasm_bindgen_test]
    fn render_ireal_png_invalid_url_errors() {
        let result = render_ireal_png("not a url");
        assert!(result.is_err(), "expected JsValue Err for invalid URL");
    }

    /// Exercises the public `renderIrealPdf` wrapper through the
    /// actual `JsValue` boundary. Asserts the returned `Uint8Array`
    /// starts with the PDF magic bytes.
    #[wasm_bindgen_test]
    fn render_ireal_pdf_emits_pdf_bytes() {
        let bytes = render_ireal_pdf(TINY_IREAL_URL_WASM).unwrap();
        assert!(
            bytes.starts_with(b"%PDF-"),
            "expected PDF signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    /// Invalid URL surfaces as a `JsValue` error, not a panic.
    #[wasm_bindgen_test]
    fn render_ireal_pdf_invalid_url_errors() {
        let result = render_ireal_pdf("not a url");
        assert!(result.is_err(), "expected JsValue Err for invalid URL");
    }
}
