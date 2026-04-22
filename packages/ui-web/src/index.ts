// Framework-agnostic ChordSketch playground UI.
//
// `mountChordSketchUi` builds the editor + controls + preview panes from
// scratch inside the supplied `root` element, so the host (browser
// playground or Tauri WebView desktop app) only needs to provide a
// container and a renderer implementation.
//
// Renderers are injected so that ui-web does not bake in a dependency on
// `@chordsketch/wasm`. The browser playground passes the wasm-bindgen
// functions; a desktop host could instead route through a native binary
// over IPC and supply the same shape.

import { SAMPLE_CHORDPRO } from './sample';

export { SAMPLE_CHORDPRO };

export interface RenderOptions {
  transpose?: number;
  config?: string;
}

export interface Renderers {
  /**
   * Initialise the renderer backend (e.g. fetch + instantiate the WASM
   * module). Called exactly once before any render call. Resolves on
   * success; rejection is surfaced as an init-time error in the UI.
   */
  init(): Promise<unknown>;
  renderHtml(input: string, options?: RenderOptions): string;
  renderText(input: string, options?: RenderOptions): string;
  renderPdf(input: string, options?: RenderOptions): Uint8Array;
}

export interface MountOptions {
  /** Renderer backend (browser injects `@chordsketch/wasm`). */
  renderers: Renderers;
  /** Initial ChordPro content. Defaults to {@link SAMPLE_CHORDPRO}. */
  initialChordPro?: string;
  /**
   * Filename used for the PDF download. Defaults to
   * `chordsketch-output.pdf`.
   */
  pdfFilename?: string;
  /** Heading text shown in the header bar. Defaults to "ChordSketch Playground". */
  title?: string;
  /** Document `<title>` to set on mount. If omitted, the document title is left alone. */
  documentTitle?: string;
}

/**
 * Handle returned by {@link mountChordSketchUi}. Hosts that need to tear
 * the UI down (e.g. a Tauri WebView reset, a tab switch in a desktop
 * shell, a Vite HMR replacement) call `destroy()` to cancel the pending
 * debounce timer and remove the event listeners attached during mount.
 *
 * Hosts that mount once and never unmount (the browser playground today)
 * may safely ignore the return value.
 */
export interface ChordSketchUiHandle {
  destroy(): void;
}

const RENDER_DEBOUNCE_MS = 300;

const HTML_FRAME_TEMPLATE = (body: string): string => `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 1.5rem;
    line-height: 1.6;
    color: #333;
  }
  .chord { color: #e94560; font-weight: bold; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; color: #666; margin-bottom: 1rem; }
  section { margin-bottom: 1rem; }
  .song-separator { border-top: 2px solid #ddd; margin: 2rem 0; }
</style>
</head>
<body>${body}</body>
</html>`;

interface UiNodes {
  editor: HTMLTextAreaElement;
  formatSelect: HTMLSelectElement;
  transposeInput: HTMLInputElement;
  preview: HTMLIFrameElement;
  textOutput: HTMLPreElement;
  pdfPane: HTMLDivElement;
  downloadPdfBtn: HTMLButtonElement;
  errorDiv: HTMLDivElement;
}

/**
 * Build the playground DOM inside `root`. The previous contents of `root`
 * are removed; structure mirrors the original `packages/playground/index.html`
 * markup byte-for-byte so visual regression versus the pre-extraction
 * playground is empty.
 */
