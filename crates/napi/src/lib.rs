//! Native Node.js addon for ChordSketch via [napi-rs](https://napi.rs/).
//!
//! Provides the same API as `@chordsketch/wasm` but as a prebuilt native
//! addon, offering better performance and no WASM overhead.
//!
//! # Crate layout
//!
//! - **[`bindings`]** — every `#[napi]` entry point and `#[napi(object)]`
//!   struct. The proc-macro expansion emits `extern "C"` thunks against
//!   Node-API runtime symbols (`napi_reference_unref`,
//!   `napi_create_buffer`, …) that are only resolved by the host
//!   Node.js process at module load, so those lines are unreachable
//!   from `cargo test` and from `cargo llvm-cov`'s instrumented test
//!   binary. `codecov.yml` excludes `bindings.rs` from coverage
//!   measurement for exactly this reason (issue #2352).
//! - **`lib`** (this file) — pure-Rust helpers (`do_*`, `*_inner`
//!   for the parse + render + validate pipeline; `parse_songs`,
//!   `flush_warnings`, `try_parse_transpose`, `format_conversion_warning`
//!   for the support utilities) plus the unit-test suite that drives
//!   them. Every `#[napi]` function in `bindings.rs` is a 1–3 line
//!   wrapper around one of these helpers, so the tests here cover the
//!   binding's full business logic without needing the Node.js
//!   runtime.
//!
//! Sister-site rule: every helper / wrapper pair added here must have a
//! matching pair in `crates/wasm/src/{lib.rs, bindings.rs}` and
//! `crates/ffi/src/lib.rs`. See `.claude/rules/fix-propagation.md`
//! §Bindings.

use chordsketch_chordpro::render_result::RenderResult;

pub mod bindings;

/// Resolve a config from an optional preset name or RRJSON string.
///
/// Returns `Result<_, String>` (not `napi::Result`) so unit tests can
/// exercise this helper without pulling in `napi::Error`'s `Drop` impl,
/// which references `napi_reference_unref` / `napi_delete_reference` —
/// symbols the Node.js host resolves at runtime, so a native test
/// binary that links them fails with `undefined symbol`. The `#[napi]`
/// wrappers in [`bindings`] convert the `String` error into
/// `napi::Error` at the binding boundary.
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
    let songs = parse_songs(input);
    flush_warnings(render_fn(&songs, transpose, config))
}

