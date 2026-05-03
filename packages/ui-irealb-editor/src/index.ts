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
// As of #2364, bar cells are interactive — clicking opens a popover
// dialog that edits every field of the underlying `Bar` (start /
// end barlines, chord rows, optional N-th ending number, optional
// musical symbol). Structural section / bar edits arrive in #2365,
// keyboard navigation + ARIA in #2368.

import type { Bar, IrealSong, Section, SectionLabel } from './ast.js';
import { clearChildren } from './dom.js';
import { openBarPopover, type BarPopoverHandle } from './popover.js';
import { render, type RenderHandle, type StructuralOps } from './render.js';
import { IrealbEditorState, type IrealbWasm, makeStateFromUrl } from './state.js';

export type { IrealSong, SectionLabel } from './ast.js';
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
  /** Optional override for the section-label prompt (#2365). The
   * default uses `window.prompt` to ask for `"A"` / `"Verse"` /
   * `"Chorus"` / `"Intro"` / `"Outro"` / `"Bridge"` / single
   * letter / arbitrary text; tests inject a stub that returns a
   * canned label without blocking on the modal prompt. Returning
   * `null` cancels the operation (no AST mutation). */
  promptSectionLabel?: (current: SectionLabel | null) => SectionLabel | null;
  /** Optional override for the delete-section confirmation
   * (#2365). Defaults to `window.confirm`. Tests inject a stub
   * that returns a canned boolean. Returning `false` cancels the
   * delete (no AST mutation). */
  confirmDeleteSection?: (label: SectionLabel) => boolean;
}

/** Build an `EditorAdapter` mounted inside a freshly-created `<div>`.
 * Caller appends `adapter.element` into the desired DOM container. */
