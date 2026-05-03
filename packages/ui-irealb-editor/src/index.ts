// `@chordsketch/ui-irealb-editor` — public entry point.
//
// `createIrealbEditor(options)` builds an `EditorAdapter`-shaped
// object that drops into `@chordsketch/ui-web`'s
// `MountOptions.createEditor` slot. The adapter:
//
//   1. Parses `options.initialValue` (an `irealb://` URL) via the
//      injected `wasm.parseIrealb`.
//   2. Renders a header form (title / composer / style / key / time
//      / tempo / transpose) plus a read-only bar grid that shows
//      each bar's chords joined by spaces.
//   3. On every header-form mutation, re-serialises the song to a
//      URL via `wasm.serializeIrealb` and dispatches the resulting
//      string to every `onChange` subscriber.
//
// This first iteration intentionally leaves the bar grid read-only.
// Bar-popover editing arrives in #2364, structural section / bar
// edits in #2365, keyboard navigation + ARIA in #2368.

import type { IrealSong } from './ast.js';
import { clearChildren } from './dom.js';
import { render, type RenderHandle } from './render.js';
import { IrealbEditorState, type IrealbWasm, makeStateFromUrl } from './state.js';

export type { IrealSong } from './ast.js';
export type { IrealbWasm } from './state.js';
export { SAMPLE_IREALB } from './sample.js';

/** Subset of `@chordsketch/ui-web`'s `EditorAdapter` this package
 * implements. Re-declared here (rather than imported from
 * `@chordsketch/ui-web`) so the editor stays usable in environments
 * that do not depend on `ui-web` directly — tests, future hosts,
 * and the standalone consumer scenarios called out in #2363. The
 * shape MUST stay byte-equal to `EditorAdapter` in
 * `packages/ui-web/src/index.ts`; if the contract there changes,
 * update this declaration in the same PR. */
export interface EditorAdapter {
  element: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  onChange(handler: (value: string) => void): () => void;
  focus?(): void;
  destroy(): void;
}

/** Options accepted by {@link createIrealbEditor}. The first two
 * fields mirror `@chordsketch/ui-web`'s `EditorFactoryOptions` so
 * this factory drops directly into the `MountOptions.createEditor`
 * slot — the host wraps it in a closure that captures `wasm`. */
export interface CreateIrealbEditorOptions {
  /** Initial `irealb://` URL. Empty string seeds an empty chart
   * (`makeEmptySong()` below) instead of throwing. */
  initialValue: string;
  /** Reserved for parity with `EditorFactoryOptions`; currently
   * unused — the iReal editor does not have a single text-input
   * placeholder. */
  placeholder?: string;
  /** Injected wasm bridge. The host (playground / desktop /
   * tests) supplies an object whose two methods come from
   * `@chordsketch/wasm`'s `parseIrealb` / `serializeIrealb`. */
  wasm: IrealbWasm;
}

/** Build an `EditorAdapter` mounted inside a freshly-created `<div>`.
 * Caller appends `adapter.element` into the desired DOM container. */
export function createIrealbEditor(options: CreateIrealbEditorOptions): EditorAdapter {
  const { initialValue, wasm } = options;

  const element = document.createElement('div');
  element.classList.add('irealb-editor');

  const state = initialValue.length > 0
    ? makeStateFromUrl(wasm, initialValue)
    : new IrealbEditorState(wasm, makeEmptySong());

  const changeHandlers = new Set<(value: string) => void>();
  let renderHandle: RenderHandle | null = null;
  let destroyed = false;

  const fireUserEdit = (): void => {
    if (destroyed) return;
    // Form-event handlers in render.ts only assign known-valid
    // primitives (range-checked numerics, allow-listed enum values,
    // free-text strings) to the AST. The AST therefore stays in a
    // serialisable state across every user edit, so toUrl() is
    // expected to succeed. A throw here means a bug — either in
    // this package's mutation logic or in the wasm serialiser —
    // that we want surfaced, not swallowed. Let the throw propagate
    // out of the DOM event handler; the host's window.onerror /
    // ErrorBoundary equivalent picks it up.
    const url = state.toUrl();
    for (const handler of changeHandlers) handler(url);
  };

  const renderNow = (): void => {
    if (renderHandle !== null) {
      renderHandle.dispose();
      renderHandle = null;
    }
    renderHandle = render(element, state, fireUserEdit);
  };

  renderNow();

  return {
    element,
    getValue(): string {
      if (destroyed) return '';
      // toUrl() throws on a non-serialisable AST. The form-driven
      // mutation paths cannot produce one (see fireUserEdit's
      // rationale), so reaching the throw branch means a bug. Let
      // it propagate rather than silently masking it as an empty
      // chart — the host can distinguish "no chart loaded" (would
      // call setValue('') first, getValue returns '') from "chart
      // failed to serialise" (a thrown Error) only if we propagate.
      return state.toUrl();
    },
    setValue(value: string): void {
      if (destroyed) return;
      // Per `EditorAdapter` contract: setValue MUST NOT fire
      // onChange — it represents a host-driven load, not a user
      // edit. We rebuild the DOM (so form fields reflect the new
      // state) but do not call `fireUserEdit`.
      if (value.length === 0) {
        state.song = makeEmptySong();
      } else {
        state.loadFromUrl(value);
      }
      renderNow();
    },
    onChange(handler: (value: string) => void): () => void {
      changeHandlers.add(handler);
      return () => {
        changeHandlers.delete(handler);
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (renderHandle !== null) {
        renderHandle.dispose();
        renderHandle = null;
      }
      changeHandlers.clear();
      clearChildren(element);
    },
  };
}

/** Empty-chart factory used for the `initialValue === ''` path and
 * the `setValue('')` path. Mirrors Rust `IrealSong::new`: C major,
 * 4/4, no metadata, no sections. */
function makeEmptySong(): IrealSong {
  return {
    title: '',
    composer: null,
    style: null,
    key_signature: {
      root: { note: 'C', accidental: 'natural' },
      mode: 'major',
    },
    time_signature: {
      numerator: 4,
      denominator: 4,
    },
    tempo: null,
    transpose: 0,
    sections: [],
  };
}
