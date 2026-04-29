import init, {
  render_text,
  render_pdf,
  render_text_with_options,
  render_pdf_with_options,
  render_html_body,
  render_html_body_with_options,
  render_html_css,
} from '@chordsketch/wasm';
import { mountChordSketchUi, type Renderers } from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';

// Adapter from the wasm-bindgen export shape to the ui-web `Renderers`
// interface. The thin wrapper exists so the wasm functions can keep
// their no-options overload (used when `transpose` is 0) — calling the
// `_with_options` variants for every render would still be correct but
// avoiding an unused options object matches the original playground
// behaviour and keeps render-pdf's binary output deterministic against
// the pre-extraction baseline.
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
const composeHtmlBody = (input: string, options?: { transpose?: number; config?: string }): string => {
  const body = options
    ? render_html_body_with_options(input, options)
    : render_html_body(input);
  return `<style>${render_html_css()}</style>${body}`;
};

const renderers: Renderers = {
  init: () => init(),
  renderHtml: (input, options) => composeHtmlBody(input, options),
  renderText: (input, options) =>
    options ? render_text_with_options(input, options) : render_text(input),
  renderPdf: (input, options) =>
    options ? render_pdf_with_options(input, options) : render_pdf(input),
};

const root = document.getElementById('app');
if (!root) {
  throw new Error('Playground entry point #app element missing from index.html');
}

void mountChordSketchUi(root, { renderers });