/// Parse and render songs as bytes, forwarding any render warnings to stderr.
///
/// See [`do_render_string`] — same pattern for PDF output.
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
    let songs = parse_songs(input);
    flush_warnings(render_fn(&songs, transpose, config))
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
pub(crate) fn do_render_string_with_warnings(
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

/// Shared implementation for the PDF `*_with_warnings` variants. Extracted
/// so [`bindings::render_pdf_with_warnings`] and
/// [`bindings::render_pdf_with_warnings_and_options`] route through the
/// same parse + render + capture pipeline. Returns a `(Vec<u8>,
/// Vec<String>)` tuple so unit tests can drive it without constructing
/// `PdfRenderWithWarnings`, whose `Buffer` field is napi-coupled.
pub(crate) fn do_render_pdf_with_warnings(
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
/// `InvalidArg` error at the `#[napi]` boundary by
/// [`bindings::render_text_with_options`] and its siblings, giving the
/// same failure shape across all four bindings for the same input
/// (issue #1826). `render_html_css_with_options` does not appear here
/// because it has no `transpose` argument — the CSS renderer is
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
/// constructing `napi::Error`. The `#[napi]` wrappers in [`bindings`]
/// convert at the boundary via `bindings::resolve_options`.
pub(crate) fn resolve_options_inner(
    config: Option<&str>,
    transpose: i32,
) -> std::result::Result<(chordsketch_chordpro::config::Config, i8), String> {
    let config = resolve_config_inner(config)?;
    let transpose = try_parse_transpose(transpose)?;
    Ok((config, transpose))
}

/// Pure-Rust implementation of [`bindings::render_html_css_with_options`].
pub(crate) fn render_html_css_with_options_inner(
    config: Option<&str>,
) -> std::result::Result<String, String> {
    let config = resolve_config_inner(config)?;
    Ok(chordsketch_render_html::render_html_css_with_config(
        &config,
    ))
}

/// Pure-Rust implementation of [`bindings::chord_diagram_svg`] /
/// [`bindings::chord_diagram_svg_with_defines`]. `defines` is a slice of
/// `(name, raw)` pairs matching
/// `chordsketch_chordpro::voicings::lookup_diagram`'s contract —
/// the built-in voicing database is consulted only when no entry
/// in `defines` matches the chord name.
pub(crate) fn chord_diagram_svg_inner(
    chord: &str,
    instrument: &str,
    defines: &[(String, String)],
) -> std::result::Result<Option<String>, String> {
    chord_diagram_svg_inner_with_orientation(chord, instrument, defines, None)
}

/// Pure-Rust core of [`bindings::chord_pitches`]. Returns the chord's
/// constituent MIDI note numbers, or `None` when `chord` is not parseable.
///
/// Thin pass-through to [`chordsketch_chordpro::chord_pitches`]; kept here
/// so the native test suite covers the binding's surface without the
/// Node-API runtime. Sister-site to the wasm `chord_pitches_inner` and the
/// FFI binding's `chord_pitches` (`.claude/rules/fix-propagation.md`
/// §Bindings).
#[must_use]
pub(crate) fn chord_pitches_inner(chord: &str) -> Option<Vec<u8>> {
    chordsketch_chordpro::chord_pitches(chord)
}

/// Orientation-aware variant of [`chord_diagram_svg_inner`].
///
/// `orientation` is passed as `Option<&str>` so the JS surface can
/// transmit `null` / `undefined` and the resolver picks the project
/// default (vertical layout). Unrecognised strings are silently
/// treated as the default to match the behaviour of
/// [`chordsketch_chordpro::chord_diagram::resolve_orientation`].
pub(crate) fn chord_diagram_svg_inner_with_orientation(
    chord: &str,
    instrument: &str,
    defines: &[(String, String)],
    orientation: Option<&str>,
) -> std::result::Result<Option<String>, String> {
    use chordsketch_chordpro::chord_diagram::{
        render_keyboard_svg, render_svg_with_orientation, resolve_orientation,
    };
    use chordsketch_chordpro::voicings::{lookup_diagram, lookup_keyboard_voicing};

    let resolved = resolve_orientation(orientation);

    match instrument.to_ascii_lowercase().as_str() {
        "piano" | "keyboard" | "keys" => {
            // Keyboard voicings have their own `{define: … keys …}`
            // shape; the wasm sister-site does not thread defines
            // through this branch either. Match that gap here so
            // NAPI behaviour stays consistent. Drop `defines`
            // explicitly via `let _ = …;` to make the intentional
            // omission visible in the diff (mirrors wasm's
            // `chord_diagram_svg_inner`).
            //
            // Keyboard diagrams have no orientation knob — both arguments
            // are accepted but ignored here.
            let _ = defines;
            Ok(lookup_keyboard_voicing(chord, &[]).map(|v| render_keyboard_svg(&v)))
        }
        "guitar" | "ukulele" | "uke" => {
            // `frets_shown = 5` matches the default ChordPro HTML
            // renderer (`crates/render-html` emits 5-fret diagrams
            // when no `{chordfrets}` directive is set), keeping
            // diagrams produced via NAPI visually consistent with
            // sheets rendered through the same binding.
            Ok(lookup_diagram(chord, defines, instrument, 5)
                .map(|d| render_svg_with_orientation(&d, resolved)))
        }
        other => Err(format!(
            "unknown instrument {other:?}; expected one of \"guitar\", \"ukulele\", \"piano\""
        )),
    }
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
/// directly for the same reason). The `#[napi]` wrapper in [`bindings`]
/// maps the `String` error into `napi::Error` at the binding boundary.
pub(crate) fn do_convert_chordpro_to_irealb(
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
pub(crate) fn do_convert_irealb_to_chordpro_text(
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

/// Run the iReal SVG-render pipeline; native helper so the Rust
/// unit tests can exercise the path without linking against
/// `napi::Error`'s `Drop` impl. See `do_convert_chordpro_to_irealb`
/// for the full rationale.
pub(crate) fn do_render_ireal_svg(input: &str) -> std::result::Result<String, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    Ok(chordsketch_render_ireal::render_svg(
        &ireal,
        &chordsketch_render_ireal::RenderOptions::default(),
    ))
}

/// Run the iReal URL → AST JSON pipeline; native helper. See
/// [`do_convert_chordpro_to_irealb`] for the `Result<_, String>`
/// rationale.
pub(crate) fn do_parse_irealb(input: &str) -> std::result::Result<String, String> {
    use chordsketch_ireal::ToJson;
    let song = chordsketch_ireal::parse(input).map_err(|e| format!("parse failed: {e}"))?;
    Ok(song.to_json_string())
}

/// Run the AST JSON → iReal URL pipeline; native helper.
pub(crate) fn do_serialize_irealb(input: &str) -> std::result::Result<String, String> {
    use chordsketch_ireal::FromJson;
    let song = chordsketch_ireal::IrealSong::from_json_str(input)
        .map_err(|e| format!("invalid AST JSON: {e}"))?;
    Ok(chordsketch_ireal::irealb_serialize(&song))
}

/// Run the iReal PNG-rasterise pipeline; native helper so the Rust
/// unit tests can exercise the path without linking against
/// `napi::Error`'s `Drop` impl. See `do_render_ireal_svg` for the
/// full rationale.
pub(crate) fn do_render_ireal_png(input: &str) -> std::result::Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::png::render_png(
        &ireal,
        &chordsketch_render_ireal::png::PngOptions::default(),
    )
    .map_err(|e| format!("PNG render failed: {e}"))
}

/// A single validation issue reported by [`bindings::validate`].
///
/// Plain Rust struct (no `#[napi(object)]`) so unit tests can drive
/// [`validate_inner`] without pulling in `napi::Error`'s `Drop` impl.
/// The bindings wrapper maps each entry into the napi-coupled
/// `ValidationError` (line / column / message field-for-field) at the
/// boundary. Sister-site to `crates/wasm/src/lib.rs`'s
/// `ValidationErrorPayload` — same shape, same purpose.
pub(crate) struct ValidationErrorPayload {
    pub(crate) line: u32,
    pub(crate) column: u32,
    pub(crate) message: String,
}

/// Pure-Rust core of [`bindings::validate`]. Parses `input` with the
/// lenient ChordPro parser and projects every `ParseError` into a
/// structured `(line, column, message)` triple, clamping the usize
/// line / column at `u32::MAX` so the cross-binding `u32` field type
/// stays panic-free on astronomically-large inputs.
///
/// Returns `Vec<ValidationErrorPayload>` (not `Vec<ValidationError>`)
/// so the unit-test suite below can drive every assertion path
/// without linking `napi::Error`'s `Drop` impl. See
/// [`resolve_config_inner`] for the linkage rationale.
pub(crate) fn validate_inner(input: &str) -> Vec<ValidationErrorPayload> {
    let result = chordsketch_chordpro::parse_multi_lenient(input);
    result
        .results
        .into_iter()
        .flat_map(|r| r.errors.into_iter())
        .map(|e| ValidationErrorPayload {
            // `line()` / `column()` are `usize`; clamp the (astronomically
            // unlikely) overflow at `u32::MAX` so we never panic on
            // conversion.
            line: u32::try_from(e.line()).unwrap_or(u32::MAX),
            column: u32::try_from(e.column()).unwrap_or(u32::MAX),
            message: e.message,
        })
        .collect()
}

/// Validate the JS-supplied `defines: Array<[name, raw]>` argument
/// shape used by [`bindings::chord_diagram_svg_with_defines`]. Each
/// inner array MUST have exactly two elements; anything else is a
/// caller error and surfaces as a `String` here, mapped to
/// `Status::InvalidArg` by the wrapper.
///
/// napi-rs's `tuple` support is limited, so the binding accepts
/// `Array<[name, raw]>` as `Vec<Vec<String>>` and rejects malformed
/// inner arrays at the boundary. The helper returns the canonical
/// `Vec<(String, String)>` shape that
/// `chordsketch_chordpro::voicings::lookup_diagram` consumes.
///
/// Pure-Rust — see [`resolve_config_inner`] for the
/// `napi::Error::Drop` linkage rationale.
pub(crate) fn validate_defines_pairs(
    defines: Vec<Vec<String>>,
) -> std::result::Result<Vec<(String, String)>, String> {
    let mut pairs: Vec<(String, String)> = Vec::with_capacity(defines.len());
    for (i, entry) in defines.into_iter().enumerate() {
        if entry.len() != 2 {
            return Err(format!(
                "defines[{i}] must be [name, raw] (length 2); got length {}",
                entry.len()
            ));
        }
        let mut it = entry.into_iter();
        let name = it.next().expect("length checked above");
        let raw = it.next().expect("length checked above");
        pairs.push((name, raw));
    }
    Ok(pairs)
}

/// Run the iReal PDF-render pipeline; native helper.
pub(crate) fn do_render_ireal_pdf(input: &str) -> std::result::Result<Vec<u8>, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| format!("conversion failed: {e}"))?;
    chordsketch_render_ireal::pdf::render_pdf(
        &ireal,
        &chordsketch_render_ireal::pdf::PdfOptions::default(),
    )
    .map_err(|e| format!("PDF render failed: {e}"))
}

// Unit tests exercise the pure-Rust helpers (`do_render_*`,
// `resolve_*_inner`, `try_parse_transpose`, `chord_diagram_svg_inner`,
// `do_convert_*`, `do_render_ireal_*`, `do_parse_irealb`,
// `do_serialize_irealb`, …) that every `#[napi] pub fn` in
// [`bindings`] wraps. The `#[napi]` wrappers themselves cannot be
// called from `cargo test --lib` because their return types
// reference `napi::Error`, whose `Drop` impl links against
// `napi_reference_unref` / `napi_delete_reference` — symbols only
// resolved by the Node.js host at runtime. The wrappers' bodies are
// 1–3 line shims around the helpers, so exercising the helpers
// covers the binding's full business logic.
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
        let v = crate::bindings::TextRenderWithWarnings {
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
    fn test_chord_pitches_inner_known_chord_returns_midi_notes() {
        assert_eq!(chord_pitches_inner("C"), Some(vec![48, 52, 55]));
        assert_eq!(chord_pitches_inner("Am7"), Some(vec![57, 60, 64, 67]));
    }

    #[test]
    fn test_chord_pitches_inner_unparseable_returns_none() {
        assert_eq!(chord_pitches_inner("XYZ-not-a-chord"), None);
        assert_eq!(chord_pitches_inner(""), None);
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
    fn chord_diagram_svg_inner_with_orientation_horizontal_marks_class() {
        let svg = chord_diagram_svg_inner_with_orientation("Am", "guitar", &[], Some("horizontal"))
            .unwrap()
            .expect("Am voicing should resolve for guitar");
        assert!(svg.contains("chord-diagram-horizontal"));
    }

    #[test]
    fn chord_diagram_svg_inner_with_orientation_defaults_match_legacy() {
        let legacy = chord_diagram_svg_inner("Am", "guitar", &[])
            .unwrap()
            .unwrap();
        let oriented = chord_diagram_svg_inner_with_orientation("Am", "guitar", &[], None)
            .unwrap()
            .unwrap();
        assert_eq!(legacy, oriented);
    }

    #[test]
    fn chord_diagram_svg_inner_with_orientation_unknown_orientation_falls_back() {
        // Sister to the wasm + ffi test of the same name: unrecognised
        // orientation strings degrade to vertical (lenient resolver
        // contract).
        let oriented =
            chord_diagram_svg_inner_with_orientation("Am", "guitar", &[], Some("nonsense"))
                .unwrap()
                .unwrap();
        assert!(!oriented.contains("chord-diagram-horizontal"));
    }
    // Note: the `#[napi]`-decorated public thunks
    // (`chord_diagram_svg_with_orientation`,
    // `chord_diagram_svg_with_defines_orientation`) cannot be exercised
    // here because the napi-sys symbols (`napi_reference_unref`,
    // `napi_delete_reference`) are only resolved by Node.js — `cargo
    // test` fails to link. Public-ABI coverage lives in
    // `crates/napi/__tests__/public-api.test.js`, which runs through
    // the actual Node-API binding and pins the same `js_name`,
    // argument order, and `Option<String>` deserialisation contract
    // the internal-helper tests above cannot reach.

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
    fn test_validate_inner_returns_empty_for_clean_input() {
        // Sister-site to wasm's `test_validate_returns_empty_for_valid_input`
        // — both bindings must report zero diagnostics on the same minimal
        // ChordPro source.
        let errors = validate_inner(MINIMAL_INPUT);
        assert!(errors.is_empty());
    }

    #[test]
    fn test_validate_inner_surfaces_unclosed_chord() {
        // `[G` without a closing bracket triggers a recoverable parse
        // error. The bindings wrapper field-maps each payload into a
        // napi `ValidationError`, so pin the payload-shape contract
        // (line >= 1, column >= 1, message mentions the failure mode)
        // here in lib.rs where the unit tests can drive every assertion.
        let errors = validate_inner("{title: Test}\n[G");
        assert!(!errors.is_empty(), "unclosed chord must produce an error");
        assert!(
            errors[0].line >= 1,
            "line should be one-based, got {}",
            errors[0].line
        );
        assert!(
            errors[0].column >= 1,
            "column should be one-based, got {}",
            errors[0].column
        );
        assert!(
            errors[0].message.contains("unclosed"),
            "error message should mention `unclosed`, got: {}",
            errors[0].message
        );
    }

    #[test]
    fn test_validate_inner_empty_input_returns_empty() {
        // The lenient parser tolerates empty input (no error). Pin the
        // contract so a future regression that emits a phantom "empty
        // document" error fails loudly here.
        let errors = validate_inner("");
        assert!(errors.is_empty());
    }

    #[test]
    fn test_validate_inner_collects_errors_across_multi_song_input() {
        // Two `{new_song}`-separated segments, each with an unclosed
        // chord, MUST produce errors from BOTH segments via
        // `result.results.into_iter().flat_map(|r| r.errors)`. A refactor
        // that collapsed the flat_map into
        // `.next().unwrap_or_default().errors` would walk only the first
        // segment's errors, dropping the second song's parse failures —
        // catastrophic for hosts that validate multi-song .cho files.
        // This input has 2 ParseResults, each with >= 1 error, so any
        // surviving entries past `.next()` proves the flat_map is intact.
        let errors = validate_inner("[G\n{new_song}\n[D");
        assert!(
            errors.len() >= 2,
            "two-segment multi-error input should flat_map errors from both \
             ParseResults; got {} (regression would surface as 1, not 2+)",
            errors.len()
        );
    }

    #[test]
    fn test_validate_defines_pairs_well_formed_succeeds() {
        let pairs = validate_defines_pairs(vec![
            vec![
                "Gsus4".to_string(),
                "base-fret 1 frets 3 3 0 0 1 3".to_string(),
            ],
            vec!["Cmaj7".to_string(), "frets x 3 2 0 0 0".to_string()],
        ])
        .unwrap();
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].0, "Gsus4");
        assert_eq!(pairs[0].1, "base-fret 1 frets 3 3 0 0 1 3");
        assert_eq!(pairs[1].0, "Cmaj7");
    }

    #[test]
    fn test_validate_defines_pairs_empty_succeeds() {
        let pairs = validate_defines_pairs(vec![]).unwrap();
        assert!(pairs.is_empty());
    }

    #[test]
    fn test_validate_defines_pairs_rejects_length_one_entry() {
        // The `Vec<Vec<String>>` shape comes from napi-rs marshalling
        // `Array<[name, raw]>`; bad inner-array length is a caller error
        // that the wrapper maps to `Status::InvalidArg`.
        let err = validate_defines_pairs(vec![vec!["Gsus4".to_string()]]).unwrap_err();
        assert!(
            err.contains("defines[0]") && err.contains("length 2") && err.contains("got length 1"),
            "error must identify the offending index and length; got: {err}"
        );
    }

    #[test]
    fn test_validate_defines_pairs_rejects_length_three_entry() {
        let err = validate_defines_pairs(vec![vec![
            "Gsus4".to_string(),
            "raw1".to_string(),
            "extra".to_string(),
        ]])
        .unwrap_err();
        assert!(
            err.contains("got length 3"),
            "error must identify the actual length; got: {err}"
        );
    }

    #[test]
    fn test_validate_defines_pairs_reports_offending_index() {
        // The error message identifies which entry in the array failed
        // validation, which is the difference between a usable JS error
        // and a generic "something is wrong".
        let err = validate_defines_pairs(vec![
            vec!["Gsus4".to_string(), "ok".to_string()],
            vec!["Cmaj7".to_string(), "ok".to_string()],
            vec!["bad".to_string()],
        ])
        .unwrap_err();
        assert!(
            err.contains("defines[2]"),
            "error must point at the offending entry (index 2); got: {err}"
        );
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
