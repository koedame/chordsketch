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

import { SAMPLE_CHORDPRO, SAMPLE_IREALB } from './sample';

export { SAMPLE_CHORDPRO, SAMPLE_IREALB };

export interface RenderOptions {
  transpose?: number;
  config?: string;
}

export interface Renderers {
  /**
   * Initialise the renderer backend (e.g. fetch + instantiate the WASM
   * module). Called exactly once before any render call AND before the
   * mount-time {@link MountOptions.createEditor} factory is invoked,
   * so an editor adapter MAY safely call into wasm-backed renderer
   * helpers from its constructor (e.g. `parseIrealb` /
   * `serializeIrealb` exposed via the same wasm bundle that the
   * renderers consume). Resolves on success; on rejection
   * `mountChordSketchUi` shows the message in the in-page error
   * banner (the layout scaffold is built first so the banner is
   * visible) and re-throws so the host promise also sees it. See
   * #2397 for the regression that motivated the ordering.
   */
  init(): Promise<unknown>;
  /**
   * Render `input` as a **body fragment** — not a full HTML document.
   * ui-web wraps the returned string in a minimal `<!DOCTYPE html>…</html>`
   * envelope via `HTML_FRAME_TEMPLATE` before setting `iframe.srcdoc`.
   *
   * The returned string MUST NOT include `<!DOCTYPE>`, `<html>`, `<head>`,
   * or outer `<body>` tags. A top-level `<style>` element at the start of
   * the fragment IS permitted and is the recommended way to inject
   * host-supplied styling (the playground prepends `render_html_css()`
   * this way). Returning a full document will produce a double-wrapped
   * `srcdoc` and may cause rendering defects on some browsers (see #2321).
   */
  renderHtml(input: string, options?: RenderOptions): string;
  renderText(input: string, options?: RenderOptions): string;
  renderPdf(input: string, options?: RenderOptions): Uint8Array;
  /**
   * Render `input` as an SVG fragment. Optional — only hosts that
   * also expose iReal Pro support need to provide this.
   *
   * When present, ui-web routes editor content that starts with
   * `irealb://` or `irealbook://` through this renderer instead of
   * the ChordPro path: the returned SVG document is wrapped in
   * `HTML_FRAME_TEMPLATE` and assigned to the preview iframe
   * `srcdoc`, regardless of the current `format` selector. The
   * `format` selector continues to govern ChordPro inputs as before.
   *
   * The implementation is expected to return a complete SVG
   * document (including the leading `<?xml ?>` PI). When the
   * helper is absent, ui-web falls back to the existing ChordPro
   * pipeline so a host that does not bundle the iReal renderer
   * keeps the pre-#2362 behaviour byte-for-byte.
   *
   * `options.transpose` is forwarded but the upstream iReal
   * pipeline (`chordsketch_render_ireal::render_svg`) currently
   * ignores it — iReal charts emit a fixed-key SVG. Hosts MAY
   * surface a "transpose ignored for iReal input" hint when the
   * editor flips to iReal mode; the playground and desktop
   * adapters today do not. (#2362)
   */
  renderSvg?(input: string, options?: RenderOptions): string;
}

/**
 * Minimal editor contract ui-web depends on. The default factory
 * (`defaultTextareaEditor` below) wraps a `<textarea>` and gives
 * the playground its current behaviour byte-for-byte. Desktop hosts
 * inject a CodeMirror-based implementation (see #2072) without
 * pulling CodeMirror into the framework-agnostic ui-web bundle.
 */
export interface EditorAdapter {
  /**
   * Root DOM element for the editor. ui-web appends it inside the
   * editor pane and relies on `flex: 1` to fill the pane height.
   */
  element: HTMLElement;
  /** Current text content. Called on every render + export. */
  getValue(): string;
  /**
   * Replace the full editor content. Called on mount
   * (`initialChordPro`) and programmatic loads
   * ({@link ChordSketchUiHandle.setChordPro}). Implementations must
   * NOT fire the change handler registered via {@link onChange} for
   * these calls — a load is not a user edit, and the host resets
   * its own dirty-tracking state at the same call site.
   */
  setValue(value: string): void;
  /**
   * Subscribe to user-initiated value changes. Fires synchronously
   * on every keystroke (or CodeMirror transaction). Returns an
   * unsubscribe function which ui-web calls from `destroy()`.
   */
  onChange(handler: (value: string) => void): () => void;
  /** Move keyboard focus to the editor. Optional. */
  focus?(): void;
  /**
   * Release any editor-owned resources (CodeMirror views, tree
   * parsers, etc.). Called from `ChordSketchUiHandle.destroy()`.
   */
  destroy(): void;
}