export function createIrealbEditor(options: CreateIrealbEditorOptions): EditorAdapter {
  const {
    initialValue,
    wasm,
    promptSectionLabel = defaultPromptSectionLabel,
    confirmDeleteSection = defaultConfirmDeleteSection,
  } = options;

  const element = document.createElement('div');
  element.classList.add('irealb-editor');

  const state = initialValue.length > 0
    ? makeStateFromUrl(wasm, initialValue)
    : new IrealbEditorState(wasm, makeEmptySong());

  const changeHandlers = new Set<(value: string) => void>();
  let renderHandle: RenderHandle | null = null;
  let popoverHandle: BarPopoverHandle | null = null;
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

  // Bar-popover open callback. The renderer hands us the `bar` plus
  // its (sectionIndex, barIndex) so we can splice the saved value
  // back into the AST without rebuilding it from object identity
  // (which would break after a setValue rebuild). One popover at a
  // time — clicking a second cell while a popover is open closes
  // the first; this avoids stacked dialogs and keeps focus
  // management deterministic.
  const handleOpenPopover = (
    bar: Bar,
    anchor: HTMLElement,
    secIndex: number,
    barIndex: number,
  ): void => {
    if (destroyed) return;
    if (popoverHandle !== null) {
      popoverHandle.dispose();
      popoverHandle = null;
    }
    popoverHandle = openBarPopover({
      container: element,
      bar,
      anchor,
      onSave: (next: Bar) => {
        const section = state.song.sections[secIndex];
        if (!section) return;
        if (barIndex < 0 || barIndex >= section.bars.length) return;
        section.bars[barIndex] = next;
        // Re-render so the bar cell reflects the new chord/text and
        // so the next click anchors on the freshly-mounted button.
        renderNow();
        // Return focus to the rebuilt bar cell so keyboard users
        // keep their navigation position. The original `anchor`
        // button is detached by `renderNow()` (clearChildren +
        // full grid rebuild), so `dispose()` cannot return focus
        // there; we must locate the new cell before `dispose()`
        // runs. Compute the cell's global index by summing bar
        // counts for all preceding sections.
        let globalOffset = 0;
        for (let s = 0; s < secIndex; s++) {
          globalOffset += state.song.sections[s]?.bars.length ?? 0;
        }
        const cells = element.querySelectorAll<HTMLButtonElement>('.irealb-editor__bar');
        const newCell = cells[globalOffset + barIndex];
        if (newCell) newCell.focus();
        fireUserEdit();
      },
      onClose: () => {
        popoverHandle = null;
      },
    });
  };

  // Structural ops (#2365). Each mutation closes the popover (a
  // grid rebuild detaches the popover's anchor anyway), splices /
  // mutates `state.song`, then re-renders + fires onChange. The
  // "delete section" path consults the host-supplied
  // `confirmDeleteSection`; the "rename" / "add section" paths
  // consult `promptSectionLabel`. Rename uses the existing label
  // as the prompt seed; add uses `null` to signal "no current
  // label."
  //
  // Focus restoration: every op finishes with `renderNow()`, which
  // detaches the just-clicked button. Without explicit follow-up,
  // focus drops to <body> and a keyboard user repeating Move-up
  // has to mouse back to the button between presses. The
  // `focusAfterRender` helper locates the freshly-mounted button
  // by `data-section-index` / `data-bar-index` (both already
  // emitted by render.ts) so focus follows the moved item; for
  // delete ops it falls back to the next-sibling item (or the
  // previous, if the deleted item was last). Mirrors the popover
  // Save focus-restoration introduced for #2364.
  const dismissPopover = (): void => {
    if (popoverHandle !== null) {
      popoverHandle.dispose();
      popoverHandle = null;
    }
  };

  /** Re-focus the first non-disabled button matching one of
   * `selectors` inside `element`, in priority order. Skips
   * `<button disabled>` (jsdom + browsers both refuse to focus a
   * disabled button) so a move op that lands an item on an
   * endpoint (where the same-direction button is disabled) falls
   * through to a sensible alternative. No-op if every selector
   * misses or matches only disabled elements. */
  const focusAfterRender = (selectors: string[]): void => {
    for (const selector of selectors) {
      const target = element.querySelector<HTMLElement>(selector);
      if (!target) continue;
      if (target instanceof HTMLButtonElement && target.disabled) continue;
      target.focus();
      return;
    }
  };

  /** Locate the freshly-mounted "Move section up/down" / "Rename
   * section" / "Delete section" button on a specific section. */
  const sectionActionSelector = (secIndex: number, ariaLabel: string): string =>
    `[data-section-index="${secIndex}"] button[aria-label="${ariaLabel}"]`;

  /** Locate the freshly-mounted "Move bar left/right" / "Delete bar"
   * button on a specific bar. */
  const barActionSelector = (
    secIndex: number,
    barIndex: number,
    ariaLabel: string,
  ): string =>
    `[data-section-index="${secIndex}"] [data-bar-index="${barIndex}"] button[aria-label="${ariaLabel}"]`;

  // The op closures reference `renderNow` and `focusAfterRender`,
  // which are declared further down in this function. The closures
  // capture them lexically; reads happen only when an op fires
  // (i.e. on user click), well after the `let` / `const` bindings
  // are initialised, so the temporal-dead-zone window is unreachable
  // in practice. Do NOT reorder the declarations to put `renderNow`
  // above `ops` without first verifying nothing in the construction
  // path calls into `ops`.
  const ops: StructuralOps = {
    addSection: () => {
      if (destroyed) return;
      const label = promptSectionLabel(null);
      if (label === null) return;
      dismissPopover();
      const newIndex = state.song.sections.length;
      state.song.sections.push(makeDefaultSection(label));
      renderNow();
      fireUserEdit();
      // Focus the new section's "Move section up" button — the
      // closest analogue to the just-clicked "+ Add section"
      // trailer (which does not exist on a per-section basis).
      focusAfterRender([
        sectionActionSelector(newIndex, 'Move section up'),
        sectionActionSelector(newIndex, 'Rename section'),
      ]);
    },
    renameSection: (secIndex, current) => {
      if (destroyed) return;
      const section = state.song.sections[secIndex];
      if (!section) return;
      const next = promptSectionLabel(current);
      if (next === null) return;
      // No-op if the label is structurally unchanged. Suppresses a
      // duplicate-URL onChange dispatch that subscribers cannot
      // distinguish from a real edit.
      if (sectionLabelEquals(current, next)) return;
      dismissPopover();
      section.label = next;
      renderNow();
      fireUserEdit();
      focusAfterRender([sectionActionSelector(secIndex, 'Rename section')]);
    },
    deleteSection: (secIndex) => {
      if (destroyed) return;
      const section = state.song.sections[secIndex];
      if (!section) return;
      if (!confirmDeleteSection(section.label)) return;
      dismissPopover();
      state.song.sections.splice(secIndex, 1);
      renderNow();
      fireUserEdit();
      // Focus the next-sibling section's "Delete section" button
      // (the same kind that was just activated). If the deleted
      // section was the last one, focus the new last section's
      // button instead. If no sections remain, focus the
      // "+ Add section" trailer.
      const remaining = state.song.sections.length;
      if (remaining === 0) {
        focusAfterRender(['.irealb-editor__add-section']);
      } else {
        const nextIndex = secIndex < remaining ? secIndex : remaining - 1;
        focusAfterRender([sectionActionSelector(nextIndex, 'Delete section')]);
      }
    },
    moveSectionUp: (secIndex) => {
      if (destroyed) return;
      if (secIndex <= 0 || secIndex >= state.song.sections.length) return;
      dismissPopover();
      const cur = state.song.sections[secIndex] as Section;
      const prev = state.song.sections[secIndex - 1] as Section;
      state.song.sections[secIndex - 1] = cur;
      state.song.sections[secIndex] = prev;
      renderNow();
      fireUserEdit();
      // The moved section is now at secIndex - 1. Focus its
      // "Move section up" button so a repeat-press keeps moving
      // the same section upward.
      focusAfterRender([
        sectionActionSelector(secIndex - 1, 'Move section up'),
        sectionActionSelector(secIndex - 1, 'Move section down'),
        sectionActionSelector(secIndex - 1, 'Rename section'),
      ]);
    },
    moveSectionDown: (secIndex) => {
      if (destroyed) return;
      if (secIndex < 0 || secIndex >= state.song.sections.length - 1) return;
      dismissPopover();
      const cur = state.song.sections[secIndex] as Section;
      const next = state.song.sections[secIndex + 1] as Section;
      state.song.sections[secIndex + 1] = cur;
      state.song.sections[secIndex] = next;
      renderNow();
      fireUserEdit();
      focusAfterRender([
        sectionActionSelector(secIndex + 1, 'Move section down'),
        sectionActionSelector(secIndex + 1, 'Move section up'),
        sectionActionSelector(secIndex + 1, 'Rename section'),
      ]);
    },
    addBar: (secIndex) => {
      if (destroyed) return;
      const section = state.song.sections[secIndex];
      if (!section) return;
      dismissPopover();
      const newBarIndex = section.bars.length;
      section.bars.push(makeDefaultBar());
      renderNow();
      fireUserEdit();
      // Focus the new bar's edit button (its <button class="bar">).
      focusAfterRender([
        `[data-section-index="${secIndex}"] [data-bar-index="${newBarIndex}"] .irealb-editor__bar`,
      ]);
    },
    deleteBar: (secIndex, barIndex) => {
      if (destroyed) return;
      const section = state.song.sections[secIndex];
      if (!section) return;
      if (barIndex < 0 || barIndex >= section.bars.length) return;
      dismissPopover();
      section.bars.splice(barIndex, 1);
      renderNow();
      fireUserEdit();
      // Focus the next-sibling bar's Delete button (or the new
      // last bar's, or the section's "+ Add bar" trailer).
      const remaining = section.bars.length;
      if (remaining === 0) {
        focusAfterRender([
          `[data-section-index="${secIndex}"] .irealb-editor__add-bar`,
        ]);
      } else {
        const nextIndex = barIndex < remaining ? barIndex : remaining - 1;
        focusAfterRender([barActionSelector(secIndex, nextIndex, 'Delete bar')]);
      }
    },
    moveBarLeft: (secIndex, barIndex) => {
      if (destroyed) return;
      const section = state.song.sections[secIndex];
      if (!section) return;
      if (barIndex <= 0 || barIndex >= section.bars.length) return;
      dismissPopover();
      const cur = section.bars[barIndex] as Bar;
      const prev = section.bars[barIndex - 1] as Bar;
      section.bars[barIndex - 1] = cur;
      section.bars[barIndex] = prev;
      renderNow();
      fireUserEdit();
      focusAfterRender([
        barActionSelector(secIndex, barIndex - 1, 'Move bar left'),
        barActionSelector(secIndex, barIndex - 1, 'Move bar right'),
        `[data-section-index="${secIndex}"] [data-bar-index="${barIndex - 1}"] .irealb-editor__bar`,
      ]);
    },
    moveBarRight: (secIndex, barIndex) => {
      if (destroyed) return;
      const section = state.song.sections[secIndex];
      if (!section) return;
      if (barIndex < 0 || barIndex >= section.bars.length - 1) return;
      dismissPopover();
      const cur = section.bars[barIndex] as Bar;
      const next = section.bars[barIndex + 1] as Bar;
      section.bars[barIndex + 1] = cur;
      section.bars[barIndex] = next;
      renderNow();
      fireUserEdit();
      focusAfterRender([
        barActionSelector(secIndex, barIndex + 1, 'Move bar right'),
        barActionSelector(secIndex, barIndex + 1, 'Move bar left'),
        `[data-section-index="${secIndex}"] [data-bar-index="${barIndex + 1}"] .irealb-editor__bar`,
      ]);
    },
  };

  const renderNow = (): void => {
    if (renderHandle !== null) {
      renderHandle.dispose();
      renderHandle = null;
    }
    renderHandle = render(element, state, fireUserEdit, handleOpenPopover, ops);
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
      // state) but do not call `fireUserEdit`. Any open popover
      // is dismissed: it would otherwise reference a Bar from the
      // pre-load AST and on Save corrupt the freshly-loaded chart.
      if (popoverHandle !== null) {
        popoverHandle.dispose();
        popoverHandle = null;
      }
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
      if (popoverHandle !== null) {
        popoverHandle.dispose();
        popoverHandle = null;
      }
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

/** Default new bar — single barlines, no chords, no ending, no
 * symbol. Used by `addBar` and by `addSection` (which seeds the
 * new section with one starter bar so the user can immediately
 * click to open the popover). */
function makeDefaultBar(): Bar {
  return {
    start: 'single',
    end: 'single',
    chords: [],
    ending: null,
    symbol: null,
  };
}

/** Default new section: the supplied label + one default bar. */
function makeDefaultSection(label: SectionLabel): Section {
  return { label, bars: [makeDefaultBar()] };
}

/** Structural equality on `SectionLabel`. Used by `renameSection`
 * to suppress a no-op edit (which would otherwise dispatch a
 * duplicate-URL onChange that subscribers cannot distinguish from
 * a real edit). */
function sectionLabelEquals(a: SectionLabel | null, b: SectionLabel | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'letter' && b.kind === 'letter') return a.value === b.value;
  if (a.kind === 'custom' && b.kind === 'custom') return a.value === b.value;
  // The remaining kinds (`verse` / `chorus` / `intro` / `outro` /
  // `bridge`) carry no payload, so kind equality is sufficient.
  return true;
}

/** Default `promptSectionLabel`: ask via `window.prompt`, parse the
 * reply into a `SectionLabel`. Empty / cancelled returns `null`.
 * The rules mirror the named variants in `ast.ts` so a user typing
 * `"Verse"` ends up with `{kind: 'verse'}` rather than `{kind:
 * 'custom', value: 'Verse'}`. */
function defaultPromptSectionLabel(current: SectionLabel | null): SectionLabel | null {
  const seed = current !== null ? formatSectionLabelForPrompt(current) : 'A';
  const reply = window.prompt(
    'Section label (A–Z, Verse, Chorus, Intro, Outro, Bridge, or any text):',
    seed,
  );
  if (reply === null) return null;
  return parseSectionLabel(reply);
}

/** Default delete-section confirmation. */
function defaultConfirmDeleteSection(label: SectionLabel): boolean {
  return window.confirm(`Delete section "${formatSectionLabelForPrompt(label)}"?`);
}

/** Map a `SectionLabel` to the string form `defaultPromptSectionLabel`
 * round-trips through. */
function formatSectionLabelForPrompt(label: SectionLabel): string {
  switch (label.kind) {
    case 'letter':
      return label.value;
    case 'verse':
      return 'Verse';
    case 'chorus':
      return 'Chorus';
    case 'intro':
      return 'Intro';
    case 'outro':
      return 'Outro';
    case 'bridge':
      return 'Bridge';
    case 'custom':
      return label.value;
  }
}

/** Parse a free-text section label into the closest `SectionLabel`
 * variant. Empty input is treated as cancellation (returns `null`).
 * Single A–Z letter (case-insensitive, normalised to uppercase) ->
 * `Letter`; named variants (`verse`/`chorus`/`intro`/`outro`/`bridge`,
 * case-insensitive) map to their dedicated variant; anything else
 * falls into `Custom` so unusual labels survive the round trip. */
export function parseSectionLabel(s: string): SectionLabel | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return { kind: 'letter', value: upper };
    }
  }
  switch (trimmed.toLowerCase()) {
    case 'verse':
      return { kind: 'verse' };
    case 'chorus':
      return { kind: 'chorus' };
    case 'intro':
      return { kind: 'intro' };
    case 'outro':
      return { kind: 'outro' };
    case 'bridge':
      return { kind: 'bridge' };
  }
  return { kind: 'custom', value: trimmed };
}