function buildDom(root: HTMLElement, title: string): UiNodes {
  // The iframe sandbox is intentionally restrictive — empty `sandbox`
  // would block scripts/forms/storage so the rendered HTML cannot run JS
  // or steal cookies. We do allow popups so anchor clicks (e.g. from
  // {link} or chord-diagram image maps) can open in a new tab. See #1058.
  root.innerHTML = '';

  const header = document.createElement('header');
  const h1 = document.createElement('h1');
  h1.textContent = title;
  header.appendChild(h1);

  const controls = document.createElement('div');
  controls.className = 'controls';

  const formatLabel = document.createElement('label');
  formatLabel.append('Format: ');
  const formatSelect = document.createElement('select');
  formatSelect.id = 'format';
  for (const [value, label, selected] of [
    ['html', 'HTML', true],
    ['text', 'Text', false],
    ['pdf', 'PDF', false],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (selected) opt.selected = true;
    formatSelect.appendChild(opt);
  }
  formatLabel.appendChild(formatSelect);

  // Wrap the transpose input in a group with an accessible name so
  // assistive tech surfaces the role of the field distinct from
  // the surrounding format control. The visible `<label>` provides
  // the accessible name via DOM association; the redundant
  // `aria-label` on the input itself is a safety net for screen
  // readers that prioritise it over the associated label text.
  // Partial parity with the `<Transpose>` React component in
  // `@chordsketch/react` (#2150) — a full `role=\"group\"` button
  // trio would change the playground UX visually, so this scope
  // is limited to named input + documented range.
  const transposeLabel = document.createElement('label');
  transposeLabel.append('Transpose: ');
  const transposeInput = document.createElement('input');
  transposeInput.type = 'number';
  transposeInput.id = 'transpose';
  transposeInput.value = '0';
  // Range is `-11..=11` — matches the `@chordsketch/react`
  // `<Transpose>` default. A full octave (`±12`) is the identity
  // transposition, so the interesting values stop at ±11.
  transposeInput.min = '-11';
  transposeInput.max = '11';
  transposeInput.setAttribute('aria-label', 'Transpose in semitones');
  transposeLabel.appendChild(transposeInput);

  controls.append(formatLabel, transposeLabel);
  header.appendChild(controls);

  const main = document.createElement('main');

  const editorPane = document.createElement('div');
  editorPane.className = 'pane editor-pane';
  const editor = document.createElement('textarea');
  editor.id = 'editor';
  editor.spellcheck = false;
  editor.placeholder = 'Enter ChordPro here...';
  editorPane.appendChild(editor);

  const outputPane = document.createElement('div');
  outputPane.className = 'pane output-pane';

  const errorDiv = document.createElement('div');
  errorDiv.id = 'error';
  errorDiv.className = 'error hidden';

  const preview = document.createElement('iframe');
  preview.id = 'preview';
  preview.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  preview.title = 'Rendered output';

  const textOutput = document.createElement('pre');
  textOutput.id = 'text-output';
  textOutput.className = 'hidden';

  const pdfPane = document.createElement('div');
  pdfPane.id = 'pdf-pane';
  pdfPane.className = 'hidden';
  const pdfHint = document.createElement('p');
  pdfHint.textContent = 'Click the button to generate and download a PDF.';
  const downloadPdfBtn = document.createElement('button');
  downloadPdfBtn.id = 'download-pdf';
  downloadPdfBtn.textContent = 'Download PDF';
  pdfPane.append(pdfHint, downloadPdfBtn);

  outputPane.append(errorDiv, preview, textOutput, pdfPane);

  main.append(editorPane, outputPane);
  root.append(header, main);

  return {
    editor,
    formatSelect,
    transposeInput,
    preview,
    textOutput,
    pdfPane,
    downloadPdfBtn,
    errorDiv,
  };
}

/**
 * Format a thrown value into a readable error message. `String(e)` flattens
 * structured errors (e.g. JsError objects with line/col info) to "[object
 * Object]"; preferring `e.message` when available preserves the underlying
 * Rust error string. See #1060.
 *
 * `String(s)` is the identity function for strings, so a separate
 * `typeof e === 'string'` branch is unnecessary — `String(e)` already
 * returns it unchanged. See #1087.
 */
function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Mount the ChordSketch playground UI into `root`. Returns a handle whose
 * `destroy()` method cancels any pending render debounce and detaches the
 * event listeners added during mount; resolves once the renderer backend
 * is initialised and the first render has been run. Rejects if
 * `renderers.init()` rejects (the host is responsible for surfacing that
 * to the user, e.g. via console).
 *
 * Calling `mountChordSketchUi` replaces the contents of `root`.
 */
export async function mountChordSketchUi(
  root: HTMLElement,
  options: MountOptions,
): Promise<ChordSketchUiHandle> {
  const {
    renderers,
    initialChordPro = SAMPLE_CHORDPRO,
    pdfFilename = 'chordsketch-output.pdf',
    title = 'ChordSketch Playground',
    documentTitle,
  } = options;

  if (documentTitle !== undefined) {
    document.title = documentTitle;
  }

  const nodes = buildDom(root, title);
  const {
    editor,
    formatSelect,
    transposeInput,
    preview,
    textOutput,
    pdfPane,
    downloadPdfBtn,
    errorDiv,
  } = nodes;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const getTranspose = (): number => {
    const val = parseInt(transposeInput.value, 10);
    // Clamp to the same `[-11, 11]` window as the input's own
    // HTML `min`/`max`, matching the `@chordsketch/react`
    // `<Transpose>` default — a full octave (`±12`) is the
    // identity transposition, so the interesting values stop
    // at ±11.
    return isNaN(val) ? 0 : Math.max(-11, Math.min(11, val));
  };

  const showError = (msg: string): void => {
    errorDiv.textContent = msg;
    errorDiv.classList.remove('hidden');
  };

  const hideError = (): void => {
    errorDiv.classList.add('hidden');
  };

  const showPane = (pane: 'html' | 'text' | 'pdf'): void => {
    preview.classList.toggle('hidden', pane !== 'html');
    textOutput.classList.toggle('hidden', pane !== 'text');
    pdfPane.classList.toggle('hidden', pane !== 'pdf');
  };

  const render = (): void => {
    const input = editor.value;
    if (!input.trim()) {
      hideError();
      showPane('html');
      preview.srcdoc = '';
      textOutput.textContent = '';
      return;
    }

    const format = formatSelect.value;
    const transpose = getTranspose();
    const renderOpts: RenderOptions | undefined =
      transpose !== 0 ? { transpose } : undefined;

    try {
      if (format === 'html') {
        showPane('html');
        const html = renderOpts
          ? renderers.renderHtml(input, renderOpts)
          : renderers.renderHtml(input);
        preview.srcdoc = HTML_FRAME_TEMPLATE(html);
        hideError();
      } else if (format === 'text') {
        showPane('text');
        const text = renderOpts
          ? renderers.renderText(input, renderOpts)
          : renderers.renderText(input);
        textOutput.textContent = text;
        hideError();
      } else if (format === 'pdf') {
        showPane('pdf');
        hideError();
      } else {
        // Forward-safety guard: `formatSelect.value` is typed as `string`
        // by the DOM, so adding a new <option> in `buildDom` without a
        // matching arm here would silently no-op (blank pane, no error).
        // Surfacing the unknown value as an error makes that mismatch
        // visible at development time. Filed via #2130.
        showError(`Unknown format selected: ${format}`);
      }
    } catch (e) {
      showError(formatError(e));
    }
  };

  const downloadPdf = (): void => {
    const input = editor.value;
    if (!input.trim()) return;

    const transpose = getTranspose();
    const renderOpts: RenderOptions | undefined =
      transpose !== 0 ? { transpose } : undefined;

    try {
      const pdfBytes = renderOpts
        ? renderers.renderPdf(input, renderOpts)
        : renderers.renderPdf(input);
      const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = pdfFilename;
        a.click();
      } finally {
        // Revoke inside `finally` so a throwing `a.click()`
        // (adversarial / unusual browser state) does not leak
        // the object URL. Mirrors the defensive pattern in
        // `packages/react/src/use-pdf-export.ts`. (#2144)
        URL.revokeObjectURL(url);
      }
      hideError();
    } catch (e) {
      showError(formatError(e));
    }
  };

  const scheduleRender = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(render, RENDER_DEBOUNCE_MS);
  };

  try {
    await renderers.init();
  } catch (e) {
    showError(`Failed to initialise renderer: ${formatError(e)}`);
    throw e;
  }

  editor.value = initialChordPro;

  editor.addEventListener('input', scheduleRender);
  formatSelect.addEventListener('change', render);
  transposeInput.addEventListener('input', scheduleRender);
  downloadPdfBtn.addEventListener('click', downloadPdf);

  render();

  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      editor.removeEventListener('input', scheduleRender);
      formatSelect.removeEventListener('change', render);
      transposeInput.removeEventListener('input', scheduleRender);
      downloadPdfBtn.removeEventListener('click', downloadPdf);
    },
  };
}