export interface EditorFactoryOptions {
  /** Value to seed the editor with on creation. */
  initialValue: string;
  /** Placeholder rendered while the editor is empty. */
  placeholder?: string;
}

/**
 * Produces an {@link EditorAdapter} mounted inside the editor pane.
 * Called exactly once per `mountChordSketchUi` call, after
 * {@link Renderers.init} has resolved and before the first render —
 * factories may synchronously invoke wasm-backed helpers from the
 * renderer bundle in their constructor. {@link
 * ChordSketchUiHandle.replaceEditor} uses the same type and
 * naturally satisfies the same precondition.
 *
 * Passing `undefined` to {@link MountOptions.createEditor} selects
 * the built-in `<textarea>` implementation.
 */
export type EditorFactory = (options: EditorFactoryOptions) => EditorAdapter;

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
  /**
   * Custom editor factory. Defaults to a plain `<textarea>` that
   * matches the pre-#2072 playground exactly. The desktop app
   * injects a CodeMirror-based factory so ui-web stays
   * framework-agnostic and the playground bundle does not need to
   * pull in CodeMirror. See {@link EditorFactory} for the
   * invocation-order contract relative to {@link Renderers.init}.
   */
  createEditor?: EditorFactory;
  /**
   * Optional host-supplied controls appended to the right edge of
   * the header `controls` bar (after the existing format select and
   * transpose group). Each entry is appended in order; ui-web does
   * not own them — the host wires its own listeners and is
   * responsible for keeping the elements alive across UI rebuilds.
   *
   * Used by the playground (#2366) to inject the ChordPro / iRealb
   * input-format `<select>` next to the existing render-format
   * select, without forcing every consumer to construct the
   * surrounding `<header>` chrome themselves. Hosts that supply
   * `replaceEditor` typically pair it with this slot so the format
   * toggle lives in the same visual cluster as the renderer
   * controls.
   */
  headerControls?: HTMLElement[];
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
  /**
   * Move keyboard focus into the editor pane. Routes through the
   * injected {@link EditorAdapter#focus} when present (the desktop
   * CodeMirror factory and the default `<textarea>` factory both
   * supply one); a no-op if the active editor adapter does not
   * expose `focus`. Backs the desktop app's `View → Focus Editor`
   * shortcut (#2194).
   */
  focusEditor(): void;
  /**
   * Move keyboard focus to the preview pane — specifically the
   * currently visible output surface (HTML iframe / text `<pre>` /
   * PDF download pane), so the focus follows the format select.
   * Backs the desktop app's `View → Focus Preview` shortcut (#2194).
   */
  focusPreview(): void;
  /**
   * Adjust the transpose offset by `delta` semitones, clamped to the
   * same `[-11, 11]` window the trio buttons and the `<input>` itself
   * enforce. `delta` must be a finite integer; non-finite (`NaN` /
   * `Infinity`) or zero values are treated as no-ops, and fractional
   * values are truncated toward zero. Triggers the same debounced
   * rerender path as a click on the existing `+` / `−` buttons so
   * the preview stays in sync. Backs the desktop app's `View →
   * Transpose Up / Down` shortcuts (#2190); hosts that bind the same
   * action elsewhere (a custom floating control, a hardware MIDI
   * pedal) reuse this method instead of synthesising click events on
   * the trio buttons.
   *
   * The signed-delta shape is intentionally distinct from
   * `@chordsketch/react`'s `useTranspose` hook (`increment(step?)` /
   * `decrement(step?)` / `reset()`) because the React hook keeps its
   * state in user-supplied React state, while this handle drives the
   * built-in DOM trio. Hosts that already use one shape are not
   * expected to switch to the other.
   */
  stepTranspose(delta: number): void;
  /**
   * Reset the transpose offset to `0`, matching what `Reset` on the
   * existing trio does. Surfaced so the desktop app can offer a
   * `View → Reset Transpose` menu item without poking at the
   * internal `<button>` (#2190).
   */
  resetTranspose(): void;
  /**
   * Tear down the active editor adapter and replace it with a new
   * one built from `factory`. The previous adapter's `getValue()`
   * is forwarded to the new factory as `initialValue` so the
   * editor swap is content-preserving — the host that calls this
   * is typically toggling input formats (ChordPro ↔ iRealb in the
   * playground, #2366) and expects the in-progress text to survive
   * the swap. The change handler registered at mount time is
   * re-attached to the new adapter, and an immediate render is
   * scheduled (not the debounced path) so the preview reflects the
   * new editor's interpretation of the carried-over content
   * without the 300 ms input delay.
   *
   * Counts as a programmatic load, not a user edit:
   * {@link MountOptions.onChordProChange} is NOT fired by the swap
   * itself — only by subsequent user input on the new adapter. A
   * pending debounced render queued by the previous adapter is
   * cancelled before tear-down so the stale closure does not
   * resurrect the old `getValue()`.
   */
  replaceEditor(factory: EditorFactory): void;
}

