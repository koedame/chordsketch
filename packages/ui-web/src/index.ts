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
  /**
   * Fires synchronously on every editor input event, before the
   * render debounce. Hosts use this for dirty-tracking in the
   * desktop app (#2080) — comparing the current value to the last
   * saved content to decide whether the title bar should show a
   * "modified" indicator. The browser playground has no concept
   * of unsaved state and simply omits the callback.
   */
  onChordProChange?: (value: string) => void;
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
  /**
   * Current contents of the editor. Hosts use this to drive
   * format-specific export paths that bypass the in-WebView
   * rendering — e.g. the desktop app's `File → Export PDF / HTML`
   * menu routes the source through Rust renderers (#2074) instead
   * of the WASM module, so it needs a way to read what the user
   * has typed.
   */
  getChordPro(): string;
  /**
   * Current semitone offset in the transpose control, clamped to
   * the same `[-11, 11]` window the trio and the `<input>` itself
   * enforce. Pair with {@link getChordPro} when invoking an
   * external renderer so the export matches what the preview
   * shows.
   */
  getTranspose(): number;
  /**
   * Replace the editor contents with `value`, triggering an
   * immediate render. Used by the desktop app's `File → Open`
   * flow after reading a file off disk (#2080). Does NOT fire
   * the {@link MountOptions.onChordProChange} callback — a
   * programmatic load is not a user edit, and the host is
   * responsible for resetting its own dirty-tracking state at
   * the same time it calls this.
   */
  setChordPro(value: string): void;
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
  transposeDecrementBtn: HTMLButtonElement;
  transposeIncrementBtn: HTMLButtonElement;
  transposeResetBtn: HTMLButtonElement;
  transposeLiveRegion: HTMLSpanElement;
  mainEl: HTMLElement;
  editorPane: HTMLDivElement;
  splitter: HTMLDivElement;
  preview: HTMLIFrameElement;
  textOutput: HTMLPreElement;
  pdfPane: HTMLDivElement;
  downloadPdfBtn: HTMLButtonElement;
  errorDiv: HTMLDivElement;
}

// Range is `-11..=11` — matches the `@chordsketch/react`
// `<Transpose>` default. A full octave (`±12`) is the identity
// transposition, so the interesting values stop at ±11.
const TRANSPOSE_MIN = -11;
const TRANSPOSE_MAX = 11;
const TRANSPOSE_RESET = 0;

/**
 * Signed, human-readable semitone offset for the accessibility
 * live region. Matches the format emitted by the `<Transpose>`
 * React component's default `formatValue`, plus an explicit
 * "semitones" suffix so a screen-reader announcement of `"+3"`
 * alone is not ambiguous out of context.
 */
function formatTransposeForAnnouncement(n: number): string {
  if (n === 0) return '0 semitones';
  return `${n > 0 ? '+' : ''}${n} semitones`;
}

// Split-pane ratio bounds. 15/85 keeps a usable slice of the
// editor and preview visible at each extreme — a 0/100 drag
// would hide one pane entirely, which users can't recover from
// without the keyboard fallback or clearing localStorage.
const SPLIT_RATIO_MIN = 0.15;
const SPLIT_RATIO_MAX = 0.85;
const SPLIT_RATIO_DEFAULT = 0.5;
const SPLIT_RATIO_STEP = 0.02; // 2 % per arrow keypress
const SPLIT_RATIO_STORAGE_KEY = 'chordsketch-ui-split-ratio';

/**
 * Clamp + validate a numeric string from `localStorage`. Returns
 * `null` for invalid or out-of-range values so the caller falls
 * back to {@link SPLIT_RATIO_DEFAULT} and re-persists a clean
 * value on the next drag.
 */
