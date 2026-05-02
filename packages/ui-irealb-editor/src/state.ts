// Mutable editor state wrapping an `IrealSong` AST. Constructed once
// per editor mount, mutated in place by the form-event handlers in
// `render.ts`, and serialised back to an `irealb://` URL via the
// injected wasm bridge whenever a user-initiated edit completes.
//
// Why a class rather than a plain object: the class collocates the
// wasm bridge, the `dirty` flag, and the parse/serialize methods, so
// `render.ts` does not have to thread the wasm functions through
// every event handler. The state object itself is exposed via
// `state.song` for direct field mutation — no setters / no proxies,
// matching the "plain DOM, plain TS" idiom used throughout `ui-web`.

import type { IrealSong } from './ast.js';

/** Narrow surface of `@chordsketch/wasm` this package consumes. The
 * factory caller injects an object satisfying this shape (the
 * playground / desktop entry points pass the exported wasm functions
 * directly); tests inject a stub. Keeping the surface tiny lets the
 * package have a peer-dep on `@chordsketch/wasm` without re-exporting
 * its full type graph. */
export interface IrealbWasm {
  /** Parse an `irealb://` URL into an AST-shaped JSON string.
   * Throws on malformed input. */
  parseIrealb(input: string): string;
  /** Serialize an AST-shaped JSON string into an `irealb://` URL.
   * Throws on malformed JSON. */
  serializeIrealb(input: string): string;
}

/** Mutable editor state. Owns the parsed `IrealSong` and the wasm
 * bridge so callers do not have to thread either through event
 * handlers. */
export class IrealbEditorState {
  /** Parsed AST. Direct field mutation (`state.song.title = '...'`)
   * is the supported way to apply edits — `serialize()` reads the
   * current value at call time. */
  song: IrealSong;

  private readonly wasm: IrealbWasm;

  constructor(wasm: IrealbWasm, initial: IrealSong) {
    this.wasm = wasm;
    this.song = initial;
  }

  /** Replace the in-memory AST by parsing a new `irealb://` URL.
   * Throws on parse failure; callers should `try`/`catch` and
   * surface the error to the user — silently swallowing produces
   * a stale-display bug where the form fields keep showing the
   * pre-load values. */
  loadFromUrl(url: string): void {
    const json = this.wasm.parseIrealb(url);
    this.song = JSON.parse(json) as IrealSong;
  }

  /** Serialise the current AST back to an `irealb://` URL. */
  toUrl(): string {
    const json = JSON.stringify(this.song);
    return this.wasm.serializeIrealb(json);
  }
}

/** Build an `IrealbEditorState` from an `irealb://` URL. Used by
 * `createIrealbEditor` to seed state from `EditorFactoryOptions.initialValue`.
 * Throws on parse failure. */
export function makeStateFromUrl(wasm: IrealbWasm, url: string): IrealbEditorState {
  const json = wasm.parseIrealb(url);
  const song = JSON.parse(json) as IrealSong;
  return new IrealbEditorState(wasm, song);
}