const RENDER_DEBOUNCE_MS = 300;

// Minimal single-document frame for whatever HTML body fragment the
// host's `Renderers.renderHtml` produces. Hosts are responsible for
// supplying any layout/typography styling — typically by prepending a
// `<style>` block to the body fragment (the playground does this with
// `render_html_css()` from `@chordsketch/wasm`). The frame
// intentionally carries no own styles so it cannot conflict with
// whatever the body brings.
//
// Pre-#2321 this template embedded a second copy of body / chord /
// section styles AND the playground passed a full
// `<!DOCTYPE>...<body>...</body></html>` document through, so
// `srcdoc` ended up with two `<!DOCTYPE>` / `<head>` / `<body>` pairs
// that survived only via HTML5 nested-document recovery. That
// double-wrap was the most likely structural source of the
// user-reported "Blocked script execution in 'about:blank'" warning
// and the format-toggle blank-preview symptom on certain Chrome
// configurations.
//
// `cacheBust` is a monotonic per-mount counter rendered as an HTML
// comment inside `<head>`. It guarantees the resulting `srcdoc`
// string is byte-different on every render so the iframe's
// navigation hook cannot elide the assignment as a no-op when the
// produced body would otherwise be byte-equal to the previous
// render — the residual format-toggle blank-preview symptom #2421
// reported after the #2321 / PR #2322 fix landed. The comment is
// ignored by HTML rendering and adds ~12 bytes per srcdoc.
const HTML_FRAME_TEMPLATE = (body: string, cacheBust: number): string => `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<!-- r:${cacheBust} -->
</head>
<body>${body}</body>
</html>`;

interface UiNodes {
  editorPaneEl: HTMLDivElement;
  formatSelect: HTMLSelectElement;
  transposeInput: HTMLInputElement;
  transposeDecrementBtn: HTMLButtonElement;
  transposeIncrementBtn: HTMLButtonElement;
  transposeResetBtn: HTMLButtonElement;
  transposeLiveRegion: HTMLSpanElement;
  mainEl: HTMLElement;
  splitter: HTMLDivElement;
  preview: HTMLIFrameElement;
  textOutput: HTMLPreElement;
  pdfPane: HTMLDivElement;
  downloadPdfBtn: HTMLButtonElement;
  errorDiv: HTMLDivElement;
}

/**
 * Default `<textarea>`-backed editor. Preserves the byte-exact
 * playground behaviour from before the `EditorAdapter` split: one
 * `<textarea id="editor">` inside the editor pane, `input` events
 * proxied to the change subscriber, no placeholder announcements.
 *
 * Exported so hosts that drive the runtime swap path (#2366) can
 * pass it back into {@link ChordSketchUiHandle.replaceEditor} —
 * the mount-time default selected by `MountOptions.createEditor =
 * undefined` is not reachable at swap time, where the contract
 * requires an explicit factory. Reusing this export instead of
 * re-implementing the textarea in each host keeps the swapped-in
 * surface byte-equal to the mount-time one and avoids the
 * fix-propagation defect class
 * (`.claude/rules/fix-propagation.md`) of two divergent textarea
 * factories.
 *
 * The returned `<textarea>` carries `id="editor"` because
 * `style.css` targets `#editor` for the editor-pane font and
 * background; renaming the id would silently de-style the editor.
 */