function parseStoredSplitRatio(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  if (n < SPLIT_RATIO_MIN || n > SPLIT_RATIO_MAX) return null;
  return n;
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

  // Full `role="group"` button trio matching the `<Transpose>` React
  // component in `@chordsketch/react`. Landed in #2070; supersedes
  // the pre-#2070 scope limit that kept this to a bare `<input>` to
  // avoid visual regression. The `role="group"` + `aria-label` pair
  // gives assistive tech one labelled cluster for the three
  // controls; each button still carries its own `aria-label` so a
  // screen reader reading one button in isolation announces what
  // it does, not just "button".
  const transposeGroup = document.createElement('div');
  transposeGroup.className = 'transpose-group';
  transposeGroup.setAttribute('role', 'group');
  transposeGroup.setAttribute('aria-label', 'Transpose');

  const transposeLabelText = document.createElement('span');
  transposeLabelText.className = 'transpose-group-label';
  transposeLabelText.textContent = 'Transpose:';
  // The surrounding group already carries aria-label="Transpose";
  // hide this text from assistive tech so screen readers do not
  // read the word twice when focus enters the group.
  transposeLabelText.setAttribute('aria-hidden', 'true');

  const transposeDecrementBtn = document.createElement('button');
  transposeDecrementBtn.type = 'button';
  transposeDecrementBtn.className = 'transpose-step';
  transposeDecrementBtn.textContent = '−'; // MINUS SIGN (matches `<Transpose>`)
  transposeDecrementBtn.setAttribute('aria-label', 'Decrease transpose by 1 semitone');

  const transposeInput = document.createElement('input');
  transposeInput.type = 'number';
  transposeInput.id = 'transpose';
  transposeInput.value = String(TRANSPOSE_RESET);
  transposeInput.min = String(TRANSPOSE_MIN);
  transposeInput.max = String(TRANSPOSE_MAX);
  transposeInput.setAttribute('aria-label', 'Transpose in semitones');

  const transposeIncrementBtn = document.createElement('button');
  transposeIncrementBtn.type = 'button';
  transposeIncrementBtn.className = 'transpose-step';
  transposeIncrementBtn.textContent = '+';
  transposeIncrementBtn.setAttribute('aria-label', 'Increase transpose by 1 semitone');

  const transposeResetBtn = document.createElement('button');
  transposeResetBtn.type = 'button';
  // Starts hidden because the initial value is `TRANSPOSE_RESET`;
  // visibility is kept in sync by `updateTransposeControls` below.
  transposeResetBtn.className = 'transpose-reset hidden';
  transposeResetBtn.textContent = 'Reset';
  transposeResetBtn.setAttribute('aria-label', 'Reset transpose to 0');

  // Visually-hidden live region that announces the current offset
  // on every value change. Matches the role of the `<output
  // aria-live="polite">` in the React `<Transpose>` component;
  // kept as a separate `<span>` here because ui-web retains an
  // editable `<input>` for direct numeric entry, which `<output>`
  // cannot be.
  const transposeLiveRegion = document.createElement('span');
  transposeLiveRegion.className = 'sr-only';
  transposeLiveRegion.setAttribute('aria-live', 'polite');
  transposeLiveRegion.setAttribute('aria-atomic', 'true');
  transposeLiveRegion.textContent = formatTransposeForAnnouncement(TRANSPOSE_RESET);

  transposeGroup.append(
    transposeLabelText,
    transposeDecrementBtn,
    transposeInput,
    transposeIncrementBtn,
    transposeResetBtn,
    transposeLiveRegion,
  );

  controls.append(formatLabel, transposeGroup);
  header.appendChild(controls);

  const main = document.createElement('main');

  const editorPane = document.createElement('div');
  editorPane.id = 'editor-pane';
  editorPane.className = 'pane editor-pane';
  const editor = document.createElement('textarea');
  editor.id = 'editor';
  editor.spellcheck = false;
  editor.placeholder = 'Enter ChordPro here...';
  editorPane.appendChild(editor);

  // Draggable splitter between the editor and the preview. Follows
  // the W3C APG Window Splitter pattern:
  //   https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
  // `role="separator"` + `aria-orientation="vertical"` identifies
  // it as a resize handle; `aria-controls` points at the pane it
  // grows/shrinks; `aria-valuenow/min/max` carry the percentage
  // state so assistive tech announces the offset. Keyboard
  // resizing (`ArrowLeft`/`ArrowRight` on focus) is wired in
  // `mountChordSketchUi` below — this is element-local widget
  // interaction (not a global accelerator), so it is in scope
  // even while global desktop shortcuts remain deferred.
  const splitter = document.createElement('div');
  splitter.className = 'splitter';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-controls', 'editor-pane');
  splitter.setAttribute('aria-label', 'Resize editor and preview panes');
  splitter.tabIndex = 0;

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

  main.append(editorPane, splitter, outputPane);
  root.append(header, main);

  return {
    editor,
    formatSelect,
    transposeInput,
    transposeDecrementBtn,
    transposeIncrementBtn,
    transposeResetBtn,
    transposeLiveRegion,
    mainEl: main,
    editorPane,
    splitter,
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
    onChordProChange,
  } = options;

  if (documentTitle !== undefined) {
    document.title = documentTitle;
  }

  const nodes = buildDom(root, title);
  const {
    editor,
    formatSelect,
    transposeInput,
    transposeDecrementBtn,
    transposeIncrementBtn,
    transposeResetBtn,
    transposeLiveRegion,
    mainEl,
    editorPane,
    splitter,
    preview,
    textOutput,
    pdfPane,
    downloadPdfBtn,
    errorDiv,
  } = nodes;

  // Apply the persisted split ratio (if any) before the initial
  // paint so the panes open at the stored proportion rather than
  // flashing through the 50/50 default on every launch.
  let splitRatio = SPLIT_RATIO_DEFAULT;
  try {
    const stored = parseStoredSplitRatio(
      window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY),
    );
    if (stored !== null) splitRatio = stored;
  } catch {
    // localStorage can throw (Safari private mode, disabled cookies,
    // sandboxed iframe). The default ratio is still usable, so
    // silently fall through — persistence is a convenience, not a
    // correctness requirement.
  }

  const applySplitRatio = (next: number): void => {
    const clamped = Math.max(
      SPLIT_RATIO_MIN,
      Math.min(SPLIT_RATIO_MAX, next),
    );
    splitRatio = clamped;
    // CSS custom property on `<main>` — the `@media (max-width: 768px)`
    // rule in `style.css` overrides the flex on narrow viewports so
    // the drag-to-resize ratio only takes effect in the desktop-style
    // two-column layout.
    mainEl.style.setProperty('--editor-ratio', String(clamped));
    splitter.setAttribute(
      'aria-valuenow',
      String(Math.round(clamped * 100)),
    );
  };

  const persistSplitRatio = (): void => {
    try {
      window.localStorage.setItem(
        SPLIT_RATIO_STORAGE_KEY,
        splitRatio.toFixed(3),
      );
    } catch {
      // See note in the initial load — persistence failure is a
      // convenience loss, not a correctness failure.
    }
  };

  splitter.setAttribute('aria-valuemin', String(Math.round(SPLIT_RATIO_MIN * 100)));
  splitter.setAttribute('aria-valuemax', String(Math.round(SPLIT_RATIO_MAX * 100)));
  applySplitRatio(splitRatio);

  let splitterDragActive = false;

  const onSplitterPointerDown = (ev: PointerEvent): void => {
    // Only primary-button drags (mouse button 0 / touch / pen).
    if (ev.button !== 0) return;
    ev.preventDefault();
    splitterDragActive = true;
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add('dragging');
    // Disable text selection on the document while dragging so
    // mid-drag mouse moves over the editor don't hijack text
    // selection.
    document.body.style.userSelect = 'none';
  };

  const onSplitterPointerMove = (ev: PointerEvent): void => {
    if (!splitterDragActive) return;
    const rect = mainEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (ev.clientX - rect.left) / rect.width;
    applySplitRatio(ratio);
  };

  const onSplitterPointerUp = (ev: PointerEvent): void => {
    if (!splitterDragActive) return;
    splitterDragActive = false;
    if (splitter.hasPointerCapture(ev.pointerId)) {
      splitter.releasePointerCapture(ev.pointerId);
    }
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    persistSplitRatio();
  };

  // Widget-local keyboard resizing when the splitter has focus,
  // per the W3C APG Window Splitter pattern: ArrowLeft/Right step
  // by `SPLIT_RATIO_STEP`, Home/End jump to the min/max. These
  // are NOT global shortcuts — they only fire when the separator
  // itself has keyboard focus — so they do not conflict with the
  // deferred global-shortcut scope (#2190).
  const onSplitterKeyDown = (ev: KeyboardEvent): void => {
    let next: number | null = null;
    switch (ev.key) {
      case 'ArrowLeft':
        next = splitRatio - SPLIT_RATIO_STEP;
        break;
      case 'ArrowRight':
        next = splitRatio + SPLIT_RATIO_STEP;
        break;
      case 'Home':
        next = SPLIT_RATIO_MIN;
        break;
      case 'End':
        next = SPLIT_RATIO_MAX;
        break;
      default:
        return;
    }
    ev.preventDefault();
    applySplitRatio(next);
    persistSplitRatio();
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const getTranspose = (): number => {
    const val = parseInt(transposeInput.value, 10);
    // Clamp to `TRANSPOSE_MIN..=TRANSPOSE_MAX`. Empty/non-numeric
    // input (`NaN`) falls back to the reset value so a mid-edit
    // cleared field doesn't crash renderers downstream.
    return isNaN(val)
      ? TRANSPOSE_RESET
      : Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, val));
  };

  // Sync the three button states + the live-region announcement
  // to the current clamped offset. Mirrors the `<Transpose>` React
  // component's `disabled`-at-boundary + `<output aria-live>` rule
  // so a screen-reader user driving the trio via buttons hears the
  // new offset and can feel the hard stop at ±11.
  const updateTransposeControls = (): void => {
    const v = getTranspose();
    transposeDecrementBtn.disabled = v <= TRANSPOSE_MIN;
    transposeIncrementBtn.disabled = v >= TRANSPOSE_MAX;
    transposeResetBtn.classList.toggle('hidden', v === TRANSPOSE_RESET);
    transposeLiveRegion.textContent = formatTransposeForAnnouncement(v);
  };

  // Set the transpose field to `next`, clamped to the documented
  // range, and schedule a rerender. Setting `value` via JS does
  // NOT fire `input` events, so the control-sync helper and
  // debounced render must be invoked explicitly. Mirrors the
  // behaviour of the `<Transpose>` React component's `onChange`
  // callback.
  const setTranspose = (next: number): void => {
    const clamped = Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, next));
    transposeInput.value = String(clamped);
    updateTransposeControls();
    scheduleRender();
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
        // Appending to the document is required in some browsers
        // (notably Firefox) for `click()` to actually dispatch
        // the download event. Removing the element after the
        // click keeps the DOM clean. Mirrors the
        // `triggerDownload` helper in
        // `packages/react/src/use-pdf-export.ts`. (#2179)
        document.body.appendChild(a);
        try {
          a.click();
        } finally {
          a.remove();
        }
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

  const onEditorInput = (): void => {
    onChordProChange?.(editor.value);
    scheduleRender();
  };

  const onTransposeInput = (): void => {
    updateTransposeControls();
    scheduleRender();
  };
  const onTransposeDecrement = (): void => {
    setTranspose(getTranspose() - 1);
  };
  const onTransposeIncrement = (): void => {
    setTranspose(getTranspose() + 1);
  };
  const onTransposeReset = (): void => {
    setTranspose(TRANSPOSE_RESET);
  };

  editor.addEventListener('input', onEditorInput);
  formatSelect.addEventListener('change', render);
  transposeInput.addEventListener('input', onTransposeInput);
  transposeDecrementBtn.addEventListener('click', onTransposeDecrement);
  transposeIncrementBtn.addEventListener('click', onTransposeIncrement);
  transposeResetBtn.addEventListener('click', onTransposeReset);
  splitter.addEventListener('pointerdown', onSplitterPointerDown);
  splitter.addEventListener('pointermove', onSplitterPointerMove);
  splitter.addEventListener('pointerup', onSplitterPointerUp);
  splitter.addEventListener('pointercancel', onSplitterPointerUp);
  splitter.addEventListener('keydown', onSplitterKeyDown);
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
      editor.removeEventListener('input', onEditorInput);
      formatSelect.removeEventListener('change', render);
      transposeInput.removeEventListener('input', onTransposeInput);
      transposeDecrementBtn.removeEventListener('click', onTransposeDecrement);
      transposeIncrementBtn.removeEventListener('click', onTransposeIncrement);
      transposeResetBtn.removeEventListener('click', onTransposeReset);
      splitter.removeEventListener('pointerdown', onSplitterPointerDown);
      splitter.removeEventListener('pointermove', onSplitterPointerMove);
      splitter.removeEventListener('pointerup', onSplitterPointerUp);
      splitter.removeEventListener('pointercancel', onSplitterPointerUp);
      splitter.removeEventListener('keydown', onSplitterKeyDown);
      downloadPdfBtn.removeEventListener('click', downloadPdf);
    },
    getChordPro(): string {
      return editor.value;
    },
    getTranspose(): number {
      return getTranspose();
    },
    setChordPro(value: string): void {
      editor.value = value;
      // Immediate render (not `scheduleRender`) because programmatic
      // loads are discrete events — users expect the preview to
      // reflect the loaded file without a 300ms debounce delay.
      render();
    },
  };
}
