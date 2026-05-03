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
  defaultTextareaEditor,
  mountChordSketchUi,
  type ChordSketchUiHandle,
  type EditorAdapter,
  type EditorFactory,
  type EditorFactoryOptions,
  type Renderers,
} from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';
import { createIrealbEditor } from '@chordsketch/ui-irealb-editor';
import '@chordsketch/ui-irealb-editor/style.css';
import './codemirror-editor.css';
import { codemirrorEditorFactory } from './codemirror-editor';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from '@tauri-apps/api/menu';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ask, message, open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import {
  checkForUpdates,
  isAutoUpdateOptedOut,
  setAutoUpdateOptOut,
  startAutoUpdateLoop,
} from './updater';

type ExportFormat = 'pdf' | 'html';

const DEFAULT_WINDOW_TITLE = 'ChordSketch';
const UNTITLED_LABEL = 'Untitled';
const MAX_RECENTS = 10;
const RECENTS_STORAGE_KEY = 'chordsketch-desktop-recent-files';

// Open / Save dialogs surface ChordPro and iReal Pro files side by
// side so a user with a mixed library can pick either format from
// the same picker. The first filter group is the default selection
// on every platform — keep ChordPro first so the existing default
// stays.
//
// `.irealb` is the project-local convention for a single iReal Pro
// song (one `irealb://...` URL per file); `.irealbook` is the
// multi-song collection variant (one `irealbook://...` URL). The
// upstream iReal Pro app does not register a file extension, so
// these are first-class to ChordSketch's pipeline only.
const CHORDPRO_FILTERS = [
  { name: 'ChordPro', extensions: ['cho', 'chopro', 'crd', 'chordpro'] },
];
const IREALB_FILTERS = [
  { name: 'iReal Pro', extensions: ['irealb', 'irealbook'] },
];
const ALL_FILES_FILTER = { name: 'All files', extensions: ['*'] };
const OPEN_SAVE_FILTERS = [
  ...CHORDPRO_FILTERS,
  ...IREALB_FILTERS,
  ALL_FILES_FILTER,
];

const EXPORT_FILTERS: Record<
  ExportFormat,
  { name: string; extensions: string[] }
> = {
  pdf: { name: 'PDF', extensions: ['pdf'] },
  html: { name: 'HTML', extensions: ['html', 'htm'] },
};

// Mutable desktop-app session state. Kept in module scope so the
// menu handlers and the `onChordProChange` callback can update them
// without plumbing the state through every async boundary.
let currentPath: string | null = null;
let lastSavedContent = '';
let recents: string[] = [];

// ---- Editor mode (#2367) -------------------------------------------------
//
// `chordpro` — CodeMirror with the tree-sitter-chordpro grammar
//              (#2072). The default for a fresh launch and for any
//              opened ChordPro file (`.cho` / `.chordpro` / etc.).
// `irealb-grid` — `@chordsketch/ui-irealb-editor`'s bar-grid GUI.
//              The default for any opened iRealb file (`.irealb` /
//              `.irealbook`).
// `irealb-text` — Plain `<textarea>` for raw `irealb://` URL editing.
//              Surfaced via the View menu as a fallback when the user
//              wants to read or hand-edit the URL string. NOT
//              CodeMirror — iRealb URLs are not ChordPro and the
//              grammar would mis-highlight them as ChordPro tokens.
type EditorMode = 'chordpro' | 'irealb-grid' | 'irealb-text';

let currentEditorMode: EditorMode = 'chordpro';

// Adapter from the wasm-bindgen export shape to the ui-web `Renderers`
// interface. Mirrors `packages/playground/src/main.ts` so the desktop
// WebView and the browser playground share the same render pipeline;
// keeping the no-options overloads on text / pdf avoids an unused
// options object on the common `transpose === 0` path, matching the
// playground's pre-extraction rendering baseline.
//
// `renderHtml` returns a body-only fragment (`<style>` + `<div
// class="song">`) and ui-web's `HTML_FRAME_TEMPLATE` wraps it in
// exactly one `<!DOCTYPE>` / `<html>` / `<body>`. Pre-#2321 this
// adapter passed `render_html`'s full document through and ui-web
// wrapped it again, leaving the desktop preview reliant on HTML5
// nested-document recovery — the same structural defect described
// in `packages/playground/src/main.ts`. HTML5 nested-document
// recovery is universal across the per-platform WebViews Tauri uses
// (WebView2 / Chromium on Windows, WKWebView / WebKit on macOS,
// webkit2gtk / WebKit on Linux), so the fix must propagate per
// `.claude/rules/fix-propagation.md`.
//
// When `options.config` is unset we reuse a cached default CSS
// (`render_html_css()` is byte-stable across the build); otherwise we
// call `render_html_css_with_options(options)` so the body and CSS
// are computed against the same config. Mirrors the playground
// adapter byte-for-byte.
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
  // Mirrors `packages/playground/src/main.ts` byte-for-byte so the
  // desktop WebView and the browser playground share the same iReal
  // routing decision (#2362). The wasm export is camelCased via
  // `#[wasm_bindgen(js_name = renderIrealSvg)]` in `crates/wasm/src/lib.rs`.
  renderSvg: (input) => renderIrealSvg(input),
};

