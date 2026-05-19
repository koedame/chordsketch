//! WebAssembly bindings for ChordSketch.
//!
//! Exposes ChordPro parsing and rendering (HTML, plain text, PDF) to
//! JavaScript/TypeScript via `wasm-bindgen`.
//!
//! # Crate layout
//!
//! - **[`bindings`]** — every `#[wasm_bindgen]` entry point, plus the
//!   `JsValue`-coupled helpers (`deserialize_options`, `resolve_config`,
//!   `render_string_inner`, `render_string_with_warnings_inner`, …)
//!   that compose into the public JS surface. The proc-macro expansion
//!   emits `extern "C"` glue against the `__wbindgen_*` runtime
//!   resolved by host JS, so those lines are unreachable from
//!   `cargo test` and `cargo llvm-cov`'s instrumented test binary.
//!   `codecov.yml` excludes `bindings.rs` from coverage measurement
//!   (issue #2352); integration coverage of the actual ABI thunks runs
//!   under `wasm-pack test --node` against the
//!   `#[cfg(all(test, target_arch = "wasm32"))] mod wasm_tests` block below.
//! - **`lib`** (this file) — pure-Rust helpers
//!   (`resolve_config_inner`, `flush_warnings`, `do_render_string`,
//!   `do_render_bytes`, `render_string_with_warnings_core`,
//!   `validate_inner`, `do_parse_chordpro`, `do_convert_*`,
//!   `do_render_ireal_*`, `do_parse_irealb`, `do_serialize_irealb`,
//!   `chord_diagram_svg_inner`, `do_chord_typography`, …) plus the
//!   shared `RenderOptions` / `ValidationErrorPayload` /
//!   `ConversionWithWarnings` types. Every `#[wasm_bindgen]` function
//!   in `bindings.rs` is a 1–3 line wrapper around one of these
//!   helpers, so the native test suite at the bottom covers the
//!   binding's full business logic without needing the wasm runtime.
//!
//! Sister-site rule: every helper / wrapper pair added here must have
//! a matching pair in `crates/napi/src/{lib.rs, bindings.rs}` and
//! `crates/ffi/src/lib.rs`. See `.claude/rules/fix-propagation.md`
//! §Bindings.

use chordsketch_chordpro::render_result::RenderResult;
use serde::{Deserialize, Serialize};

pub mod bindings;

/// Render options passed from JavaScript.
#[derive(Deserialize, Default)]
pub(crate) struct RenderOptions {
    /// Semitone transposition offset. Any `i8` value is accepted; the
    /// renderer reduces modulo 12 internally. (Aligning with the CLI,
    /// UniFFI bindings, and napi-rs binding behavior — see #1053, #1065.)
    #[serde(default)]
    pub(crate) transpose: i8,
    /// Configuration preset name (e.g., "guitar", "ukulele") or inline
    /// RRJSON configuration string.
    #[serde(default)]
    pub(crate) config: Option<String>,
}

