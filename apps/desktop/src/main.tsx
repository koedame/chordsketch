/**
 * Desktop frontend entry point.
 *
 * Mounts the React `<App />` tree into `#app` and wires up the
 * native Tauri menu / dialog / updater layer. All editor / preview
 * state lives inside React; the menu handlers below interact with
 * that state through {@link desktopBridge} — see
 * `desktop-bridge.ts` for the rationale.
 *
 * Tauri-facing handlers (Open / Save / Export, the View menu radios,
 * the updater) read/write state through `desktopBridge` rather than
 * touching the React tree directly.
 */
import { createRoot } from 'react-dom/client';
import init, { parseIrealb } from '@chordsketch/wasm';
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

import { App } from './App';
import { desktopBridge, type EditorMode } from './desktop-bridge';
import './codemirror-editor.css';
// The iRealb bar-grid GUI editor renders directly into DOM that
// is not styled by `@chordsketch/react/styles.css`; the package
// ships its own stylesheet which we load alongside.
import '@chordsketch/ui-irealb-editor/style.css';
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
// menu handlers can update them without plumbing the state through
// every async boundary. These are NOT part of the React state tree
// — they track file-on-disk state, recents, and last-saved
// snapshot, which are orthogonal to the editor buffer.
let currentPath: string | null = null;
let lastSavedContent = '';
let recents: string[] = [];

/**
 * Cancel handle returned by `startAutoUpdateLoop`. Module-scoped
 * because the menu handlers need to stop the loop when the user
 * toggles the opt-out preference.
 */
let autoUpdateCancel: (() => void) | null = null;

// ---- Editor mode ---------------------------------------------------------
//
// The React `<App />` owns the canonical mode value. These helpers
// only assist the file-dispatch and menu code below.

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
 * Swap the active editor mode and update the radio-style View
 * menu items to reflect the new mode. Calling with the same mode
 * is a no-op (avoids an unnecessary React rerender + menu rebuild).
 *
 * Pre-flight check for the chordpro → irealb-grid transition: the
 * iRealb grid editor calls `parseIrealb()` synchronously on the
 * carried-over content and throws if it is not a valid `irealb://`
 * URL. Validate up-front and ask the user to discard the ChordPro
 * buffer before switching when needed.
 */
async function setEditorMode(
  mode: EditorMode,
  rebuildMenu: MenuRebuilder,
): Promise<void> {
  if (desktopBridge.getMode() === mode) return;
  if (mode === 'irealb-grid') {
    const carryover = desktopBridge.getSource();
    if (carryover.length > 0 && !canParseAsIrealbUrl(carryover)) {
      const confirmed = await ask(
        'The current document is not an iRealb URL. Switching to grid ' +
          'mode will discard the current content. Continue?',
        { title: 'Switch to grid mode?', kind: 'warning' },
      );
      if (!confirmed) return;
      // Clear before swap so the grid editor seeds an empty song
      // instead of throwing on `parseIrealb('not-a-url')`.
      desktopBridge.setSource('');
    }
  }
  desktopBridge.setMode(mode);
  await rebuildMenu();
  await updateWindowTitle();
}