const root = document.getElementById('app');
if (!root) {
  throw new Error('Desktop entry point #app element missing from index.html');
}

// ---- Editor factories (#2367) --------------------------------------------
//
// One factory per `EditorMode`. The desktop entry constructs all
// three at module scope so menu handlers can swap between them
// without re-importing per call. The iRealb factory closes over the
// wasm bridge so the `EditorFactory` signature (`options =>
// EditorAdapter`) stays compatible with `MountOptions.createEditor`
// and `ChordSketchUiHandle.replaceEditor`.

const irealbGridFactory: EditorFactory = (
  options: EditorFactoryOptions,
): EditorAdapter =>
  createIrealbEditor({
    initialValue: options.initialValue,
    placeholder: options.placeholder,
    wasm: { parseIrealb, serializeIrealb },
  });

function factoryForMode(mode: EditorMode): EditorFactory {
  switch (mode) {
    case 'chordpro':
      return codemirrorEditorFactory;
    case 'irealb-grid':
      return irealbGridFactory;
    case 'irealb-text':
      // The default ui-web textarea is reused so the URL-text mode
      // surface stays byte-equal to the playground's plain-text path.
      return defaultTextareaEditor;
  }
}

/**
 * Pick the appropriate editor mode for a freshly-opened file. The
 * extension list intentionally mirrors `OPEN_SAVE_FILTERS` so the
 * dispatch and the picker agree on which extensions are first-class.
 * Returns `null` for unknown extensions so the caller leaves the
 * current mode unchanged — matches the existing behaviour for
 * plain-text imports without a recognised suffix.
 */
function detectModeForExtension(path: string): EditorMode | null {
  const lower = path.toLowerCase();
  // Anchor the match to the trailing dot so a file named
  // `cool.irealbook.bak` does not accidentally route through the
  // grid editor.
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  if (ext === 'irealb' || ext === 'irealbook') return 'irealb-grid';
  if (ext === 'cho' || ext === 'chopro' || ext === 'chordpro' || ext === 'crd') {
    return 'chordpro';
  }
  return null;
}

/**
 * Swap the active editor adapter and update the radio-style View
 * menu items to reflect the new mode. The mode change is treated as
 * a programmatic load (per the `replaceEditor` contract): the carry-
 * over content is preserved, but `onChordProChange` is not fired and
 * `lastSavedContent` is left untouched — the file's saved state has
 * not changed, only the surface used to view it. Calling with the
 * same mode is a cheap no-op (avoids an unnecessary DOM rebuild).
 *
 * Pre-flight check for the chordpro → irealb-grid transition: the
 * iRealb factory calls `parseIrealb()` synchronously on the carried-
 * over content and throws if it is not a valid `irealb://` URL. The
 * H1 safety fix in ui-web (PR #2388) catches the throw and leaves
 * the previous editor intact, but `currentEditorMode` would already
 * have advanced — leaving the View menu radio checked on a mode the
 * user never actually entered. Validate up-front and ask the user
 * to discard the ChordPro buffer before switching when needed.
 */
async function setEditorMode(
  handle: ChordSketchUiHandle,
  mode: EditorMode,
  rebuildMenu: MenuRebuilder,
): Promise<void> {
  if (currentEditorMode === mode) return;
  if (mode === 'irealb-grid') {
    const carryover = handle.getChordPro();
    if (carryover.length > 0 && !canParseAsIrealbUrl(carryover)) {
      const confirmed = await ask(
        'The current document is not an iRealb URL. Switching to grid ' +
          'mode will discard the current content. Continue?',
        { title: 'Switch to grid mode?', kind: 'warning' },
      );
      if (!confirmed) return;
      // Clear before swap so the iRealb factory's `initialValue` is
      // empty and `createIrealbEditor` seeds an empty song instead
      // of throwing on `parseIrealb('not-a-url')`.
      handle.setChordPro('');
    }
  }
  currentEditorMode = mode;
  handle.replaceEditor(factoryForMode(mode));
  await rebuildMenu();
  await updateWindowTitle(handle);
}

/**
 * Synchronous probe: does `value` parse as an `irealb://` URL via
 * the wasm `parseIrealb` exported function? Returns `false` on any
 * thrown error. Used by `setEditorMode` and `runOpen` to validate
 * before any destructive state mutation.
 *
 * Note: a successful pre-flight parse here means the wasm bridge
 * will parse the same URL a second time inside `createIrealbEditor`'s
 * `makeStateFromUrl` after the swap completes. The duplicate cost is
 * a single sub-millisecond wasm call against URLs that are bounded
 * by the 10 MiB `MAX_OPEN_SIZE_BYTES` cap; threading the parsed
 * `IrealSong` through the factory contract to skip the second parse
 * would require widening `EditorFactoryOptions` for one host's
 * benefit and is not justified at this volume. The error path is
 * `console.debug`-logged so a user repeatedly probing a malformed
 * buffer can still find the underlying message in devtools without
 * raising it to the UI.
 */
