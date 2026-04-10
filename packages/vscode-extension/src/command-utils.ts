/**
 * Pure utility functions for the `chordsketch.convertTo` command.
 *
 * Extracted into a separate module so they can be exercised by Node.js unit
 * tests without importing VS Code's extension host APIs.
 */

import * as path from 'path';

/** Label constants for the export format QuickPick. */
export const FORMAT_HTML = 'HTML' as const;
export const FORMAT_TEXT = 'Plain text' as const;
export const FORMAT_PDF = 'PDF' as const;

/** Union of the three supported export format labels. */
export type ExportFormat = typeof FORMAT_HTML | typeof FORMAT_TEXT | typeof FORMAT_PDF;

/**
 * Minimal type for the exports consumed from the `@chordsketch/wasm` Node.js
 * CJS build that is copied to `dist/node/` at build time.  Only the three
 * render functions used by `convertTo` are declared here.
 *
 * **Throws**: All three functions throw a JS exception on render failure
 * (the Rust wasm-bindgen glue converts `Err(JsValue)` into a thrown JS
 * value).  Callers must always wrap invocations in a try/catch.
 *
 * **HTML security note**: `render_html` produces a self-contained
 * `<!DOCTYPE html>` document.  Delegate-section environments such as
 * `{start_of_textblock}` emit their content verbatim (by spec).  The
 * exported file must therefore NOT be served to untrusted users without
 * additional sanitisation — it reflects the same content as the source
 * `.cho` file, which the user is assumed to own.
 */
export interface WasmRenderModule {
  render_html(input: string): string;
  render_text(input: string): string;
  render_pdf(input: string): Uint8Array;
}

/**
 * Type guard that verifies a `require()` result exposes the three render
 * functions expected from `@chordsketch/wasm`.
 *
 * Prevents a silently broken or zero-byte copy of the WASM module from being
 * permanently cached after it is first loaded.  Without this check a module
 * object that is truthy but whose exports are absent (e.g., an incomplete
 * deployment) would be cached indefinitely, causing every subsequent export
 * attempt in the session to fail with `TypeError: wasm.render_X is not a
 * function`.
 */
export function isWasmRenderModule(m: unknown): m is WasmRenderModule {
  if (typeof m !== 'object' || m === null) {
    return false;
  }
  const mod = m as Record<string, unknown>;
  return (
    typeof mod['render_html'] === 'function' &&
    typeof mod['render_text'] === 'function' &&
    typeof mod['render_pdf'] === 'function'
  );
}

/**
 * Returns the default file extension for an export format.
 *
 * @param format - One of the three supported export formats.
 * @returns The file extension string including the leading dot.
 */
export function extensionForFormat(format: ExportFormat): string {
  if (format === FORMAT_PDF) return '.pdf';
  if (format === FORMAT_TEXT) return '.txt';
  return '.html';
}

/**
 * Derives the default save path for an exported file.
 *
 * The source file's extension (if any) is stripped and replaced with the
 * target format extension.  For files without an extension (e.g., `mysong`)
 * the format extension is appended.  For hidden files whose name starts with
 * a dot (e.g., `.chordpro`) `path.extname` returns an empty string, so the
 * dot-name is kept as the stem and the format extension is appended (e.g.,
 * `.chordpro.html`).
 *
 * Examples:
 * - `song.cho` + `.html`     → `song.html`
 * - `song.cho` + `.pdf`      → `song.pdf`
 * - `song`     + `.html`     → `song.html`
 * - `.chordpro`+ `.html`     → `.chordpro.html`
 *
 * @param fsPath - Absolute filesystem path of the source ChordPro file.
 * @param ext - Target extension including the leading dot (e.g., `.html`).
 * @returns The absolute path with the source extension replaced by `ext`.
 */
export function defaultExportPath(fsPath: string, ext: string): string {
  const dir = path.dirname(fsPath);
  const stem = path.basename(fsPath, path.extname(fsPath));
  return path.join(dir, stem + ext);
}
