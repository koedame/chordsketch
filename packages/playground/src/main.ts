import init, {
  render_html,
  render_text,
  render_pdf,
  render_html_with_options,
  render_text_with_options,
  render_pdf_with_options,
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
const renderers: Renderers = {
  init: () => init(),
  renderHtml: (input, options) =>
    options ? render_html_with_options(input, options) : render_html(input),
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