function canParseAsIrealbUrl(value: string): boolean {
  try {
    parseIrealb(value);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.debug('canParseAsIrealbUrl: parse failed', e);
    return false;
  }
}

// ---- Recents persistence -------------------------------------------------

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .slice(0, MAX_RECENTS);
  } catch {
    // Malformed JSON or inaccessible localStorage — fall back to an
    // empty list. A bad write from a future version cannot brick the
    // menu; the list simply resets.
    return [];
  }
}

function persistRecents(list: string[]): void {
  try {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Persistence failure is a convenience loss, not a correctness
    // failure. See the parallel note in `vite.config.ts`'s split-pane
    // persistence (#2071).
  }
}

function pushRecent(path: string): void {
  // Move-to-front with dedupe, then clamp to the max entry count.
  recents = [path, ...recents.filter((p) => p !== path)].slice(0, MAX_RECENTS);
  persistRecents(recents);
}

// ---- Dirty-state + title helpers -----------------------------------------

function basename(path: string): string {
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}

function isDirty(handle: ChordSketchUiHandle): boolean {
  return handle.getChordPro() !== lastSavedContent;
}

async function updateWindowTitle(handle: ChordSketchUiHandle): Promise<void> {
  const label = currentPath ? basename(currentPath) : UNTITLED_LABEL;
  const prefix = isDirty(handle) ? '• ' : '';
  await getCurrentWebviewWindow().setTitle(
    `${prefix}${label} — ${DEFAULT_WINDOW_TITLE}`,
  );
}

// ---- File operations -----------------------------------------------------

async function runOpen(
  handle: ChordSketchUiHandle,
  rebuildMenu: () => Promise<void>,
  path?: string,
): Promise<void> {
  // Dirty-state check happens BEFORE any file picker so the user
  // isn't made to pick a file only to be told their work would be
  // discarded. The recent-file path (`path` already supplied) funnels
  // through the same guard so a stray click on "Open Recent" does
  // not silently clobber unsaved edits either (#2210).
  if (isDirty(handle)) {
    const confirmed = await ask(
      'You have unsaved changes. Open another file and discard them?',
      { title: 'Discard unsaved changes?', kind: 'warning' },
    );
    if (!confirmed) return;
  }

  let target = path ?? null;
  if (!target) {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: OPEN_SAVE_FILTERS,
    });
    if (typeof picked === 'string') target = picked;
    if (!target) return; // User cancelled.
  }

  try {
    const content = await invoke<string>('open_file', { path: target });
    const targetMode = detectModeForExtension(target);
    // Validate `content` BEFORE any destructive state mutation so a
    // malformed iRealb file cannot leave the app half-swapped: editor
    // mounted as the new mode, `currentEditorMode` advanced, but
    // `currentPath` / `lastSavedContent` still pointing at the old
    // file (so the title bar shows the wrong filename and Save would
    // overwrite the old document with the empty new chart). The
    // failure window is collapsed to "before mode change" — the user
    // sees a friendly error and the previous editor stays intact.
    if (targetMode === 'irealb-grid' && !canParseAsIrealbUrl(content)) {
      await message(
        'This file does not contain a valid irealb:// URL.',
        { title: 'Open failed', kind: 'error' },
      );
      return;
    }
    if (targetMode !== null && targetMode !== currentEditorMode) {
      // Clear the current editor before swapping so the new factory's
      // `initialValue` carryover is empty. Otherwise a chordpro →
      // irealb-grid transition would feed `parseIrealb` ChordPro
      // text and throw via the H1 safety fix in ui-web; conversely
      // an irealb-grid → chordpro transition would feed CodeMirror
      // an iRealb URL (harmless on the CodeMirror side, but the
      // re-render fired by `replaceEditor`'s closure would still
      // route through the iRealb-aware preview). Going through an
      // empty intermediate keeps the swap deterministic and side-
      // steps `replaceEditor`'s `getValue()` capture from carrying
      // stale-format content into the new factory's parser.
      handle.setChordPro('');
      currentEditorMode = targetMode;
      handle.replaceEditor(factoryForMode(targetMode));
      // Rebuild the menu inside the swap window so the View radio
      // immediately reflects the new mode, even though the
      // post-load rebuild below would otherwise pick it up. Decoupling
      // the two means a future intermediate failure (between the
      // swap and the load) cannot leave the menu radio out of sync.
      await rebuildMenu();
    }
    // Load the file content into the (now correctly typed) editor.
    handle.setChordPro(content);
    currentPath = target;
    lastSavedContent = content;
    pushRecent(target);
    await rebuildMenu();
    await updateWindowTitle(handle);
  } catch (err) {
    await message(err instanceof Error ? err.message : String(err), {
      title: 'Open failed',
      kind: 'error',
    });
  }
}