/**
 * Synchronous probe: does `value` parse as an `irealb://` URL via
 * the wasm `parseIrealb` exported function? Returns `false` on any
 * thrown error. Used by `setEditorMode` and `runOpen` to validate
 * before any destructive state mutation.
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
    // failure.
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

function isDirty(): boolean {
  return desktopBridge.getSource() !== lastSavedContent;
}

async function updateWindowTitle(): Promise<void> {
  const label = currentPath ? basename(currentPath) : UNTITLED_LABEL;
  const prefix = isDirty() ? '• ' : '';
  await getCurrentWebviewWindow().setTitle(
    `${prefix}${label} — ${DEFAULT_WINDOW_TITLE}`,
  );
}

// ---- File operations -----------------------------------------------------

async function runOpen(
  rebuildMenu: MenuRebuilder,
  path?: string,
): Promise<void> {
  // Dirty-state check happens BEFORE any file picker so the user
  // isn't made to pick a file only to be told their work would be
  // discarded. The recent-file path (`path` already supplied) funnels
  // through the same guard so a stray click on "Open Recent" does
  // not silently clobber unsaved edits either.
  if (isDirty()) {
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
    // malformed iRealb file cannot leave the app half-swapped.
    if (targetMode === 'irealb-grid' && !canParseAsIrealbUrl(content)) {
      await message(
        'This file does not contain a valid irealb:// URL.',
        { title: 'Open failed', kind: 'error' },
      );
      return;
    }
    if (targetMode !== null && targetMode !== desktopBridge.getMode()) {
      // Clear the current editor before swapping so the new mode's
      // initial value is empty. Otherwise a chordpro → irealb-grid
      // transition would feed `parseIrealb` ChordPro text and
      // throw.
      desktopBridge.setSource('');
      desktopBridge.setMode(targetMode);
      // Rebuild the menu inside the swap window so the View radio
      // immediately reflects the new mode, even though the
      // post-load rebuild below would otherwise pick it up.
      await rebuildMenu();
    }
    // Load the file content into the (now correctly typed) editor.
    desktopBridge.setSource(content);
    currentPath = target;
    lastSavedContent = content;
    pushRecent(target);
    await rebuildMenu();
    await updateWindowTitle();
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
 * path.
 */