/// Resolve a [`chordsketch_chordpro::config::Config`] from the options.
///
/// Pure-Rust core: returns a plain `String` error so unit tests can
/// drive every config-parse branch without constructing a `JsValue`
/// (which on native test targets panics on any wasm-bindgen-imported
/// method call). The wasm-bindgen call sites convert via
/// [`bindings::resolve_config`].
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
pub(crate) fn resolve_config_inner(
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

/// Forward each warning in a [`RenderResult`] to `console.warn` and
/// unwrap the output. Single source of truth for the warning side
/// effect, called by both [`do_render_string`] and [`do_render_bytes`].
/// See #1109.
pub(crate) fn flush_warnings<T>(result: RenderResult<T>) -> T {
    for w in &result.warnings {
        bindings::console_warn(&format!("chordsketch: {w}"));
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
/// dead code (#1083).
pub(crate) fn do_render_string(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<String>,
) -> String {
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    flush_warnings(render_fn(&songs, transpose, config))
}

/// Parse input and render songs to bytes (PDF). See [`do_render_string`].
///
/// Gated by `png-pdf` because every caller (the bindings' PDF wrappers
/// in `bindings::render_bytes_inner`) is itself gated by that feature
/// (#2466). On a `no-default-features` lean build, this helper is
/// unreachable and rustc rightly flags it as dead.
#[cfg(feature = "png-pdf")]
pub(crate) fn do_render_bytes(
    input: &str,
    config: &chordsketch_chordpro::config::Config,
    transpose: i8,
    render_fn: fn(
        &[chordsketch_chordpro::ast::Song],
        i8,
        &chordsketch_chordpro::config::Config,
    ) -> RenderResult<Vec<u8>>,
) -> Vec<u8> {
    let parse_result = chordsketch_chordpro::parse_multi_lenient(input);
    let songs: Vec<_> = parse_result.results.into_iter().map(|r| r.song).collect();
    flush_warnings(render_fn(&songs, transpose, config))
}

/// Pure-Rust core for the `*_with_warnings` family: parse + render +
/// capture warnings, returning `(output, warnings)`. Unit-testable
/// without touching the wasm-bindgen serialisation boundary.
pub(crate) fn render_string_with_warnings_core(
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

/// Pure-Rust core for the bytes-returning `*_with_warnings` family.
/// See [`render_string_with_warnings_core`] for the rationale.
///
/// Gated by `png-pdf` — only the PDF surface consumes the byte
/// `*_with_warnings` shape (#2466).
#[cfg(feature = "png-pdf")]
pub(crate) fn render_bytes_with_warnings_core(
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

/// Look up an SVG chord diagram for the given chord name and
/// instrument. Pure-Rust core that [`bindings::chord_diagram_svg`] and
/// [`bindings::chord_diagram_svg_with_defines`] both delegate to.
///
/// `instrument` accepts (case-insensitive): `"guitar"`, `"ukulele"`
/// (alias `"uke"`), or `"piano"` (aliases `"keyboard"`, `"keys"`).
///
/// Returns `Result<_, String>` (not `Result<_, JsValue>`) so unit
/// tests can exercise every match arm without constructing a
/// `JsValue` — `JsValue::Drop` calls a wasm-bindgen-imported function
/// that panics on non-wasm32 targets. Sister-site to the NAPI binding's
/// `chord_diagram_svg_inner` and the FFI binding's
/// `chord_diagram_svg_with_defines` (`.claude/rules/fix-propagation.md`
/// §Bindings).
pub(crate) fn chord_diagram_svg_inner(
    chord: &str,
    instrument: &str,
    defines: &[(String, String)],
) -> std::result::Result<Option<String>, String> {
    use chordsketch_chordpro::chord_diagram::{render_keyboard_svg, render_svg};
    use chordsketch_chordpro::voicings::{lookup_diagram, lookup_keyboard_voicing};

    match instrument.to_ascii_lowercase().as_str() {
        "piano" | "keyboard" | "keys" => {
            // `lookup_keyboard_voicing` takes its defines as
            // `&[(String, Vec<i32>)]` (keys form), not the
            // fretted `&[(String, String)]` form. Bridging
            // between the two requires re-parsing each raw
            // string via `ChordDefinition::parse_value` and
            // promoting `keys` entries into the Vec<i32> shape.
            // The Rust HTML renderer does that work inside
            // `render-html`'s keyboard branch — replicating it
            // here would mean a sister-site helper in
            // `chordsketch-chordpro`. Tracked as a follow-up;
            // for now the wasm boundary passes an empty defines
            // slice for keyboards (same behaviour as before
            // this commit), and only the fretted branch
            // benefits from the new API.
            let _ = defines;
            Ok(lookup_keyboard_voicing(chord, &[]).map(|v| render_keyboard_svg(&v)))
        }
        "guitar" | "ukulele" | "uke" => {
            // `frets_shown = 5` matches the default ChordPro HTML
            // renderer (`crates/render-html` emits 5-fret diagrams
            // when no `{chordfrets}` directive is set) so diagrams
            // produced by `<ChordDiagram>` visually match the
            // sheet output from `<ChordSheet>` for the same chord.
            Ok(lookup_diagram(chord, defines, instrument, 5).map(|d| render_svg(&d)))
        }
        other => Err(format!(
            "unknown instrument {other:?}; expected one of \"guitar\", \"ukulele\", \"piano\""
        )),
    }
}

/// A single validation issue reported by [`bindings::validate`].
///
/// Serialised to a plain JS `{line, column, message}` object via
/// `serde_wasm_bindgen`. Matches the NAPI / FFI `ValidationError`
/// declarations after #2009. Line and column are one-based (editor
/// diagnostic convention).
#[derive(Serialize)]
pub(crate) struct ValidationErrorPayload {
    pub(crate) line: u32,
    pub(crate) column: u32,
    pub(crate) message: String,
}

/// Shared inner helper used by both the wasm-bindgen wrapper and native
/// unit tests. Keeping this free of any wasm-bindgen imports means
/// `cargo test -p chordsketch-wasm` runs without hitting the "cannot
/// call wasm-bindgen imported functions on non-wasm targets" panic that
/// `serde_wasm_bindgen::to_value` triggers off-target.
pub(crate) fn validate_inner(input: &str) -> Vec<ValidationErrorPayload> {
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

// ---- ChordPro parse-to-AST binding -----------------------------

/// Run the ChordPro source → AST JSON pipeline; native helper used
/// by the wasm wrapper and Rust unit tests. The pipeline:
///
///   1. `chordsketch_chordpro::parse_lenient_with_options` —
///      collects parse warnings non-fatally; the lenient flavour
///      always returns an AST plus a warnings vector, so the only
///      `Err` paths are pre-parser preconditions enforced by
///      `parse_lenient_with_options` itself.
///   2. Optional transpose, applied AFTER parse so the AST mirrors
///      the rendering pipeline used by the Rust HTML / PDF / text
///      renderers.
///   3. `chordsketch_chordpro::json::ToJson::to_json_string` — the
///      hand-rolled, zero-dep serialiser the
///      `@chordsketch/react` AST → JSX walker consumes.
pub(crate) fn do_parse_chordpro(
    input: &str,
    options: Option<&RenderOptions>,
) -> Result<(String, Vec<String>, Option<String>), String> {
    use chordsketch_chordpro::json::ToJson;

    let parse_options = chordsketch_chordpro::ParseOptions::default();
    let parse_result = chordsketch_chordpro::parse_lenient_with_options(input, &parse_options);
    // The lenient parser exposes recoverable issues as `errors` —
    // the structural recovery happens inline. Surface them to the
    // React preview as `warnings` so they ride alongside the AST
    // without aborting the render.
    let warnings: Vec<String> = parse_result.errors.iter().map(|w| format!("{w}")).collect();

    let song = parse_result.song;
    let transpose_steps = options.map(|o| o.transpose).unwrap_or(0);

    // Compute the transposed `{key}` directive string for the
    // React preview's "Original Key X · Play Key Y" header.
    // `transpose::transpose` only touches `lines` and clones
    // metadata as-is, so the original key string stays on the
    // emitted AST. Emit the transposed counterpart through the
    // separate `transposed_key` field below so the JSX walker
    // does not have to re-do the music-theory inside JS (per
    // `.claude/rules/playground-is-a-sample.md`'s spirit — the
    // library owns the maths).
    let transposed_key = if transpose_steps != 0 {
        // Canonical-spelling lookup: e.g. C +1 → Db (not C#),
        // C +10 → Bb (not A#). Matches `transpose(song, …)`'s
        // chord-line spelling so the header chip and the lyric
        // chord row agree on which side of the circle of fifths
        // the song landed on. Returns `None` for unparseable
        // keys (e.g. `{key: C dorian}`) — the walker falls back
        // to showing the original key only in that case.
        chordsketch_chordpro::transpose::canonical_transposed_key(
            song.metadata.key.as_deref(),
            transpose_steps,
        )
    } else {
        None
    };

    // Apply transpose if requested. Mirrors the renderer entry
    // points which do this same step before rendering — keeps the
    // React preview's chord labels in sync with the canonical
    // render path's semantics. `transpose::transpose` returns a
    // new `Song` rather than mutating in place; pass `0` (the
    // default) through unchanged so the no-op case skips the
    // allocation.
    let song = match transpose_steps {
        0 => song,
        steps => chordsketch_chordpro::transpose::transpose(&song, steps),
    };

    Ok((song.to_json_string(), warnings, transposed_key))
}

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
pub(crate) struct ConversionWithWarnings {
    pub(crate) output: String,
    pub(crate) warnings: Vec<String>,
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
pub(crate) fn do_convert_chordpro_to_irealb(input: &str) -> Result<ConversionWithWarnings, String> {
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
pub(crate) fn do_convert_irealb_to_chordpro_text(
    input: &str,
) -> Result<ConversionWithWarnings, String> {
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

/// Run the iReal SVG-render pipeline; native helper used by the
/// wasm wrapper and the unit tests.
pub(crate) fn do_render_ireal_svg(input: &str) -> Result<String, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    Ok(chordsketch_render_ireal::render_svg(
        &ireal,
        &chordsketch_render_ireal::RenderOptions::default(),
    ))
}

/// Run the iReal URL → AST JSON pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
pub(crate) fn do_parse_irealb(input: &str) -> Result<String, String> {
    use chordsketch_ireal::ToJson;
    let song = chordsketch_ireal::parse(input).map_err(|e| format!("parse failed: {e}"))?;
    Ok(song.to_json_string())
}

/// Run the AST JSON → iReal URL pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
pub(crate) fn do_serialize_irealb(input: &str) -> Result<String, String> {
    use chordsketch_ireal::FromJson;
    let song = chordsketch_ireal::IrealSong::from_json_str(input)
        .map_err(|e| format!("invalid AST JSON: {e}"))?;
    Ok(chordsketch_ireal::irealb_serialize(&song))
}

/// Decompose an iReal Pro chord (passed as the JSON shape that
/// [`bindings::parse_irealb`] emits inside `BarChord.chord`) into
/// the engraved typography spans the chart should render.
///
/// Output JSON shape — `{ "spans": [{ "kind": "Root" | "Accidental"
/// | "Extension" | "Slash" | "Bass", "text": "<glyph>" }, …] }`.
///
/// The shorthand-to-glyph translation (`^→Δ`, `h→ø`, `o→°`, `-→−`,
/// `b→♭`, `#→♯`) lives inside
/// [`chordsketch_render_ireal::chord_typography`] so every
/// consumer (the SVG renderer, the React playground, future
/// non-Rust hosts) sees the same result. The wasm export is the
/// vehicle for hosts that don't link the renderer crate directly.
///
/// # Errors
///
/// Returns an error string when `chord_json` is not valid
/// AST-shaped JSON. The `JsValue` mapping is done by the wrapper
/// in [`bindings::chord_typography`].
pub(crate) fn do_chord_typography(chord_json: &str) -> Result<String, String> {
    use chordsketch_ireal::json::FromJson;
    let value = chordsketch_ireal::json::parse_json(chord_json)
        .map_err(|e| format!("invalid chord JSON: {e}"))?;
    let chord = chordsketch_ireal::Chord::from_json_value(&value)
        .map_err(|e| format!("invalid chord shape: {e}"))?;
    let typography = chordsketch_render_ireal::chord_typography::chord_to_typography(&chord);
    let mut out = String::with_capacity(64);
    out.push_str("{\"spans\":[");
    for (i, span) in typography.spans.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"kind\":\"");
        out.push_str(match span.kind {
            chordsketch_render_ireal::SpanKind::Root => "Root",
            chordsketch_render_ireal::SpanKind::Accidental => "Accidental",
            chordsketch_render_ireal::SpanKind::Extension => "Extension",
            chordsketch_render_ireal::SpanKind::Slash => "Slash",
            chordsketch_render_ireal::SpanKind::Bass => "Bass",
        });
        out.push_str("\",\"text\":");
        json_escape_into(&span.text, &mut out);
        out.push('}');
    }
    out.push_str("]}");
    Ok(out)
}

/// Minimal JSON string escaper for the typography output. Mirrors
/// the escape semantics used by the iReal serializer's
/// `write_str` so cross-binding behaviour stays consistent.
fn json_escape_into(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Run the iReal PNG-rasterise pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
///
/// Gated by `png-pdf` because the resvg / tiny-skia / usvg /
/// fontdb / harfrust transitive surface is the dominant size cost
/// of the heavy wasm bundle (#2466).
#[cfg(feature = "png-pdf")]
pub(crate) fn do_render_ireal_png(input: &str) -> Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::png::render_png(
        &ireal,
        &chordsketch_render_ireal::png::PngOptions::default(),
    )
    .map_err(|e| format!("PNG render failed: {e}"))
}

/// Run the iReal PDF-render pipeline; native helper used by the
/// wasm wrapper and by Rust unit tests.
///
/// Gated by `png-pdf` because svg2pdf pulls the same resvg / usvg
/// graph plus its own writer surface (#2466).
#[cfg(feature = "png-pdf")]
pub(crate) fn do_render_ireal_pdf(input: &str) -> Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::pdf::render_pdf(
        &ireal,
        &chordsketch_render_ireal::pdf::PdfOptions::default(),
    )
    .map_err(|e| format!("PDF render failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bindings::{render_html, render_html_body, render_html_css, render_text, version};

    #[cfg(feature = "png-pdf")]
    use crate::bindings::render_pdf;

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

    #[cfg(feature = "png-pdf")]
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
        // `<head>` (the document-envelope element). The body now
        // legitimately contains `<header>` (added by the
        // semantic-HTML refactor in this PR), which would match a
        // naked `<head` prefix check.
        assert!(!body.contains("<head>"));
        assert!(!body.contains("<style"));
        assert!(!body.contains("<title>"));
        // The song markup itself must still be present.
        assert!(body.contains("<article class=\"song\">"));
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
    // `resolve_config_inner` delegates to (Config::preset and
    // Config::parse). They do NOT exercise the JsValue boundary —
    // for that, see the `wasm_tests` module below (gated to wasm32
    // and run via `wasm-pack test --node` in CI).

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
    }

    // Sibling of the text/html happy-path test above — split out so
    // the text/html coverage is not lost when the lean
    // (`@chordsketch/wasm`) build runs `cargo test
    // --no-default-features` (#2466). chordsketch-render-pdf only
    // links in when `png-pdf` is enabled.
    #[cfg(feature = "png-pdf")]
    #[test]
    fn test_with_warnings_pdf_renderer_returns_pdf_bytes_on_clean_input() {
        let parse = chordsketch_chordpro::parse_multi_lenient(MINIMAL_INPUT);
        let songs: Vec<_> = parse.results.into_iter().map(|r| r.song).collect();
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

    // ---- ChordPro parse-to-AST binding ------------------------

    #[test]
    fn test_parse_chordpro_emits_ast_json() {
        let (json, warnings, _transposed_key) =
            do_parse_chordpro("{title: My Song}\n[Am]Hello [G]world", None).unwrap();
        assert!(json.starts_with('{'), "expected JSON object, got: {json}");
        assert!(
            json.contains("\"metadata\""),
            "JSON must include metadata, got: {json}"
        );
        assert!(
            json.contains("\"title\":\"My Song\""),
            "title metadata must round-trip, got: {json}"
        );
        assert!(
            json.contains("\"name\":\"Am\""),
            "chord names must round-trip, got: {json}"
        );
        assert!(warnings.is_empty(), "clean input emits no warnings");
    }

    #[test]
    fn test_parse_chordpro_applies_transpose() {
        let opts = RenderOptions {
            transpose: 2,
            config: None,
        };
        let (json, _, _transposed_key) = do_parse_chordpro("[C]Hello", Some(&opts)).unwrap();
        // C transposed up 2 semitones lands on D.
        assert!(
            json.contains("\"name\":\"D\""),
            "transpose must rewrite chord names, got: {json}"
        );
    }

    #[test]
    fn test_parse_chordpro_no_transpose_preserves_chord() {
        let opts = RenderOptions {
            transpose: 0,
            config: None,
        };
        let (json, _, _transposed_key) = do_parse_chordpro("[C]Hello", Some(&opts)).unwrap();
        assert!(
            json.contains("\"name\":\"C\""),
            "transpose=0 must not alter chord names, got: {json}"
        );
    }

    #[test]
    fn test_parse_chordpro_empty_input_returns_empty_song() {
        let (json, warnings, _transposed_key) = do_parse_chordpro("", None).unwrap();
        assert!(
            json.contains("\"lines\":[]"),
            "empty input must yield an empty lines array, got: {json}"
        );
        assert!(warnings.is_empty(), "empty input emits no warnings");
    }

    #[test]
    fn test_parse_chordpro_transposed_key_emitted_on_nonzero_transpose() {
        // Drives the React preview's "Original Key X · Play Key Y"
        // header. Original key stays on the AST (metadata.clone()
        // path); the third tuple element carries the transposed
        // counterpart.
        let opts = RenderOptions {
            transpose: 2,
            config: None,
        };
        let (json, _warnings, transposed_key) =
            do_parse_chordpro("{key: G}\n[G]Hello", Some(&opts)).unwrap();
        assert!(
            json.contains("\"key\":\"G\""),
            "original key stays on the AST, got: {json}"
        );
        assert_eq!(
            transposed_key.as_deref(),
            Some("A"),
            "transpose +2 from G should land on A"
        );
    }

    #[test]
    fn test_parse_chordpro_transposed_key_null_when_transpose_zero() {
        let opts = RenderOptions {
            transpose: 0,
            config: None,
        };
        let (_json, _warnings, transposed_key) =
            do_parse_chordpro("{key: G}\n[G]Hello", Some(&opts)).unwrap();
        assert!(
            transposed_key.is_none(),
            "transpose=0 must not emit a transposed_key (avoids a redundant duplicate)"
        );
    }

    #[test]
    fn test_parse_chordpro_transposed_key_null_when_key_unparseable() {
        // The chord parser is permissive on extensions (e.g.
        // `C dorian` parses as root=C + extension="dorian" + the
        // transpose lands on `D dorian`), but it bails out on
        // strings that don't lead with a note letter. The walker
        // falls back to showing only the original key string in
        // that case; the wasm surface signals the fallback by
        // leaving `transposed_key` as `None`.
        let opts = RenderOptions {
            transpose: 2,
            config: None,
        };
        let (_json, _warnings, transposed_key) =
            do_parse_chordpro("{key: ???}", Some(&opts)).unwrap();
        assert!(
            transposed_key.is_none(),
            "unparseable key must surface as `None` so the React surface can fall back, got: {transposed_key:?}"
        );
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
    // All four tests are gated by `png-pdf` — the `do_render_ireal_*`
    // helpers and their `chordsketch_render_ireal::png` / `::pdf`
    // module imports are themselves gated, so disabling the feature
    // removes them from the compilation unit entirely (#2466).

    #[cfg(feature = "png-pdf")]
    #[test]
    fn test_render_ireal_png_emits_png_bytes() {
        let bytes = do_render_ireal_png(TINY_IREAL_URL).unwrap();
        assert!(
            bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n",
            "expected PNG signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[cfg(feature = "png-pdf")]
    #[test]
    fn test_render_ireal_png_invalid_url_errors() {
        let result = do_render_ireal_png("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[cfg(feature = "png-pdf")]
    #[test]
    fn test_render_ireal_pdf_emits_pdf_bytes() {
        let bytes = do_render_ireal_pdf(TINY_IREAL_URL).unwrap();
        assert!(
            bytes.starts_with(b"%PDF-"),
            "expected PDF signature, got first bytes: {:?}",
            &bytes[..bytes.len().min(8)]
        );
    }

    #[cfg(feature = "png-pdf")]
    #[test]
    fn test_render_ireal_pdf_invalid_url_errors() {
        let result = do_render_ireal_pdf("not a url");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    // ---- chord_typography wasm export (#2455) ----

    #[test]
    fn test_chord_typography_returns_root_extension_spans_for_minor7() {
        let chord_json = r#"{
            "root":{"note":"C","accidental":"natural"},
            "quality":{"kind":"minor7"},
            "bass":null
        }"#;
        let json = do_chord_typography(chord_json).expect("typography");
        // Output is a JSON object with `spans` array — minor7
        // produces a Root span and an Extension span ("−7").
        assert!(json.contains("\"kind\":\"Root\""));
        assert!(json.contains("\"kind\":\"Extension\""));
    }

    #[test]
    fn test_chord_typography_rejects_malformed_json() {
        // Non-JSON input must return a structured error string,
        // not panic. Wasm callers receive this as a JsValue.
        let result = do_chord_typography("not json");
        assert!(result.is_err(), "expected error, got {result:?}");
    }

    #[test]
    fn test_chord_typography_handles_missing_required_fields() {
        // Missing `root` must produce an Err rather than yielding
        // a default-rooted chord.
        let chord_json = r#"{"quality":{"kind":"major"},"bass":null}"#;
        let result = do_chord_typography(chord_json);
        assert!(result.is_err());
    }

    // ---- chord_diagram_svg_inner (sister-site to NAPI / FFI) ----

    #[test]
    fn test_chord_diagram_svg_inner_guitar_known_chord_returns_svg() {
        let svg = chord_diagram_svg_inner("C", "guitar", &[]).unwrap();
        let svg = svg.expect("guitar C must have a built-in diagram");
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_chord_diagram_svg_inner_ukulele_alias_resolves() {
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
        for variant in ["GUITAR", "Guitar", "gUiTaR"] {
            let svg = chord_diagram_svg_inner("C", variant, &[])
                .unwrap_or_else(|e| panic!("case variant {variant:?} must not error; got {e:?}"));
            assert!(
                svg.is_some(),
                "case variant {variant:?} must find a guitar-C diagram; got None"
            );
        }
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

    #[cfg(feature = "png-pdf")]
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

    #[cfg(feature = "png-pdf")]
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
    fn test_do_render_string_threads_transpose() {
        // Plumbing guard: the helper must thread `transpose` into the
        // renderer. The wasm wrapper passes `opts.transpose` to it.
        let zero = do_render_string(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
            chordsketch_render_text::render_songs_with_warnings,
        );
        let shifted = do_render_string(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            2,
            chordsketch_render_text::render_songs_with_warnings,
        );
        assert_ne!(zero, shifted, "transpose=2 must alter rendered text");
    }

    #[cfg(feature = "png-pdf")]
    #[test]
    fn test_do_render_bytes_threads_transpose() {
        let zero = do_render_bytes(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            0,
            chordsketch_render_pdf::render_songs_with_warnings,
        );
        let shifted = do_render_bytes(
            MINIMAL_INPUT,
            &chordsketch_chordpro::config::Config::defaults(),
            2,
            chordsketch_render_pdf::render_songs_with_warnings,
        );
        assert_ne!(zero, shifted, "transpose=2 must alter PDF byte stream");
        assert!(zero.starts_with(b"%PDF"));
    }
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
    use super::bindings::{
        chord_diagram_svg, chord_diagram_svg_with_defines, parse_irealb, render_html,
        render_html_with_options, render_html_with_warnings, render_html_with_warnings_and_options,
        render_ireal_svg, render_text, render_text_with_options, render_text_with_warnings,
        render_text_with_warnings_and_options, serialize_irealb, start, validate, version,
    };

    #[cfg(feature = "png-pdf")]
    use super::bindings::{
        render_ireal_pdf, render_ireal_png, render_pdf, render_pdf_with_options,
        render_pdf_with_warnings, render_pdf_with_warnings_and_options,
    };

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
    #[cfg(feature = "png-pdf")]
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
    #[cfg(feature = "png-pdf")]
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
    #[cfg(feature = "png-pdf")]
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

    #[cfg(feature = "png-pdf")]
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

    // ---- chord_diagram_svg / chord_diagram_svg_with_defines (#2164) ----

    /// `chord_diagram_svg(chord, "guitar")` returns the inline SVG.
    #[wasm_bindgen_test]
    fn chord_diagram_svg_guitar_known_chord_returns_svg() {
        let svg = chord_diagram_svg("C", "guitar").unwrap();
        assert!(svg.is_some(), "guitar C should resolve");
        assert!(svg.unwrap().contains("<svg"));
    }

    /// Unknown chord under a known instrument yields `None`, not an
    /// error.
    #[wasm_bindgen_test]
    fn chord_diagram_svg_unknown_chord_returns_none() {
        let svg = chord_diagram_svg("XYZ-not-a-chord", "guitar").unwrap();
        assert!(svg.is_none(), "unknown chord should yield None");
    }

    /// Unknown instrument is a `JsValue` error.
    #[wasm_bindgen_test]
    fn chord_diagram_svg_unknown_instrument_errors() {
        let result = chord_diagram_svg("C", "harmonica");
        assert!(result.is_err(), "unknown instrument should error");
    }

    /// `chord_diagram_svg_with_defines([])` matches the no-defines
    /// behaviour.
    #[wasm_bindgen_test]
    fn chord_diagram_svg_with_defines_empty_array_matches_bare() {
        let bare = chord_diagram_svg("C", "guitar").unwrap();
        let with_empty = chord_diagram_svg_with_defines("C", "guitar", JsValue::UNDEFINED).unwrap();
        assert_eq!(bare, with_empty);
    }

    // ---- iReal Pro PNG / PDF render (#2067 Phase 2c) ----

    /// Exercises the public `renderIrealPng` wrapper through the
    /// actual `JsValue` boundary. Asserts the returned `Uint8Array`
    /// starts with the PNG magic bytes.
    #[cfg(feature = "png-pdf")]
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
    #[cfg(feature = "png-pdf")]
    #[wasm_bindgen_test]
    fn render_ireal_png_invalid_url_errors() {
        let result = render_ireal_png("not a url");
        assert!(result.is_err(), "expected JsValue Err for invalid URL");
    }

    /// Exercises the public `renderIrealPdf` wrapper through the
    /// actual `JsValue` boundary. Asserts the returned `Uint8Array`
    /// starts with the PDF magic bytes.
    #[cfg(feature = "png-pdf")]
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
    #[cfg(feature = "png-pdf")]
    #[wasm_bindgen_test]
    fn render_ireal_pdf_invalid_url_errors() {
        let result = render_ireal_pdf("not a url");
        assert!(result.is_err(), "expected JsValue Err for invalid URL");
    }
}