/**
 * File → New: discard the current document (after a dirty-check
 * prompt) and reset the editor to an empty buffer with no backing
 * path. Mirrors `runOpen`'s dirty-check guard so a stray click here
 * cannot silently clobber unsaved edits (#2199).
 */
async function runNew(
  handle: ChordSketchUiHandle,
  rebuildMenu: MenuRebuilder,
): Promise<void> {
  if (isDirty(handle)) {
    const confirmed = await ask(
      'You have unsaved changes. Start a new document and discard them?',
      { title: 'Discard unsaved changes?', kind: 'warning' },
    );
    if (!confirmed) return;
  }
  handle.setChordPro('');
  currentPath = null;
  lastSavedContent = '';
  await rebuildMenu();
  await updateWindowTitle(handle);
}

/**
 * Help → Visit project homepage. The `openUrl` call is gated by
 * the `opener:allow-open-url` capability whose `allow` list is
 * scoped to the project homepage URL only — passing any other URL
 * here will be rejected by the Tauri runtime, so this is a safe
 * fixed string.
 */
const PROJECT_HOMEPAGE = 'https://github.com/koedame/chordsketch';

async function runOpenHomepage(): Promise<void> {
  try {
    await openUrl(PROJECT_HOMEPAGE);
  } catch (err) {
    await message(err instanceof Error ? err.message : String(err), {
      title: 'Could not open homepage',
      kind: 'error',
    });
  }
}

/**
 * App → Preferences…: stub. Real Preferences UI is not yet
 * scaffolded; the menu item exists so the macOS app menu gets the
 * platform-conventional "Preferences…" entry alongside Hide /
 * Services / Quit (#2199 AC). Replace this with a real settings
 * surface when the Preferences feature lands.
 */
async function runPreferencesStub(): Promise<void> {
  await message('Preferences are not yet available in this build.', {
    title: 'Preferences',
    kind: 'info',
  });
}

async function runSave(
  handle: ChordSketchUiHandle,
  rebuildMenu: MenuRebuilder,
): Promise<void> {
  if (!currentPath) {
    await runSaveAs(handle, rebuildMenu);
    return;
  }
  await writeCurrent(handle, currentPath);
}

async function runSaveAs(
  handle: ChordSketchUiHandle,
  rebuildMenu: MenuRebuilder,
): Promise<void> {
  // Suggest a default extension that matches the active editor
  // mode. Saving an `.cho` file containing an `irealb://` URL would
  // otherwise be classified as ChordPro by every consumer that keys
  // off the file extension (this app's own `runOpen`, the CLI, the
  // VS Code extension), creating a silent format/extension mismatch.
  const defaultExt =
    currentEditorMode === 'chordpro' ? 'cho' : 'irealb';
  const picked = await save({
    defaultPath: currentPath ?? `${UNTITLED_LABEL.toLowerCase()}.${defaultExt}`,
    filters: OPEN_SAVE_FILTERS,
  });
  if (!picked) return;

  // Point `currentPath` at the new destination BEFORE the write so
  // the in-flight `updateWindowTitle` call inside `writeCurrent`
  // reads the new filename instead of briefly showing the old path
  // or "Untitled" while the write completes. Roll back on failure
  // so the next `runSave` reopens the picker rather than silently
  // retrying against an unwritten destination (#2211).
  const previousPath = currentPath;
  currentPath = picked;
  const ok = await writeCurrent(handle, picked);
  if (!ok) {
    currentPath = previousPath;
    // Repaint the title back to the old state after a failed save.
    await updateWindowTitle(handle);
    return;
  }
  pushRecent(picked);
  await rebuildMenu();
  await updateWindowTitle(handle);
}

async function writeCurrent(
  handle: ChordSketchUiHandle,
  path: string,
): Promise<boolean> {
  const content = handle.getChordPro();
  try {
    await invoke('save_file', { path, content });
    lastSavedContent = content;
    await updateWindowTitle(handle);
    return true;
  } catch (err) {
    await message(err instanceof Error ? err.message : String(err), {
      title: 'Save failed',
      kind: 'error',
    });
    return false;
  }
}

/**
 * Format the renderer warnings (returned by the Rust export command)
 * into a human-readable dialog body. The first few warnings are
 * quoted verbatim; longer lists are truncated with a count so the
 * dialog stays compact on small laptops. Mirrors the trimming logic
 * used by the auto-update dialog in `./updater.ts`.
 */