async function runNew(rebuildMenu: MenuRebuilder): Promise<void> {
  if (isDirty()) {
    const confirmed = await ask(
      'You have unsaved changes. Start a new document and discard them?',
      { title: 'Discard unsaved changes?', kind: 'warning' },
    );
    if (!confirmed) return;
  }
  desktopBridge.setSource('');
  currentPath = null;
  lastSavedContent = '';
  await rebuildMenu();
  await updateWindowTitle();
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
 * platform-conventional "Preferences…" entry.
 */
async function runPreferencesStub(): Promise<void> {
  await message('Preferences are not yet available in this build.', {
    title: 'Preferences',
    kind: 'info',
  });
}

async function runSave(rebuildMenu: MenuRebuilder): Promise<void> {
  if (!currentPath) {
    await runSaveAs(rebuildMenu);
    return;
  }
  await writeCurrent(currentPath);
}

async function runSaveAs(rebuildMenu: MenuRebuilder): Promise<void> {
  // Suggest a default extension that matches the active editor
  // mode. Saving an `.cho` file containing an `irealb://` URL would
  // otherwise be classified as ChordPro by every consumer that keys
  // off the file extension.
  const defaultExt =
    desktopBridge.getMode() === 'chordpro' ? 'cho' : 'irealb';
  const picked = await save({
    defaultPath: currentPath ?? `${UNTITLED_LABEL.toLowerCase()}.${defaultExt}`,
    filters: OPEN_SAVE_FILTERS,
  });
  if (!picked) return;

  // Point `currentPath` at the new destination BEFORE the write so
  // the in-flight `updateWindowTitle` call inside `writeCurrent`
  // reads the new filename. Roll back on failure so the next
  // `runSave` reopens the picker rather than silently retrying.
  const previousPath = currentPath;
  currentPath = picked;
  const ok = await writeCurrent(picked);
  if (!ok) {
    currentPath = previousPath;
    await updateWindowTitle();
    return;
  }
  pushRecent(picked);
  await rebuildMenu();
  await updateWindowTitle();
}

async function writeCurrent(path: string): Promise<boolean> {
  const content = desktopBridge.getSource();
  try {
    await invoke('save_file', { path, content });
    lastSavedContent = content;
    await updateWindowTitle();
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
 * dialog stays compact on small laptops.
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
 * offset from the React tree (via `desktopBridge`), show the native
 * save dialog, and invoke the matching Rust command.
 *
 * The Rust renderer is used deliberately (not the WASM in the
 * WebView) — export output is byte-for-byte consistent with the
 * CLI / FFI builds.
 */
async function runExport(format: ExportFormat): Promise<void> {
  try {
    const path = await save({
      defaultPath: `chordsketch.${format}`,
      filters: [EXPORT_FILTERS[format]],
    });
    if (!path) return;

    const transpose = desktopBridge.getTranspose();
    const warnings = (await invoke<string[]>(
      format === 'pdf' ? 'export_pdf' : 'export_html',
      {
        path,
        chordpro: desktopBridge.getSource(),
        // Only forward a non-zero transpose so the Rust side can
        // follow the same identity-skip the WASM render path uses.
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
async function buildRecentsSubmenu(rebuildMenu: MenuRebuilder): Promise<Submenu> {
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
            void runOpen(rebuildMenu, path);
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

async function buildAppMenu(rebuildMenu: MenuRebuilder): Promise<Menu> {
  // The app version is read from the Tauri runtime so the About box
  // always reflects the running build.
  const version = await getVersion();
  const currentMode = desktopBridge.getMode();
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
        void runNew(rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'file-open',
      text: 'Open…',
      accelerator: 'CmdOrCtrl+O',
      action: () => {
        void runOpen(rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'file-save',
      text: 'Save',
      accelerator: 'CmdOrCtrl+S',
      action: () => {
        void runSave(rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'file-save-as',
      text: 'Save As…',
      accelerator: 'CmdOrCtrl+Shift+S',
      action: () => {
        void runSaveAs(rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'export-pdf',
      text: 'Export PDF…',
      action: () => {
        void runExport('pdf');
      },
    }),
    MenuItem.new({
      id: 'export-html',
      text: 'Export HTML…',
      action: () => {
        void runExport('html');
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
      accelerator: 'CmdOrCtrl+Shift+E',
      action: () => {
        desktopBridge.focusEditor();
      },
    }),
    MenuItem.new({
      id: 'view-focus-preview',
      text: 'Focus Preview',
      accelerator: 'CmdOrCtrl+Shift+P',
      action: () => {
        desktopBridge.focusPreview();
      },
    }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    MenuItem.new({
      id: 'view-transpose-up',
      text: 'Transpose Up',
      accelerator: 'CmdOrCtrl+Alt+ArrowUp',
      action: () => {
        desktopBridge.stepTranspose(1);
      },
    }),
    MenuItem.new({
      id: 'view-transpose-down',
      text: 'Transpose Down',
      accelerator: 'CmdOrCtrl+Alt+ArrowDown',
      action: () => {
        desktopBridge.stepTranspose(-1);
      },
    }),
    CheckMenuItem.new({
      id: 'view-edit-as-grid',
      text: 'Edit as Grid',
      checked: currentMode === 'irealb-grid',
      action: () => {
        void setEditorMode('irealb-grid', rebuildMenu);
      },
    }),
    CheckMenuItem.new({
      id: 'view-edit-as-url-text',
      text: 'Edit as URL Text',
      checked: currentMode === 'irealb-text',
      action: () => {
        void setEditorMode('irealb-text', rebuildMenu);
      },
    }),
    MenuItem.new({
      id: 'view-transpose-reset',
      text: 'Reset Transpose',
      action: () => {
        desktopBridge.resetTranspose();
      },
    }),
    PredefinedMenuItem.new({ item: 'Minimize' }),
    PredefinedMenuItem.new({ item: 'Maximize' }),
    MenuItem.new({
      id: 'help-homepage',
      text: 'Visit project homepage',
      action: () => {
        void runOpenHomepage();
      },
    }),
  ]);

  const recentsSubmenu = await buildRecentsSubmenu(rebuildMenu);

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
  // own separator block so the iRealb editing-surface choice stays
  // visually distinct from the focus and transpose clusters.
  const viewMenuSep2 = await PredefinedMenuItem.new({ item: 'Separator' });
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
 * whenever the Open Recent list or the editor mode changes;
 * `setAsAppMenu` replaces the current menu atomically.
 */
async function installAppMenu(): Promise<void> {
  const rebuildMenu: MenuRebuilder = async () => {
    const menu = await buildAppMenu(rebuildMenu);
    await menu.setAsAppMenu();
  };
  await rebuildMenu();
}

// ---- Close-requested prompt ---------------------------------------------

async function registerCloseGuard(): Promise<void> {
  const webview = getCurrentWebviewWindow();
  await webview.onCloseRequested(async (event) => {
    if (!isDirty()) return;
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

async function bootstrap(rootEl: HTMLElement): Promise<void> {
  recents = loadRecents();

  // Initialise the wasm bundle before mounting React — the React
  // tree's `<ChordProPreview>` and `<IrealPreview>` lazy-load it
  // themselves, but doing it up-front means the first render does
  // not flash through the "loading" placeholder.
  await init();

  // Mount the React root. `<App />` registers its listener with
  // `desktopBridge` inside a layout effect, so by the time
  // `createRoot.render` returns the listener may not yet be
  // available — we await a microtask via the source-change
  // subscription before reading the seeded buffer.
  const reactRoot = createRoot(rootEl);
  reactRoot.render(<App />);

  // Wait until the React tree has registered with the bridge.
  await waitForBridge();

  // The React `<App />` seeds the editor with `SAMPLE_CHORDPRO` —
  // capture that as the initial "saved" state so a pristine launch
  // doesn't show the dirty indicator.
  lastSavedContent = desktopBridge.getSource();

  // Drive the window-title dirty marker off the bridge's source-
  // change side channel. React owns the source of truth and we
  // subscribe to user-edit changes here.
  desktopBridge.onSourceChange(() => {
    void updateWindowTitle();
  });

  await installAppMenu();
  await registerCloseGuard();
  await updateWindowTitle();

  // Fire the first update check + arm the 24-hour re-check loop.
  // Intentionally fire-and-forget: a failed check on a slow / no
  // network must not block the rest of the boot sequence.
  autoUpdateCancel = startAutoUpdateLoop();
}

/**
 * Wait for `<App />` to register its listener with the bridge.
 * React commits its layout effects synchronously after the initial
 * render (`createRoot.render` is async on React 18, but `flushSync`
 * inside the implementation drains layout effects before returning
 * from the next microtask), so a single microtask flush is enough
 * in practice. The 50 ms safety cap guards against any future React
 * change that would defer effect commits further; if it fires, the
 * later `desktopBridge` accessors will throw their descriptive
 * "no listener attached" error so the failure is loud.
 */
async function waitForBridge(): Promise<void> {
  const deadline = Date.now() + 50;
  while (!desktopBridge.isAttached()) {
    if (Date.now() > deadline) return;
    // Yield to the React scheduler / commit queue. A 0 ms timer
    // satisfies the microtask drain; an explicit `Promise.resolve()`
    // alone is not enough because React commits effects in a
    // separate macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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
 * the user gets feedback on the explicit click.
 */
export async function checkForUpdatesNow(): Promise<void> {
  await checkForUpdates({ silent: false });
}

// `bootstrap()` drives the entire app startup — wasm init, React
// mount, native menu install, close-guard registration, updater
// arming. If any of those reject, the user would otherwise be
// looking at a blank window with no explanation. Surface the
// failure through the native `message()` dialog when possible,
// then fall back to rendering a plain-text error into `#app` so
// the user at least sees the message on the (also rare) path where
// the dialog plugin itself is the one that failed.
const root = document.getElementById('app');
if (!root) {
  throw new Error('Desktop entry point #app element missing from index.html');
}

bootstrap(root).catch((err: unknown) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // eslint-disable-next-line no-console
  console.error('ChordSketch failed to start:', err);
  message(text, { title: 'ChordSketch failed to start', kind: 'error' }).catch(
    () => {
      root.textContent = `ChordSketch failed to start:\n\n${text}`;
    },
  );
});
