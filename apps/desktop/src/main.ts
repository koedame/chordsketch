import init, {
  render_html,
  render_text,
  render_pdf,
  render_html_with_options,
  render_text_with_options,
  render_pdf_with_options,
} from '@chordsketch/wasm';
import {
  mountChordSketchUi,
  type ChordSketchUiHandle,
  type Renderers,
} from '@chordsketch/ui-web';
import '@chordsketch/ui-web/style.css';
import { invoke } from '@tauri-apps/api/core';
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from '@tauri-apps/api/menu';
import { message, save } from '@tauri-apps/plugin-dialog';

type ExportFormat = 'pdf' | 'html';

const EXPORT_FILTERS: Record<
  ExportFormat,
  { name: string; extensions: string[] }
> = {
  pdf: { name: 'PDF', extensions: ['pdf'] },
  html: { name: 'HTML', extensions: ['html', 'htm'] },
};

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
  const path = await save({
    defaultPath: `chordsketch.${format}`,
    filters: [EXPORT_FILTERS[format]],
  });
  if (!path) return; // User cancelled the save dialog.

  try {
    const transpose = handle.getTranspose();
    await invoke(format === 'pdf' ? 'export_pdf' : 'export_html', {
      path,
      chordpro: handle.getChordPro(),
      // Only forward a non-zero transpose so the Rust side can
      // follow the same identity-skip that the WASM adapter uses
      // in `renderers` above.
      transpose: transpose === 0 ? null : transpose,
    });
    await message(`Exported to ${path}`, {
      title: 'ChordSketch',
      kind: 'info',
    });
  } catch (err) {
    await message(err instanceof Error ? err.message : String(err), {
      title: 'Export failed',
      kind: 'error',
    });
  }
}

/**
 * Install a minimal native menu bar that matches platform
 * conventions (macOS top menu bar / Windows + Linux window menu):
 *
 * - ChordSketch → Quit  (anchors the macOS app menu slot so users
 *   don't lose `⌘Q`; Linux/Windows still render this as the first
 *   submenu but that's OK)
 * - File → Export PDF…, Export HTML…, Close Window
 * - Edit → Undo/Redo/Cut/Copy/Paste/Select All  (Tauri's custom
 *   app menu replaces the native default, so the clipboard items
 *   must be reintroduced explicitly or `⌘C`/`⌘V` stop working in
 *   the `<textarea>` on macOS)
 */
async function installAppMenu(handle: ChordSketchUiHandle): Promise<void> {
  const [
    quitItem,
    exportPdfItem,
    exportHtmlItem,
    closeWindowItem,
    undoItem,
    redoItem,
    cutItem,
    copyItem,
    pasteItem,
    selectAllItem,
    editMenuSep,
  ] = await Promise.all([
    PredefinedMenuItem.new({ item: 'Quit' }),
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
    PredefinedMenuItem.new({ item: 'Undo' }),
    PredefinedMenuItem.new({ item: 'Redo' }),
    PredefinedMenuItem.new({ item: 'Cut' }),
    PredefinedMenuItem.new({ item: 'Copy' }),
    PredefinedMenuItem.new({ item: 'Paste' }),
    PredefinedMenuItem.new({ item: 'SelectAll' }),
    PredefinedMenuItem.new({ item: 'Separator' }),
  ]);

  const appMenu = await Submenu.new({
    text: 'ChordSketch',
    items: [quitItem],
  });
  const fileMenu = await Submenu.new({
    text: 'File',
    items: [exportPdfItem, exportHtmlItem, closeWindowItem],
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

  const menu = await Menu.new({ items: [appMenu, fileMenu, editMenu] });
  await menu.setAsAppMenu();
}

async function bootstrap(): Promise<void> {
  const handle = await mountChordSketchUi(root as HTMLElement, {
    renderers,
    title: 'ChordSketch',
    documentTitle: 'ChordSketch',
  });
  await installAppMenu(handle);
}

void bootstrap();