const EXPORT_WARNING_LINE_LIMIT = 5;
function buildExportSummary(path: string, warnings: string[]): string {
  if (warnings.length === 0) {
    return `Exported to ${path}`;
  }
  const header = `Exported to ${path} with ${warnings.length} warning${
    warnings.length === 1 ? '' : 's'
  }:`;
  if (warnings.length <= EXPORT_WARNING_LINE_LIMIT) {
    return [header, ...warnings.map((w) => `• ${w}`)].join('\n');
  }
  const shown = warnings.slice(0, EXPORT_WARNING_LINE_LIMIT);
  const hidden = warnings.length - shown.length;
  return [
    header,
    ...shown.map((w) => `• ${w}`),
    `… and ${hidden} more`,
  ].join('\n');
}

/**
 * Drive a File → Export flow: read the editor content + transpose
 * offset from the UI handle, show the native save dialog, and
 * invoke the matching Rust command.
 *
 * The Rust renderer is used deliberately (not the WASM in the
 * WebView) — satisfies AC3 of #2074 and means export output is
 * byte-for-byte consistent with the CLI / FFI builds.
 */
async function runExport(
  handle: ChordSketchUiHandle,
  format: ExportFormat,
): Promise<void> {
  // `save()` is inside the try block so a plugin-initialisation
  // failure or an unexpected rejection from `tauri-plugin-dialog`
  // surfaces the same "Export failed" dialog as a downstream
  // `invoke()` error — instead of bubbling out of the `void
  // runExport(...)` menu handler and being silently swallowed.
  try {
    const path = await save({
      defaultPath: `chordsketch.${format}`,
      filters: [EXPORT_FILTERS[format]],
    });
    if (!path) return; // User cancelled the save dialog.

    const transpose = handle.getTranspose();
    // The Rust export commands return the renderer's captured
    // warnings (`render_songs_with_warnings` variant) so we can
    // surface them next to the success dialog — same set the
    // playground's live preview logs via `console.warn`. Windowed
    // `.app` builds have no visible stderr, so without this the
    // renderer warnings would disappear silently (#2201).
    const warnings = (await invoke<string[]>(
      format === 'pdf' ? 'export_pdf' : 'export_html',
      {
        path,
        chordpro: handle.getChordPro(),
        // Only forward a non-zero transpose so the Rust side can
        // follow the same identity-skip that the WASM adapter uses
        // in `renderers` above.
        transpose: transpose === 0 ? null : transpose,
      },
    )) ?? [];
    const body = buildExportSummary(path, warnings);
    await message(body, {
      title: DEFAULT_WINDOW_TITLE,
      kind: warnings.length > 0 ? 'warning' : 'info',
    });
  } catch (err) {
    await message(err instanceof Error ? err.message : String(err), {
      title: 'Export failed',
      kind: 'error',
    });
  }
}

// ---- Menu assembly -------------------------------------------------------

type MenuRebuilder = () => Promise<void>;

/**
 * Build (or rebuild) the Open Recent submenu. Recreated from scratch
 * because Tauri v2's `Submenu` is immutable once assembled — no
 * `append`/`remove` API on the JS side at time of writing.
 */
async function buildRecentsSubmenu(
  handle: ChordSketchUiHandle,
  rebuildMenu: MenuRebuilder,
): Promise<Submenu> {
  const items: (MenuItem | PredefinedMenuItem)[] = [];
  if (recents.length === 0) {
    items.push(
      await MenuItem.new({
        id: 'recents-empty',
        text: 'No recent files',
        enabled: false,
      }),
    );
  } else {
    for (let i = 0; i < recents.length; i += 1) {
      const path = recents[i] as string;
      items.push(
        await MenuItem.new({
          id: `recent-${i}`,
          text: basename(path),
          action: () => {
            void runOpen(handle, rebuildMenu, path);
          },
        }),
      );
    }
    items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
    items.push(
      await MenuItem.new({
        id: 'recents-clear',
        text: 'Clear Recents',
        action: () => {
          recents = [];
          persistRecents(recents);
          void rebuildMenu();
        },
      }),
    );
  }
  return Submenu.new({ text: 'Open Recent', items });
}

