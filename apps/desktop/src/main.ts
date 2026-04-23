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
// interface. Mirrors `packages/playground/src/main.ts` so the desktop
// WebView and the browser playground share the same render pipeline;
// keeping the no-options overloads avoids an unused options object on
// the common `transpose === 0` path, matching the playground's
// pre-extraction rendering baseline.
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
  throw new Error('Desktop entry point #app element missing from index.html');
}

void mountChordSketchUi(root, {
  renderers,
  title: 'ChordSketch',
  documentTitle: 'ChordSketch',
});
