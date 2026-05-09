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
  parseIrealb,
  serializeIrealb,
} from '@chordsketch/wasm';
import {
  mountChordSketchUi,
  SAMPLE_CHORDPRO,
  SAMPLE_IREALB,
  type EditorAdapter,
  type EditorFactory,
  type EditorFactoryOptions,
  type Renderers,
} from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';
import { createIrealbEditor } from '@chordsketch/ui-irealb-editor';
import '@chordsketch/ui-irealb-editor/style.css';
import { createCodeMirrorChordProEditor } from './codemirror-chordpro';
import {
  parseFormatHash,
  writeFormatHash,
  type InputFormat,
} from './_hash';

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

// ---------------------------------------------------------------
// Format toggle (#2366) — ChordPro `<textarea>` ↔ iRealb bar grid.
// ---------------------------------------------------------------
//
// `format` is a top-level concern of the playground host, not of
// `@chordsketch/ui-web`: ui-web takes a single `EditorFactory` at
// mount time and otherwise has no opinion on input format. The
// runtime swap is exposed via `handle.replaceEditor(factory)`,
// which preserves the in-progress editor value across the swap so
// users who paste a URL into the textarea and flip the toggle do
// not lose their input.

/**
 * Decide which input format to mount with. The URL hash takes
 * precedence (so a deep link like `#format=irealb` opens the iRealb
 * grid even when the seed value is empty); otherwise the heuristic
 * is "starts with `irealb://` or `irealbook://`" — the same sniffer
 * ui-web uses to route the SVG preview path (#2362). The seed
 * argument is normally the constant `SAMPLE_CHORDPRO`, so the
 * sniffer rarely fires in practice; it stays in place so a future
 * draft-restoration path (e.g. `localStorage` cache, `?content=`
 * query param) can be wired in without re-deriving the precedence
 * order.
 */
function detectInitialFormat(seed: string): InputFormat {
  const hash = parseFormatHash(window.location.hash);
  if (hash !== null) return hash;
  const trimmed = seed.trimStart();
  if (trimmed.startsWith('irealb://') || trimmed.startsWith('irealbook://')) {
    return 'irealb';
  }
  return 'chordpro';
}

/**
 * Editor factory for the iRealb path. Closes over the wasm bridge
 * so ui-web can call it with just the `EditorFactoryOptions`
 * argument. The two `IrealbWasm` methods are passed straight from
 * `@chordsketch/wasm`'s named exports — the editor package is
 * peer-dep'd on the wasm package so it does not import them
 * directly.
 */
const irealbEditorFactory: EditorFactory = (
  options: EditorFactoryOptions,
): EditorAdapter =>
  createIrealbEditor({
    initialValue: options.initialValue,
    placeholder: options.placeholder,
    wasm: { parseIrealb, serializeIrealb },
  });

// `replaceEditor` requires an explicit factory — passing `undefined`
// is only meaningful at mount time, where it picks up ui-web's
// built-in textarea via `MountOptions.createEditor` defaulting. The
// playground supplies its own factories at every mount point so
// the post-swap editor is constructed from the same code path
// regardless of how the swap was triggered (URL hash, format
// toggle, runtime API).
/**
 * On runtime swap, the previous editor's value is forwarded as
 * `initialValue` to the new factory. ChordPro text fed to the
 * iRealb factory throws inside `parseIrealb`; without recovery the
 * user lands on an unmounted editor. Falls back to the format's
 * sample seed (lossy — the carried-over text is discarded; logged
 * via `console.warn`). The recursion guard prevents an infinite
 * loop if the seed itself ever fails to parse. See #2397 sister-
 * site audit.
 */
const factoryFor = (format: InputFormat): EditorFactory => {
  const base: EditorFactory =
    format === 'irealb' ? irealbEditorFactory : createCodeMirrorChordProEditor;
  const seed = format === 'irealb' ? SAMPLE_IREALB : SAMPLE_CHORDPRO;
  return (options) => {
    try {
      return base(options);
    } catch (e) {
      if (options.initialValue === seed) throw e;
      console.warn(
        `${format} editor could not parse carried-over content; ` +
          `falling back to the built-in sample. Original error:`,
        e,
      );
      return base({ ...options, initialValue: seed });
    }
  };
};

const initialFormat = detectInitialFormat(SAMPLE_CHORDPRO);
const initialContent = initialFormat === 'irealb' ? SAMPLE_IREALB : SAMPLE_CHORDPRO;

// Build the input-format <select> outside the mount so the same
// element survives editor swaps — ui-web owns its own DOM, but
// `headerControls` are guests retained across `replaceEditor`.
const inputFormatLabel = document.createElement('label');
inputFormatLabel.append('Input: ');
const inputFormatSelect = document.createElement('select');
inputFormatSelect.id = 'input-format';
inputFormatSelect.setAttribute('aria-label', 'Editor input format');
for (const [value, label] of [
  ['chordpro', 'ChordPro'],
  ['irealb', 'iRealb'],
] as const) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  if (value === initialFormat) opt.selected = true;
  inputFormatSelect.appendChild(opt);
}
inputFormatLabel.appendChild(inputFormatSelect);

void mountChordSketchUi(root, {
  renderers,
  initialChordPro: initialContent,
  createEditor: factoryFor(initialFormat),
  headerControls: [inputFormatLabel],
}).then((handle) => {
  inputFormatSelect.addEventListener('change', () => {
    const next: InputFormat =
      inputFormatSelect.value === 'irealb' ? 'irealb' : 'chordpro';
    // Persist BEFORE the swap so a host that throws inside the
    // factory (e.g. iRealb parse failure on stale carry-over text)
    // still leaves the URL hash on the format the user chose —
    // reloading then re-attempts the swap with a clean slate.
    writeFormatHash(next);
    handle.replaceEditor(factoryFor(next));
  });
});