async function buildAppMenu(
  handle: ChordSketchUiHandle,
  rebuildMenu: MenuRebuilder,
): Promise<Menu> {
  // The app version is read from the Tauri runtime so the About box
  // always reflects the running build — avoids drift versus a
  // hardcoded string when `apps/desktop/package.json` /
  // `Cargo.toml` / `tauri.conf.json` versions bump.
  const version = await getVersion();
  const [
    aboutItem,
    preferencesItem,
    hideItem,
    hideOthersItem,
    showAllItem,
    servicesItem,
    appMenuSepA,
    appMenuSepB,
    appMenuSepC,
    appMenuSepD,
    quitItem,
    newItem,
    openItem,
    saveItem,
    saveAsItem,
    exportPdfItem,
    exportHtmlItem,
    closeWindowItem,
    fileSepA,
    fileSepB,
    fileSepC,
    undoItem,
    redoItem,
    cutItem,
    copyItem,
    pasteItem,
    selectAllItem,
    editMenuSep,
    focusEditorItem,
    focusPreviewItem,
    viewMenuSep,
    transposeUpItem,
    transposeDownItem,
    editAsGridItem,
    editAsUrlTextItem,
    transposeResetItem,
    minimizeItem,
    maximizeItem,
    homepageItem,
  ] = await Promise.all([
    PredefinedMenuItem.new({
      item: {
        About: {
          name: DEFAULT_WINDOW_TITLE,
          version,
          // Application-layer license per CLAUDE.md §License Policy;
          // matches `apps/desktop/src-tauri/Cargo.toml`.
          license: 'AGPL-3.0-only',
          website: PROJECT_HOMEPAGE,
          websiteLabel: 'github.com/koedame/chordsketch',
          comments:
            'A ChordPro editor with live preview, transpose, and PDF export.',
        },
      },
    }),
    MenuItem.new({
      id: 'app-preferences',
      text: 'Preferences…',
      action: () => {
        void runPreferencesStub();
      },
    }),
    PredefinedMenuItem.new({ item: 'Hide' }),
    PredefinedMenuItem.new({ item: 'HideOthers' }),
    PredefinedMenuItem.new({ item: 'ShowAll' }),
    PredefinedMenuItem.new({ item: 'Services' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Quit' }),
    MenuItem.new({
      id: 'file-new',
      text: 'New',
      action: () => {
        void runNew(handle, rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'file-open',
      text: 'Open…',
      // Tauri's accelerator parser maps `CmdOrCtrl` to ⌘ on macOS
      // and `Ctrl` on Windows / Linux, matching the OS-conventional
      // bindings called for in #2206. The menu accelerator wins over
      // the WebView default (browser "Save Page As" for ⌘S, no
      // default for ⌘O / ⌘⇧S) because Tauri intercepts the chord at
      // the OS / window level before the WebView sees it, so the
      // CodeMirror editor (#2072) and the playground `<textarea>`
      // both remain unaffected.
      accelerator: 'CmdOrCtrl+O',
      action: () => {
        void runOpen(handle, rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'file-save',
      text: 'Save',
      accelerator: 'CmdOrCtrl+S',
      action: () => {
        void runSave(handle, rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'file-save-as',
      text: 'Save As…',
      accelerator: 'CmdOrCtrl+Shift+S',
      action: () => {
        void runSaveAs(handle, rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'export-pdf',
      text: 'Export PDF…',
      action: () => {
        void runExport(handle, 'pdf');
      },
    }),
    MenuItem.new({
      id: 'export-html',
      text: 'Export HTML…',
      action: () => {
        void runExport(handle, 'html');
      },
    }),
    PredefinedMenuItem.new({ item: 'CloseWindow' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    PredefinedMenuItem.new({ item: 'Undo' }),
    PredefinedMenuItem.new({ item: 'Redo' }),
    PredefinedMenuItem.new({ item: 'Cut' }),
    PredefinedMenuItem.new({ item: 'Copy' }),
    PredefinedMenuItem.new({ item: 'Paste' }),
    PredefinedMenuItem.new({ item: 'SelectAll' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    MenuItem.new({
      id: 'view-focus-editor',
      text: 'Focus Editor',
      // `CmdOrCtrl+Shift+E` and `CmdOrCtrl+Shift+P` were chosen to
      // avoid colliding with the editor-local navigation shortcuts
      // the AC for #2194 explicitly forbids — `<textarea>` and the
      // CodeMirror editor (#2072) leave both chords unbound, so the
      // OS-level menu intercept does not steal a key the user
      // expects to see in the editor. See the `file-open`
      // accelerator comment in this same `Promise.all` for the full
      // rationale on why the OS-level chord wins over the WebView.
      accelerator: 'CmdOrCtrl+Shift+E',
      action: () => {
        handle.focusEditor();
      },
    }),
    MenuItem.new({
      id: 'view-focus-preview',
      text: 'Focus Preview',
      accelerator: 'CmdOrCtrl+Shift+P',
      action: () => {
        handle.focusPreview();
      },
    }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    MenuItem.new({
      id: 'view-transpose-up',
      text: 'Transpose Up',
      // The issue (#2190) proposed `CmdOrCtrl+Up/Down`, but the same
      // AC also forbids colliding with editor-local navigation. On
      // macOS, CodeMirror's `standardKeymap` binds `Cmd-ArrowUp` /
      // `Cmd-ArrowDown` to `cursorDocStart` / `cursorDocEnd`, and
      // `<textarea>` uses the same chord for "move to start/end of
      // text" — there is no Home / End key on most Mac keyboards, so
      // shadowing those shortcuts at the OS-level menu would strand
      // users who want to jump to the document boundaries. The
      // `Alt` modifier (== ⌥ on macOS) takes the chord out of every
      // CodeMirror default map and out of the `<textarea>` defaults
      // on every platform, while staying close enough to the
      // proposed `Cmd+Up/Down` to remain discoverable. Logic Pro's
      // Option+Up/Down "transpose by semitone" convention is the
      // closest established precedent. See the `file-open`
      // accelerator comment in this same `Promise.all` for the
      // general rationale on why the OS-level chord wins over the
      // WebView.
      accelerator: 'CmdOrCtrl+Alt+ArrowUp',
      action: () => {
        handle.stepTranspose(1);
      },
    }),
    MenuItem.new({
      id: 'view-transpose-down',
      text: 'Transpose Down',
      accelerator: 'CmdOrCtrl+Alt+ArrowDown',
      action: () => {
        handle.stepTranspose(-1);
      },
    }),
    CheckMenuItem.new({
      id: 'view-edit-as-grid',
      text: 'Edit as Grid',
      // The pair below is a logical radio group: only one of
      // `view-edit-as-grid` / `view-edit-as-url-text` is checked at
      // a time. Tauri does not provide a `RadioMenuItem` primitive,
      // so we model the radio behaviour by toggling both checks via
      // the menu rebuild that fires after `setEditorMode`. Selecting
      // an already-checked item is a no-op via `setEditorMode`'s
      // same-mode guard. The CodeMirror mode (`chordpro`) leaves
      // both items unchecked; the View menu only carries the iRealb
      // surface choice because CodeMirror is the implicit fallback.
      checked: currentEditorMode === 'irealb-grid',
      action: () => {
        void setEditorMode(handle, 'irealb-grid', rebuildMenu);
      },
    }),
    CheckMenuItem.new({
      id: 'view-edit-as-url-text',
      text: 'Edit as URL Text',
      checked: currentEditorMode === 'irealb-text',
      action: () => {
        void setEditorMode(handle, 'irealb-text', rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'view-transpose-reset',
      text: 'Reset Transpose',
      // No accelerator: ⌘0 is the natural "reset" chord by web
      // convention but conflicts with browser zoom-reset, and there
      // is no second free chord that is obviously a "transpose
      // reset". Leaving the menu item without an accelerator keeps
      // the action discoverable while deferring the binding choice
      // — same pattern as `Export PDF…` / `Export HTML…`, which
      // ship without accelerators in this menu.
      action: () => {
        handle.resetTranspose();
      },
    }),
    PredefinedMenuItem.new({ item: 'Minimize' }),
    // macOS convention calls this "Zoom"; Tauri's predefined item
    // is `Maximize` and the platform layer renames the surface
    // string to "Zoom" on macOS itself.
    PredefinedMenuItem.new({ item: 'Maximize' }),
    MenuItem.new({
      id: 'help-homepage',
      text: 'Visit project homepage',
      action: () => {
        void runOpenHomepage();
      },
    }),
  ]);

  const recentsSubmenu = await buildRecentsSubmenu(handle, rebuildMenu);

  // macOS surfaces the first submenu's items under the application
  // name regardless of the `text` field; on Windows / Linux the
  // submenu is rendered with `DEFAULT_WINDOW_TITLE` as the label.
  // Items not applicable on a platform (Hide / HideOthers / ShowAll /
  // Services on Windows + Linux) are no-ops there — Tauri does the
  // platform filtering, so the same item list is safe everywhere.
  const appMenu = await Submenu.new({
    text: DEFAULT_WINDOW_TITLE,
    items: [
      aboutItem,
      appMenuSepA,
      preferencesItem,
      appMenuSepB,
      servicesItem,
      appMenuSepC,
      hideItem,
      hideOthersItem,
      showAllItem,
      appMenuSepD,
      quitItem,
    ],
  });
  const fileMenu = await Submenu.new({
    text: 'File',
    items: [
      newItem,
      openItem,
      recentsSubmenu,
      fileSepA,
      saveItem,
      saveAsItem,
      fileSepB,
      exportPdfItem,
      exportHtmlItem,
      fileSepC,
      closeWindowItem,
    ],
  });
  const editMenu = await Submenu.new({
    text: 'Edit',
    items: [
      undoItem,
      redoItem,
      editMenuSep,
      cutItem,
      copyItem,
      pasteItem,
      selectAllItem,
    ],
  });
  // The "Edit as Grid" / "Edit as URL Text" radio pair lives in its
  // own separator block (#2367) so the iRealb editing-surface choice
  // stays visually distinct from the focus and transpose clusters.
  const viewMenuSep2 = await PredefinedMenuItem.new({ item: 'Separator' });
  // View menu hosts the focus-toggle shortcuts (#2194), the transpose
  // shortcuts (#2190), and the iRealb editor-surface radio pair
  // (#2367). macOS HIG surfaces View between Edit and Window for
  // navigation-related commands, and the same item list renders
  // identically on Windows / Linux without further platform
  // branching. Each cluster is separated so a screen-reader user can
  // tell the three are conceptually distinct.
  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      focusEditorItem,
      focusPreviewItem,
      viewMenuSep,
      transposeUpItem,
      transposeDownItem,
      transposeResetItem,
      viewMenuSep2,
      editAsGridItem,
      editAsUrlTextItem,
    ],
  });
  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [minimizeItem, maximizeItem],
  });
  const helpMenu = await Submenu.new({
    text: 'Help',
    items: [homepageItem],
  });

  return Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu],
  });
}

/**
 * Install (or reinstall) the native menu bar. A rebuild happens
 * whenever the Open Recent list changes; `setAsAppMenu` replaces
 * the current menu atomically.
 */
async function installAppMenu(handle: ChordSketchUiHandle): Promise<void> {
  const rebuildMenu: MenuRebuilder = async () => {
    const menu = await buildAppMenu(handle, rebuildMenu);
    await menu.setAsAppMenu();
  };
  await rebuildMenu();
}

// ---- Close-requested prompt ---------------------------------------------

async function registerCloseGuard(handle: ChordSketchUiHandle): Promise<void> {
  const webview = getCurrentWebviewWindow();
  await webview.onCloseRequested(async (event) => {
    if (!isDirty(handle)) return;
    event.preventDefault();
    const confirmed = await ask(
      'You have unsaved changes. Quit without saving?',
      { title: 'Unsaved changes', kind: 'warning' },
    );
    if (confirmed) {
      await webview.destroy();
    }
  });
}

// ---- Bootstrap -----------------------------------------------------------

async function bootstrap(): Promise<void> {
  recents = loadRecents();

  const handle = await mountChordSketchUi(root as HTMLElement, {
    renderers,
    title: DEFAULT_WINDOW_TITLE,
    documentTitle: DEFAULT_WINDOW_TITLE,
    createEditor: codemirrorEditorFactory,
    onChordProChange: () => {
      // `updateWindowTitle` is async but fire-and-forget here —
      // the title only needs to update eventually, and racing
      // successive calls is fine because each reads `isDirty`
      // and the mutable state at call time.
      void updateWindowTitle(handle);
    },
  });

  // The ui-web mount seeds the editor with `SAMPLE_CHORDPRO` — capture
  // that as the initial "saved" state so a pristine launch doesn't
  // show the dirty indicator.
  lastSavedContent = handle.getChordPro();

  await installAppMenu(handle);
  await registerCloseGuard(handle);
  await updateWindowTitle(handle);

  // Fire the first update check + arm the 24-hour re-check loop.
  // Intentionally fire-and-forget: a failed check on a slow / no
  // network must not block the rest of the boot sequence. The
  // opt-out short-circuit lives inside `checkForUpdates`, so
  // calling `startAutoUpdateLoop()` unconditionally keeps the
  // wiring simple — the user's choice is re-read on every tick.
  autoUpdateCancel = startAutoUpdateLoop();
}

/**
 * Cancel handle returned by `startAutoUpdateLoop`. Module-scoped
 * because the menu handlers need to stop the loop when the user
 * toggles the opt-out preference.
 */
let autoUpdateCancel: (() => void) | null = null;

/**
 * Toggle the "Check for updates automatically" preference. Stops
 * the running loop when the user opts out, and restarts it on the
 * way back in so the next tick isn't a day away.
 */
export function toggleAutoUpdate(): void {
  const nextOptedOut = !isAutoUpdateOptedOut();
  setAutoUpdateOptOut(nextOptedOut);
  if (nextOptedOut) {
    autoUpdateCancel?.();
    autoUpdateCancel = null;
  } else if (!autoUpdateCancel) {
    autoUpdateCancel = startAutoUpdateLoop();
  }
}

/**
 * One-shot "Check for updates now" action — always runs, even if
 * auto-update is opted out, and shows the "up to date" dialog so
 * the user gets feedback on the explicit click. Returns once the
 * check (and any subsequent install) finishes.
 */
export async function checkForUpdatesNow(): Promise<void> {
  await checkForUpdates({ silent: false });
}

// `bootstrap()` drives the entire app startup — wasm init, UI mount,
// native menu install, close-guard registration, updater arming. If
// any of those reject, the user would otherwise be looking at a blank
// window with no explanation. Surface the failure through the native
// `message()` dialog when possible, then fall back to rendering a
// plain-text error into `#app` so the user at least sees the message
// on the (also rare) path where the dialog plugin itself is the one
// that failed (#2205).
bootstrap().catch((err: unknown) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('ChordSketch failed to start:', err);
  message(text, { title: 'ChordSketch failed to start', kind: 'error' }).catch(
    () => {
      if (root) {
        root.textContent = `ChordSketch failed to start:\n\n${text}`;
      }
    },
  );
});