export function defaultTextareaEditor(options: EditorFactoryOptions): EditorAdapter {
  const textarea = document.createElement('textarea');
  textarea.id = 'editor';
  textarea.spellcheck = false;
  if (options.placeholder !== undefined) {
    textarea.placeholder = options.placeholder;
  }
  textarea.value = options.initialValue;

  const listeners = new Set<(value: string) => void>();
  const onInput = (): void => {
    for (const handler of listeners) handler(textarea.value);
  };
  textarea.addEventListener('input', onInput);

  return {
    element: textarea,
    getValue: () => textarea.value,
    setValue: (value: string) => {
      // Direct assignment does NOT fire `input` events, which is
      // exactly what the `EditorAdapter` contract requires for
      // programmatic loads.
      textarea.value = value;
    },
    onChange(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    focus: () => {
      textarea.focus();
    },
    destroy: () => {
      listeners.clear();
      textarea.removeEventListener('input', onInput);
    },
  };
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
function buildDom(
  root: HTMLElement,
  title: string,
  headerControls: HTMLElement[],
): UiNodes {
  // The iframe sandbox is intentionally restrictive — empty `sandbox`
  // would block scripts/forms/storage so the rendered HTML cannot run JS
  // or steal cookies. We do allow popups so anchor clicks (e.g. from
  // {link} or chord-diagram image maps) can open in a new tab. See #1058.
  root.innerHTML = '';
  // Apply the viewport-filling flex chain to `root` rather than `body`
  // so the layout works when the host wraps the mount root in a
  // non-body container (the playground's `<div id="app">`). See #2280
  // and `.chordsketch-ui-root` in `style.css`.
  root.classList.add('chordsketch-ui-root');

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
  transposeDecrementBtn.setAttribute('aria-label', 'Transpose down one semitone');

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
  transposeIncrementBtn.setAttribute('aria-label', 'Transpose up one semitone');

  const transposeResetBtn = document.createElement('button');
  transposeResetBtn.type = 'button';
  // Starts hidden because the initial value is `TRANSPOSE_RESET`;
  // visibility is kept in sync by `updateTransposeControls` below.
  transposeResetBtn.className = 'transpose-reset hidden';
  transposeResetBtn.textContent = 'Reset';
  transposeResetBtn.setAttribute('aria-label', 'Reset transposition to zero');

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
  // Host-supplied controls are appended after the built-in format
  // and transpose clusters so a future built-in addition does not
  // visually displace whatever the host injected here. ui-web does
  // NOT add CSS rules targeting these elements — the host styles
  // them, typically by reusing the namespaced `.controls label` /
  // `.controls select` rules already in `style.css`.
  //
  // Dedupe by element identity per `.claude/rules/defensive-inputs.md`
  // — the same node passed twice would otherwise be silently
  // reparented (the second `appendChild` moves the node, leaving
  // the first slot empty). A duplicated entry is more likely a host
  // bug than an intentional double-mount, so warn and skip rather
  // than silently mutate.
  const seenHeaderControls = new Set<HTMLElement>();
  for (const el of headerControls) {
    if (seenHeaderControls.has(el)) {
      // eslint-disable-next-line no-console
      console.warn(
        'mountChordSketchUi: duplicate headerControls entry ignored',
      );
      continue;
    }
    seenHeaderControls.add(el);
    controls.appendChild(el);
  }
  header.appendChild(controls);

  const main = document.createElement('main');

  const editorPaneEl = document.createElement('div');
  editorPaneEl.id = 'editor-pane';
  editorPaneEl.className = 'pane editor-pane';
  // Editor DOM is mounted by `mountChordSketchUi` via the
  // `EditorAdapter` factory — `buildDom` only reserves the slot.

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
  // `<pre>` is not focusable by default. `tabIndex = -1` lets
  // {@link ChordSketchUiHandle.focusPreview} land focus here when
  // the text format is selected without inserting the element into
  // the natural Tab order. (#2194)
  textOutput.tabIndex = -1;

  const pdfPane = document.createElement('div');
  pdfPane.id = 'pdf-pane';
  pdfPane.className = 'hidden';
  // Same rationale as `textOutput.tabIndex` above — programmatic
  // focus via `focusPreview()` only, no Tab-order insertion. (#2194)
  pdfPane.tabIndex = -1;
  const pdfHint = document.createElement('p');
  pdfHint.textContent = 'Click the button to generate and download a PDF.';
  const downloadPdfBtn = document.createElement('button');
  downloadPdfBtn.id = 'download-pdf';
  downloadPdfBtn.textContent = 'Download PDF';
  pdfPane.append(pdfHint, downloadPdfBtn);

  outputPane.append(errorDiv, preview, textOutput, pdfPane);

  main.append(editorPaneEl, splitter, outputPane);
  root.append(header, main);

  return {
    editorPaneEl,
    formatSelect,
    transposeInput,
    transposeDecrementBtn,
    transposeIncrementBtn,
    transposeResetBtn,
    transposeLiveRegion,
    mainEl: main,
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
    createEditor = defaultTextareaEditor,
    headerControls = [],
  } = options;

  if (documentTitle !== undefined) {
    document.title = documentTitle;
  }

  const nodes = buildDom(root, title, headerControls);
  const {
    editorPaneEl,
    formatSelect,
    transposeInput,
    transposeDecrementBtn,
    transposeIncrementBtn,
    transposeResetBtn,
    transposeLiveRegion,
    mainEl,
    splitter,
    preview,
    textOutput,
    pdfPane,
    downloadPdfBtn,
    errorDiv,
  } = nodes;

  const showError = (msg: string): void => {
    errorDiv.textContent = msg;
    errorDiv.classList.remove('hidden');
  };

  const hideError = (): void => {
    errorDiv.classList.add('hidden');
  };

  try {
    await renderers.init();
  } catch (e) {
    showError(`Failed to initialise renderer: ${formatError(e)}`);
    throw e;
  }

  // `editor` and `unsubscribeEditor` are reassigned by
  // `replaceEditor` (#2366), so they cannot be `const` even though
  // the initial values are set exactly once here. The `let` binding
  // is captured by the render / destroy / handle closures below;
  // each captures the variable, not the initial value, so the
  // post-swap reads see the new adapter.
  let editor = createEditor({
    initialValue: initialChordPro,
    placeholder: 'Enter ChordPro here...',
  });
  editorPaneEl.appendChild(editor.element);

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
  // Snapshot of the split ratio at drag start so `pointercancel`
  // can revert mid-drag movement rather than persist a partial
  // position. See #2198 for the cancel-vs-up split.
  let splitRatioBeforeDrag: number | null = null;

  // Shared cleanup for the states `onSplitterPointerDown` mutates —
  // pointer capture, the `dragging` CSS class, and the global
  // `user-select: none`. Hoisted out so `destroy()` can run it if
  // the host tears down the widget while a drag is in progress;
  // skipping this path left `user-select: none` stuck on `<body>`
  // (#2196).
  const clearSplitterDragState = (pointerId?: number): void => {
    splitterDragActive = false;
    splitRatioBeforeDrag = null;
    if (pointerId !== undefined && splitter.hasPointerCapture(pointerId)) {
      splitter.releasePointerCapture(pointerId);
    }
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
  };

  const onSplitterPointerDown = (ev: PointerEvent): void => {
    // Only primary-button drags (mouse button 0 / touch / pen).
    if (ev.button !== 0) return;
    ev.preventDefault();
    splitterDragActive = true;
    splitRatioBeforeDrag = splitRatio;
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
    clearSplitterDragState(ev.pointerId);
    persistSplitRatio();
  };

  // `pointercancel` fires when the browser interrupts a drag — a
  // phone-call overlay, an iOS home gesture, an OS-level focus
  // steal. The user did not release the pointer deliberately, so
  // reverting to the pre-drag ratio matches the "cancel undoes the
  // gesture" convention used elsewhere (#2198). Persist the
  // restored (== previous) ratio so the layout survives the next
  // reload even if this host session ends abruptly afterwards.
  const onSplitterPointerCancel = (ev: PointerEvent): void => {
    if (!splitterDragActive) return;
    const restore = splitRatioBeforeDrag;
    clearSplitterDragState(ev.pointerId);
    if (restore !== null) {
      applySplitRatio(restore);
    }
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

  // Monotonic per-mount counter feeding the `HTML_FRAME_TEMPLATE`
  // cache-bust comment. Incremented before every iframe `srcdoc`
  // assignment so the produced string is byte-different on every
  // render, defeating the same-string-skip-navigation quirk that
  // surfaced after the #2321 fix (#2421).
  let srcdocCounter = 0;

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

  const showPane = (pane: 'html' | 'text' | 'pdf'): void => {
    preview.classList.toggle('hidden', pane !== 'html');
    textOutput.classList.toggle('hidden', pane !== 'text');
    pdfPane.classList.toggle('hidden', pane !== 'pdf');
  };

  const render = (): void => {
    const input = editor.getValue();
    if (!input.trim()) {
      hideError();
      showPane('html');
      preview.srcdoc = '';
      textOutput.textContent = '';
      return;
    }

    const transpose = getTranspose();
    const renderOpts: RenderOptions | undefined =
      transpose !== 0 ? { transpose } : undefined;

    // iReal Pro routing: when the editor body begins with an
    // `irealb://` or `irealbook://` URL AND the host supplied a
    // `renderSvg` implementation, render the iReal chart and route
    // the SVG to the preview iframe regardless of the format
    // selector. The selector is bypassed because the iReal pipeline
    // emits SVG only — there is no text or PDF analogue at the
    // ui-web layer in this PR (read-only preview; editing comes in
    // #2363+). When `renderSvg` is absent, the existing ChordPro
    // path is taken unchanged so hosts that do not bundle the
    // iReal renderer keep their pre-#2362 byte-equal behaviour.
    //
    // The SVG document — including its leading `<?xml ?>` PI — is
    // intentionally embedded inside the HTML `<body>` produced by
    // `HTML_FRAME_TEMPLATE`. Browsers tolerate this (the PI inside
    // `<body>` is treated as a comment in HTML parsing mode), and
    // the iframe `sandbox` attribute (set without `allow-scripts`)
    // makes the parser-recovery shape security-irrelevant — any
    // scriptable content the SVG contained would be inert anyway.
    const trimmedInput = input.trimStart();
    if (
      renderers.renderSvg !== undefined &&
      (trimmedInput.startsWith('irealb://') ||
        trimmedInput.startsWith('irealbook://'))
    ) {
      try {
        showPane('html');
        const svg = renderOpts
          ? renderers.renderSvg(input, renderOpts)
          : renderers.renderSvg(input);
        // Cache-busting `srcdoc` write — see the matching ChordPro
        // html branch below for the rationale (#2421).
        preview.srcdoc = HTML_FRAME_TEMPLATE(svg, ++srcdocCounter);
        hideError();
      } catch (e) {
        showError(formatError(e));
      }
      return;
    }

    const format = formatSelect.value;

    try {
      if (format === 'html') {
        showPane('html');
        const html = renderOpts
          ? renderers.renderHtml(input, renderOpts)
          : renderers.renderHtml(input);
        // Force a fresh iframe navigation on every render. The
        // empty-then-set sequence introduced by #2321 / PR #2322
        // turned out to leave the format-toggle blank-preview
        // symptom on the HTML → Text → HTML path reachable in
        // some Chrome configurations: two synchronous writes to
        // the same IDL property in a single task can be coalesced
        // by the browser, and when the resulting attribute value
        // is byte-equal to the previous render the navigation
        // hook treats it as a no-op — leaving the iframe blank
        // when its document had been discarded while hidden via
        // `display: none`. `HTML_FRAME_TEMPLATE` now emits a
        // monotonically-increasing cache-bust comment in `<head>`
        // so the assigned string is guaranteed to be different on
        // every render, which forces the navigation regardless of
        // attribute coalescing or document discard. (#2421)
        preview.srcdoc = HTML_FRAME_TEMPLATE(html, ++srcdocCounter);
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
    const input = editor.getValue();
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

  // `initialValue` was already seeded by the factory; no second
  // assignment needed here.

  const onEditorInput = (value: string): void => {
    onChordProChange?.(value);
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

  let unsubscribeEditor = editor.onChange(onEditorInput);
  formatSelect.addEventListener('change', render);
  transposeInput.addEventListener('input', onTransposeInput);
  transposeDecrementBtn.addEventListener('click', onTransposeDecrement);
  transposeIncrementBtn.addEventListener('click', onTransposeIncrement);
  transposeResetBtn.addEventListener('click', onTransposeReset);
  splitter.addEventListener('pointerdown', onSplitterPointerDown);
  splitter.addEventListener('pointermove', onSplitterPointerMove);
  splitter.addEventListener('pointerup', onSplitterPointerUp);
  splitter.addEventListener('pointercancel', onSplitterPointerCancel);
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
      unsubscribeEditor();
      editor.destroy();
      formatSelect.removeEventListener('change', render);
      transposeInput.removeEventListener('input', onTransposeInput);
      transposeDecrementBtn.removeEventListener('click', onTransposeDecrement);
      transposeIncrementBtn.removeEventListener('click', onTransposeIncrement);
      transposeResetBtn.removeEventListener('click', onTransposeReset);
      splitter.removeEventListener('pointerdown', onSplitterPointerDown);
      splitter.removeEventListener('pointermove', onSplitterPointerMove);
      splitter.removeEventListener('pointerup', onSplitterPointerUp);
      splitter.removeEventListener('pointercancel', onSplitterPointerCancel);
      splitter.removeEventListener('keydown', onSplitterKeyDown);
      downloadPdfBtn.removeEventListener('click', downloadPdf);
      // If `destroy()` fires mid-drag (Tauri host switching tabs,
      // Vite HMR replacement), the `pointerup`/`pointercancel`
      // listeners we just removed will never fire — so the
      // document-wide `user-select: none` and the `dragging` CSS
      // class would otherwise stay stuck until the next mount.
      // `clearSplitterDragState` is idempotent when no drag is in
      // progress, so it is safe to call unconditionally (#2196).
      clearSplitterDragState();
      // Remove the class added by `buildDom` so the host can reuse
      // `root` for non-ChordSketch content without inheriting the
      // viewport-filling flex layout.
      root.classList.remove('chordsketch-ui-root');
    },
    getChordPro(): string {
      return editor.getValue();
    },
    getTranspose(): number {
      return getTranspose();
    },
    setChordPro(value: string): void {
      editor.setValue(value);
      // Cancel any debounce pending from pre-load keystrokes (e.g.
      // paste-then-Open): without this, the stale timer fires ~300 ms
      // later and re-renders the freshly loaded content again —
      // idempotent but wasteful.
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // Immediate render (not `scheduleRender`) because programmatic
      // loads are discrete events — users expect the preview to
      // reflect the loaded file without a 300 ms debounce delay.
      render();
    },
    focusEditor(): void {
      editor.focus?.();
    },
    focusPreview(): void {
      // Pick whichever output surface is currently visible — the
      // user's mental model of "preview" follows the format select,
      // so the focus shortcut should land on the surface they're
      // actually looking at. `showPane()` always reveals exactly
      // one of the three; the terminal `else` exists only as a
      // forward-safety guard so a future arm added to `showPane`
      // without a matching arm here fails loudly during dev rather
      // than silently no-op'ing the shortcut.
      if (!preview.classList.contains('hidden')) {
        preview.focus();
      } else if (!textOutput.classList.contains('hidden')) {
        textOutput.focus();
      } else if (!pdfPane.classList.contains('hidden')) {
        pdfPane.focus();
      } else {
        console.warn(
          'focusPreview: no preview surface visible — showPane() invariant broken?',
        );
      }
    },
    stepTranspose(delta: number): void {
      // Validate at the public-API boundary per
      // `.claude/rules/defensive-inputs.md`. Non-finite `delta`
      // (`NaN`/`±Infinity`) propagates through `getTranspose() +
      // delta` and `Math.max/min` as `NaN`, which `setTranspose`
      // would write into `transposeInput.value` as the literal
      // string `"NaN"` — `getTranspose()` self-heals on the next
      // read via `Number.isNaN`, but the `<input>` briefly displays
      // bogus state and a render is scheduled with stale-feeling
      // numbers. `Math.trunc` rounds fractional `delta` toward zero
      // so a host passing `0.5` or `-1.7` produces a deterministic
      // integer step instead of letting `transposeInput.value =
      // "0.5"` drift away from `parseInt`'s truncation in
      // `getTranspose()`. A truncated-to-zero `delta` falls into
      // the early-return so we don't schedule a no-op render.
      if (!Number.isFinite(delta)) return;
      const step = Math.trunc(delta);
      if (step === 0) return;
      // `setTranspose` clamps to `[TRANSPOSE_MIN, TRANSPOSE_MAX]`
      // and schedules a render, so a `step` larger than the
      // remaining headroom degrades to "snap to the boundary"
      // rather than overshooting. Reading via `getTranspose()`
      // (not `transposeInput.valueAsNumber`) keeps us using the
      // same clamp-and-fallback path as the click handlers, which
      // is the safer choice if a host calls this between an in-
      // progress edit and the next debounce tick.
      setTranspose(getTranspose() + step);
    },
    resetTranspose(): void {
      setTranspose(TRANSPOSE_RESET);
    },
    replaceEditor(factory: EditorFactory): void {
      if (destroyed) return;
      // Capture the carry-over value BEFORE tearing down the old
      // adapter — `getValue()` after `destroy()` is contractually
      // undefined and the iRealb adapter (#2363) returns '' for a
      // destroyed instance, which would silently wipe the editor
      // contents on swap.
      const previous = editor.getValue();
      // Build the new adapter BEFORE tearing down the old one.
      // The factory MAY throw — the iRealb factory in particular
      // calls `parseIrealb` synchronously on `initialValue`, which
      // throws on any non-`irealb://` text. If the throw landed
      // after `editor.destroy()` had already run, the handle would
      // be left with a destroyed adapter, no DOM, and no error
      // surfaced to the user. By constructing first, we keep the
      // existing editor as the failure-mode baseline: the user
      // sees the error in the preview pane and the carried-over
      // text remains in the (still-mounted) original adapter.
      let next: EditorAdapter;
      try {
        next = factory({
          initialValue: previous,
          placeholder: 'Enter ChordPro here...',
        });
      } catch (e) {
        showError(formatError(e));
        return;
      }
      // Preserve focus across the swap if it was inside the
      // outgoing editor's DOM. Without this, a keyboard user
      // toggling format from inside the editor lands focus on
      // <body> and has to Tab back into the pane. Read the
      // intent BEFORE tear-down because `document.activeElement`
      // resets to <body> the moment we detach the old element.
      const restoreFocus =
        editorPaneEl.contains(document.activeElement) &&
        document.activeElement !== editorPaneEl;
      // Cancel any debounce queued by the outgoing adapter — its
      // closure resolves `editor.getValue()` lazily, but by the
      // time the timer fires `editor` will have been reassigned to
      // the new adapter, so the stale render would re-encode the
      // carried-over value through the WRONG renderer (e.g. ChordPro
      // text passed to `renderSvg`). The post-swap `render()` below
      // is the canonical re-render — there is no information lost
      // by dropping the queued one.
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      unsubscribeEditor();
      editor.destroy();
      // Detach the previous adapter's root element. The factory is
      // free to mount its own DOM via the `EditorAdapter.element`
      // property; clearing the pane first avoids stacking adapters
      // when a host swaps repeatedly.
      while (editorPaneEl.firstChild !== null) {
        editorPaneEl.removeChild(editorPaneEl.firstChild);
      }
      editor = next;
      editorPaneEl.appendChild(editor.element);
      unsubscribeEditor = editor.onChange(onEditorInput);
      if (restoreFocus) editor.focus?.();
      // Programmatic swap → immediate render, not the debounced
      // path. Mirrors `setChordPro`'s rationale: a host-driven
      // load is a discrete event and the user expects the preview
      // to refresh without the 300 ms input delay.
      render();
    },
  };
}
