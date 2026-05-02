import init, {
  render_text,
  render_pdf,
  render_text_with_options,
  render_pdf_with_options,
  render_html_body,
  render_html_body_with_options,
  render_html_css,
  render_html_css_with_options,
  renderIrealSvg,
} from '@chordsketch/wasm';
import { mountChordSketchUi, type Renderers } from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';

// Adapter from the wasm-bindgen export shape to the ui-web `Renderers`
// interface. The text and pdf branches preserve the no-options
// overload (used when `transpose === 0`) so the common no-transpose
// path doesn't allocate an options object — matches the original
// playground behaviour and keeps render-pdf's binary output
// deterministic against the pre-extraction baseline. The HTML branch
// always routes through `composeHtmlBody` because it has to combine
// two wasm calls (body + CSS) regardless.
//
// `renderHtml` returns a body-only fragment (`<style>` + `<div
// class="song">`) rather than the full document `render_html` emits.
// ui-web's `HTML_FRAME_TEMPLATE` then wraps that fragment in exactly
// one `<!DOCTYPE>` / `<html>` / `<body>`. Pre-#2321 the playground
// passed the full document through and ui-web wrapped it again,
// producing two `<!DOCTYPE>` / `<head>` / `<body>` pairs in `srcdoc`
// that survived only via HTML5 nested-document recovery — and
// triggered "Blocked script execution in 'about:blank'" warnings on
// some Chrome configurations. See #2321 §Background.
//
// `render_html_css()` allocates a String across the ABI boundary on
// each call but is byte-stable across the build (the VS Code
// extension uses the same single-call caching strategy). The cache
// only applies when `options.config` is unset; with a config, body
// and CSS must be computed against the same options or class hooks
// in the body can drift from selectors in the CSS.
//
// IMPORTANT: do NOT cache the result of a thrown
// `render_html_css_with_options(options)` call. The current `render_html_css()`
// is infallible (returns `String`, not `Result`), but the with-options
// variant returns `Result<String, JsValue>`. A future refactor that
// wraps the no-options path in a `try` MUST re-throw — silently
// caching empty CSS would produce unstyled output with no error
// surfaced.
let _cachedHtmlCss: string | null = null;
const composeHtmlBody = (
  input: string,
  options?: { transpose?: number; config?: string },
): string => {
  const body = options
    ? render_html_body_with_options(input, options)
    : render_html_body(input);
  // Top-level `<style>` is permitted at the start of the fragment per
  // the `Renderers.renderHtml` contract; ui-web does not strip it.
  const css = options?.config !== undefined
    ? render_html_css_with_options(options)
    : (_cachedHtmlCss ??= render_html_css());
  return `<style>${css}</style>${body}`;
};

const renderers: Renderers = {
  init: () => init(),
  renderHtml: (input, options) => composeHtmlBody(input, options),
  renderText: (input, options) =>
    options ? render_text_with_options(input, options) : render_text(input),
  renderPdf: (input, options) =>
    options ? render_pdf_with_options(input, options) : render_pdf(input),
  // The wasm `renderIrealSvg` ignores transpose / config (the iReal
  // pipeline emits a static SVG chart); ui-web's contract still
  // forwards `options`, so we accept and discard the second arg.
  // The export is camelCased via `#[wasm_bindgen(js_name = renderIrealSvg)]`
  // in `crates/wasm/src/lib.rs`; the snake_case `renderText` / `renderPdf`
  // siblings keep their Rust names because they predate the
  // `js_name` rename convention.
  renderSvg: (input) => renderIrealSvg(input),
};

const root = document.getElementById('app');
if (!root) {
  throw new Error('Playground entry point #app element missing from index.html');
}

void mountChordSketchUi(root, { renderers });
