import init, {
  render_text,
  render_pdf,
  render_text_with_options,
  render_pdf_with_options,
  render_html_body,
  render_html_body_with_options,
  render_html_css,
  render_html_css_with_options,
} from '@chordsketch/wasm';
import {
  mountChordSketchUi,
  type ChordSketchUiHandle,
  type Renderers,
} from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';
import './codemirror-editor.css';
import { codemirrorEditorFactory } from './codemirror-editor';
import { invoke } from '@tauri-apps/api/core';
import {
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

const CHORDPRO_FILTERS = [
  { name: 'ChordPro', extensions: ['cho', 'chopro', 'crd', 'chordpro'] },
  { name: 'All files', extensions: ['*'] },
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
// nested-document recovery — the same structural defect described in
// `packages/playground/src/main.ts` and the WebView is the same
// embedding context (Chromium-derived WebView2 / WKWebView), so the
// fix must propagate per `.claude/rules/fix-propagation.md`.
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
};

const root = document.getElementById('app');
if (!root) {
  throw new Error('Desktop entry point #app element missing from index.html');
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
      filters: CHORDPRO_FILTERS,
    });
    if (typeof picked === 'string') target = picked;
    if (!target) return; // User cancelled.
  }

  try {
    const content = await invoke<string>('open_file', { path: target });
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
  const picked = await save({
    defaultPath: currentPath ?? `${UNTITLED_LABEL.toLowerCase()}.cho`,
    filters: CHORDPRO_FILTERS,
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
  // View menu hosts the focus-toggle shortcuts (#2194) and the
  // transpose shortcuts (#2190). macOS HIG surfaces View between
  // Edit and Window for navigation-related commands, and the same
  // item list renders identically on Windows / Linux without
  // further platform branching. The transpose group is separated
  // from the focus-toggle group so a screen-reader user can tell
  // the two are conceptually distinct, even though they share the
  // submenu.
  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      focusEditorItem,
      focusPreviewItem,
      viewMenuSep,
      transposeUpItem,
      transposeDownItem,
      transposeResetItem,
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
