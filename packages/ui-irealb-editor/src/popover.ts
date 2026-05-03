// Bar-edit popover: a modal-ish dialog that opens next to a clicked
// bar cell and edits every field of `Bar` (start/end barlines, the
// `BarChord` list, optional N-th `Ending` number, optional
// `MusicalSymbol`). Save commits the edits back to the live AST and
// fires the user-edit callback; Cancel discards the working copy.
//
// The popover is structurally a `<div role="dialog" aria-modal="true">`
// with a focus trap, Escape / outside-click dismissal, and the W3C
// APG dialog pattern (https://www.w3.org/WAI/ARIA/apg/patterns/dialog/).
// It is rendered directly under the editor root so the host's
// stacking context owns z-index. ARIA grid semantics on the
// underlying bar grid arrive in #2368; the popover trigger does not
// depend on them.

import type {
  Accidental,
  Bar,
  BarChord,
  BarLine,
  BeatPosition,
  Chord,
  ChordQuality,
  ChordRoot,
  MusicalSymbol,
} from './ast.js';
import { clearChildren, el, field, FieldIdMinter } from './dom.js';

/** Subset of beat positions the popover offers in its dropdown.
 * 1 / 1.5 / 2 / 2.5 / 3 / 3.5 / 4 / 4.5 — i.e. on-the-beat plus
 * the "and-of" subdivisions for a 4-beat bar. Values outside this
 * set (rarer subdivisions, 5+/4 / 7/8 charts) keep their AST value
 * untouched on round-trip; the dropdown shows the closest match
 * but does not normalise. The tightly-bounded list mirrors what the
 * iReal Pro app accepts in its own editor. */
const BEAT_POSITION_OPTIONS: ReadonlyArray<{ value: string; beat: number; subdivision: number }> = [
  { value: '1', beat: 1, subdivision: 0 },
  { value: '1.5', beat: 1, subdivision: 1 },
  { value: '2', beat: 2, subdivision: 0 },
  { value: '2.5', beat: 2, subdivision: 1 },
  { value: '3', beat: 3, subdivision: 0 },
  { value: '3.5', beat: 3, subdivision: 1 },
  { value: '4', beat: 4, subdivision: 0 },
  { value: '4.5', beat: 4, subdivision: 1 },
];

const BARLINE_OPTIONS: ReadonlyArray<{ value: BarLine; label: string }> = [
  { value: 'single', label: 'Single │' },
  { value: 'double', label: 'Double ‖' },
  { value: 'final', label: 'Final ‖|' },
  { value: 'open_repeat', label: 'Open repeat |:' },
  { value: 'close_repeat', label: 'Close repeat :|' },
];

const QUALITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
  { value: 'diminished', label: 'Diminished' },
  { value: 'augmented', label: 'Augmented' },
  { value: 'major7', label: 'Major 7' },
  { value: 'minor7', label: 'Minor 7' },
  { value: 'dominant7', label: 'Dominant 7' },
  { value: 'half_diminished', label: 'Half-diminished (m7♭5)' },
  { value: 'diminished7', label: 'Diminished 7' },
  { value: 'suspended2', label: 'Sus 2' },
  { value: 'suspended4', label: 'Sus 4' },
  { value: 'custom', label: 'Custom…' },
];

const SYMBOL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'segno', label: 'Segno 𝄋' },
  { value: 'coda', label: 'Coda 𝄌' },
  { value: 'da_capo', label: 'D.C.' },
  { value: 'dal_segno', label: 'D.S.' },
  { value: 'fine', label: 'Fine' },
];

const ACCIDENTAL_OPTIONS: ReadonlyArray<{ value: Accidental; label: string }> = [
  { value: 'natural', label: '♮' },
  { value: 'sharp', label: '♯' },
  { value: 'flat', label: '♭' },
];

const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

/** Options accepted by {@link openBarPopover}. */
export interface BarPopoverOptions {
  /** Container the popover is appended to. Sits inside the editor
   * root so `destroy()` cleans it up alongside the rest of the DOM. */
  container: HTMLElement;
  /** The `Bar` to edit. The popover does NOT mutate this object
   * directly until the user hits Save — it works against a deep
   * copy and commits in one shot. */
  bar: Bar;
  /** Anchor element (the clicked bar cell). The popover positions
   * itself relative to this element and returns focus here on close. */
  anchor: HTMLElement;
  /** Called with the edited `Bar` when the user clicks Save.
   * Implementations write the new value back into `state.song`
   * (i.e. replace the bar at the right index). */
  onSave: (next: Bar) => void;
  /** Called when the popover closes (Save, Cancel, Escape, or
   * outside-click). Used by the editor adapter to fire the
   * user-edit callback when `onSave` was the cause of closure. */
  onClose: () => void;
}

/** Handle returned by {@link openBarPopover}. `dispose` closes the
 * popover and removes its DOM + listeners; idempotent. */
export interface BarPopoverHandle {
  /** The dialog root element. Exposed for tests so they can assert
   * structure (focus, aria attributes, child queries). */
  element: HTMLElement;
  /** Close the popover and release every listener registered by the
   * factory. Calling twice is a safe no-op. */
  dispose(): void;
}

/** Build and mount the popover. Returns a handle so the caller (the
 * grid click handler in render.ts) can dismiss programmatically. */
export function openBarPopover(options: BarPopoverOptions): BarPopoverHandle {
  const { container, bar, anchor, onSave, onClose } = options;

  // Working copy: deep clone via JSON round-trip. The Bar type is
  // pure-data (no functions / no Maps / no Dates) so JSON cloning
  // preserves it byte-equal. Mutations target this copy until Save.
  const draft: Bar = JSON.parse(JSON.stringify(bar)) as Bar;

  const minter = new FieldIdMinter();
  const cleanups: Array<() => void> = [];
  let disposed = false;

  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  // ---- Dialog shell --------------------------------------------------------
  const dialog = el('div', {
    class: 'irealb-editor__popover',
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Edit bar',
      tabindex: '-1',
    },
  });

  const body = el('div', { class: 'irealb-editor__popover-body' });
  dialog.appendChild(body);

  // Slot containers — re-rendered when the chord row list changes.
  // Keeping the static fields (barlines, ending, symbol) outside
  // the chords slot avoids re-creating their inputs on row add /
  // remove and lets the user keep typing without losing focus.
  const startSelect = makeBarLineSelect(draft.start);
  listen(startSelect, 'change', () => {
    draft.start = startSelect.value as BarLine;
  });
  body.appendChild(field('Start barline', startSelect, minter));

  const endSelect = makeBarLineSelect(draft.end);
  listen(endSelect, 'change', () => {
    draft.end = endSelect.value as BarLine;
  });
  body.appendChild(field('End barline', endSelect, minter));

  const chordsSection = el('div', { class: 'irealb-editor__popover-chords' });
  body.appendChild(chordsSection);

  // `listen` pushes to the outer `cleanups` array, which means each
  // `renderChordsSection` call adds listeners for newly-created chord
  // row elements while old stale entries (from the previous render)
  // remain in `cleanups`. Those stale entries are safe no-ops in
  // `dispose()`: `removeEventListener` on a detached element is a
  // silent no-op per the spec. The accumulation is bounded to the
  // number of chord-row interactions in one popover session, so the
  // memory overhead is negligible in practice.
  const renderChordsSection = (): void => {
    clearChildren(chordsSection);
    chordsSection.appendChild(el('h4', { text: 'Chords' }));

    draft.chords.forEach((bc, index) => {
      chordsSection.appendChild(renderChordRow(bc, index));
    });

    const addBtn = el('button', {
      class: 'irealb-editor__popover-addrow',
      attrs: { type: 'button' },
      text: '+ Add chord',
    });
    listen(addBtn, 'click', () => {
      draft.chords.push(makeDefaultBarChord());
      renderChordsSection();
    });
    chordsSection.appendChild(addBtn);
  };

  // Build one chord-row cluster: root + accidental + quality +
  // optional Custom string + optional bass note + position +
  // up/down/remove buttons. Each row is a `<div>` so CSS can lay
  // them out as a horizontal grid.
  const renderChordRow = (bc: BarChord, index: number): HTMLElement => {
    const row = el('div', {
      class: 'irealb-editor__popover-chordrow',
      attrs: { 'data-row-index': String(index) },
    });

    // Root note letter
    const rootSelect = makeNoteLetterSelect(bc.chord.root.note);
    listen(rootSelect, 'change', () => {
      bc.chord.root.note = rootSelect.value;
    });
    row.appendChild(field('Root', rootSelect, minter));

    // Root accidental
    const accSelect = makeAccidentalSelect(bc.chord.root.accidental);
    listen(accSelect, 'change', () => {
      bc.chord.root.accidental = accSelect.value as Accidental;
    });
    row.appendChild(field('Acc.', accSelect, minter));

    // Quality (and Custom string)
    const qualitySelect = makeQualitySelect(bc.chord.quality);
    const customInput = el('input', {
      attrs: {
        type: 'text',
        placeholder: 'e.g. 7♯9',
        value: bc.chord.quality.kind === 'custom' ? bc.chord.quality.value : '',
      },
      class: 'irealb-editor__input',
    });
    customInput.style.display = bc.chord.quality.kind === 'custom' ? '' : 'none';
    listen(qualitySelect, 'change', () => {
      const v = qualitySelect.value;
      if (v === 'custom') {
        bc.chord.quality = { kind: 'custom', value: customInput.value };
        customInput.style.display = '';
      } else {
        bc.chord.quality = { kind: v } as ChordQuality;
        customInput.style.display = 'none';
      }
    });
    listen(customInput, 'input', () => {
      if (bc.chord.quality.kind === 'custom') {
        bc.chord.quality.value = customInput.value;
      }
    });
    row.appendChild(field('Quality', qualitySelect, minter));
    row.appendChild(field('Custom', customInput, minter));

    // Bass note (optional). Single text input "X" / "X♭" / "" rather
    // than a paired letter+accidental select to keep the row narrow;
    // parses on save / blur.
    const bassInput = el('input', {
      attrs: {
        type: 'text',
        placeholder: '/X (optional)',
        value: bc.chord.bass !== null ? formatBass(bc.chord.bass) : '',
      },
      class: 'irealb-editor__input',
    });
    listen(bassInput, 'input', () => {
      const parsed = parseBassInput(bassInput.value);
      bc.chord.bass = parsed;
    });
    row.appendChild(field('Bass', bassInput, minter));

    // Beat position
    const posSelect = makeBeatPositionSelect(bc.position);
    listen(posSelect, 'change', () => {
      const opt = BEAT_POSITION_OPTIONS.find((o) => o.value === posSelect.value);
      if (!opt) {
        // The dropdown is the only producer of values reaching this
        // handler; an unrecognised value is a contract violation.
        throw new Error(`bar popover: invalid beat position: ${posSelect.value}`);
      }
      bc.position = { beat: opt.beat, subdivision: opt.subdivision };
    });
    row.appendChild(field('Pos.', posSelect, minter));

    // Reorder + remove
    const upBtn = el('button', {
      class: 'irealb-editor__popover-rowbtn',
      attrs: { type: 'button', 'aria-label': 'Move chord up' },
      text: '↑',
    });
    if (index === 0) upBtn.setAttribute('disabled', '');
    listen(upBtn, 'click', () => {
      if (index === 0) return;
      const tmp = draft.chords[index - 1];
      const cur = draft.chords[index];
      if (!tmp || !cur) return;
      draft.chords[index - 1] = cur;
      draft.chords[index] = tmp;
      renderChordsSection();
    });
    row.appendChild(upBtn);

    const downBtn = el('button', {
      class: 'irealb-editor__popover-rowbtn',
      attrs: { type: 'button', 'aria-label': 'Move chord down' },
      text: '↓',
    });
    if (index === draft.chords.length - 1) downBtn.setAttribute('disabled', '');
    listen(downBtn, 'click', () => {
      if (index === draft.chords.length - 1) return;
      const tmp = draft.chords[index + 1];
      const cur = draft.chords[index];
      if (!tmp || !cur) return;
      draft.chords[index + 1] = cur;
      draft.chords[index] = tmp;
      renderChordsSection();
    });
    row.appendChild(downBtn);

    const removeBtn = el('button', {
      class: 'irealb-editor__popover-rowbtn',
      attrs: { type: 'button', 'aria-label': 'Remove chord' },
      text: '×',
    });
    listen(removeBtn, 'click', () => {
      draft.chords.splice(index, 1);
      renderChordsSection();
    });
    row.appendChild(removeBtn);

    return row;
  };

  renderChordsSection();

  // Ending number (NonZeroU8 range, 1..=9 in the form; empty = None).
  const endingInput = el('input', {
    attrs: {
      type: 'number',
      min: 1,
      max: 9,
      step: 1,
      value: draft.ending ?? '',
      placeholder: 'None',
    },
    class: 'irealb-editor__input',
  });
  listen(endingInput, 'input', () => {
    const v = endingInput.value;
    if (v === '') {
      draft.ending = null;
      return;
    }
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 9) {
      // Out-of-range / non-numeric values are dropped; the AST keeps
      // its previous value until a valid number is entered. The
      // `min`/`max` HTML attributes already constrain the spinner UI.
      return;
    }
    draft.ending = n;
  });
  body.appendChild(field('N-th ending', endingInput, minter));

  // Musical symbol
  const symbolSelect = makeSymbolSelect(draft.symbol);
  listen(symbolSelect, 'change', () => {
    const v = symbolSelect.value;
    draft.symbol = v === '' ? null : (v as MusicalSymbol);
  });
  body.appendChild(field('Symbol', symbolSelect, minter));

  // ---- Footer: Save / Cancel ----------------------------------------------
  const footer = el('div', { class: 'irealb-editor__popover-footer' });

  const cancelBtn = el('button', {
    class: 'irealb-editor__popover-cancel',
    attrs: { type: 'button' },
    text: 'Cancel',
  });
  listen(cancelBtn, 'click', () => {
    dispose();
  });
  footer.appendChild(cancelBtn);

  const saveBtn = el('button', {
    class: 'irealb-editor__popover-save',
    attrs: { type: 'button' },
    text: 'Save',
  });
  listen(saveBtn, 'click', () => {
    onSave(draft);
    dispose();
  });
  footer.appendChild(saveBtn);

  dialog.appendChild(footer);

  // ---- Focus trap + dismissal ---------------------------------------------
  // Outside-click dismissal: any pointerdown that does not land on
  // the dialog or the original anchor closes. Anchor exclusion is
  // important so a click on the bar cell does not immediately close
  // the freshly-opened popover (the click event fires after
  // pointerdown, but we listen on pointerdown to be ahead of any
  // re-entry).
  const onDocumentPointerDown = (ev: PointerEvent): void => {
    const target = ev.target as Node | null;
    if (!target) return;
    if (dialog.contains(target)) return;
    if (anchor.contains(target)) return;
    dispose();
  };
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  cleanups.push(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true));

  // Escape closes.
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      dispose();
      return;
    }
    if (ev.key === 'Tab') {
      // Focus trap: keep Tab cycling inside the dialog. Find the
      // first / last focusable element each Tab press so a row
      // add/remove that changed the focus order is reflected.
      const focusables = collectFocusables(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  };
  dialog.addEventListener('keydown', onKeyDown);
  cleanups.push(() => dialog.removeEventListener('keydown', onKeyDown));

  // ---- Mount + initial focus ----------------------------------------------
  container.appendChild(dialog);
  positionPopover(dialog, anchor);

  // Move focus into the dialog so keyboard users land inside it.
  // Prefer the first focusable; fall back to the dialog itself.
  const initialFocus = collectFocusables(dialog)[0] ?? dialog;
  initialFocus.focus();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    if (dialog.parentNode !== null) {
      dialog.parentNode.removeChild(dialog);
    }
    // Return focus to the trigger anchor — APG dialog pattern. The
    // host re-renders the bar cell after onSave (rebuild-on-demand
    // model), so the original `anchor` may have been detached; in
    // that case `focus()` is a silent no-op.
    if (document.contains(anchor)) {
      anchor.focus();
    }
    onClose();
  }

  return {
    element: dialog,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBarLineSelect(current: BarLine): HTMLSelectElement {
  return makeSelect(BARLINE_OPTIONS, current);
}

function makeNoteLetterSelect(current: string): HTMLSelectElement {
  return makeSelect(
    NOTE_LETTERS.map((l) => ({ value: l, label: l })),
    current,
  );
}

function makeAccidentalSelect(current: Accidental): HTMLSelectElement {
  return makeSelect(ACCIDENTAL_OPTIONS, current);
}

function makeQualitySelect(current: ChordQuality): HTMLSelectElement {
  return makeSelect(QUALITY_OPTIONS, current.kind);
}

function makeSymbolSelect(current: MusicalSymbol | null): HTMLSelectElement {
  return makeSelect(SYMBOL_OPTIONS, current ?? '');
}

function makeBeatPositionSelect(pos: BeatPosition): HTMLSelectElement {
  // Find the option whose (beat, subdivision) match the AST. If the
  // chart has a position outside the dropdown's set (e.g.
  // 32nd-note subdivisions), the value-not-in-list path of
  // makeSelect kicks in and the form shows option[0] visually
  // while the AST keeps its real value. The user has to explicitly
  // pick a new value to overwrite the AST.
  const match = BEAT_POSITION_OPTIONS.find(
    (o) => o.beat === pos.beat && o.subdivision === pos.subdivision,
  );
  return makeSelect(
    BEAT_POSITION_OPTIONS.map((o) => ({ value: o.value, label: o.value })),
    match ? match.value : '',
  );
}

function makeSelect<T extends string>(
  options: ReadonlyArray<{ value: T; label: string }>,
  current: T | string,
): HTMLSelectElement {
  const select = el('select', { class: 'irealb-editor__select' });
  let matched = false;
  for (const o of options) {
    const opt = el('option', { attrs: { value: o.value }, text: o.label });
    if (o.value === current) {
      opt.selected = true;
      matched = true;
    }
    select.appendChild(opt);
  }
  if (!matched && options.length > 0) {
    select.selectedIndex = 0;
  }
  return select;
}

function makeDefaultBarChord(): BarChord {
  return {
    chord: {
      root: { note: 'C', accidental: 'natural' },
      quality: { kind: 'major' },
      bass: null,
    },
    position: { beat: 1, subdivision: 0 },
  };
}

/** Render `ChordRoot` as a string for the bass-input field. Inverse of
 * {@link parseBassInput}. */
function formatBass(root: ChordRoot): string {
  const acc = root.accidental === 'sharp' ? '♯' : root.accidental === 'flat' ? '♭' : '';
  return `${root.note}${acc}`;
}

/** Parse a free-text bass entry into a `ChordRoot` or `null` for
 * empty input. Accepts `A`–`G` followed by optional `♭`/`♯`/`b`/`#`.
 * Returns the previous value's null on unrecognised input so the
 * AST stays well-formed; the input keeps the typed string for
 * the user to correct. */
function parseBassInput(s: string): ChordRoot | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  const note = trimmed.charAt(0).toUpperCase();
  if (note < 'A' || note > 'G') return null;
  const rest = trimmed.slice(1);
  let accidental: Accidental = 'natural';
  if (rest === '♯' || rest === '#') accidental = 'sharp';
  else if (rest === '♭' || rest === 'b') accidental = 'flat';
  else if (rest !== '') return null;
  return { note, accidental };
}

/** Collect every focusable element inside `root` in DOM order.
 * Used by the focus trap and by the initial-focus heuristic. */
function collectFocusables(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/** Position the popover next to `anchor`. Falls back to centre-of-
 * container if the anchor has no measurable bounding box (e.g.
 * jsdom returns zero rects). The anchor's bounding rect drives
 * placement so the popover follows the anchor's actual on-screen
 * position rather than its DOM-tree neighbours. */
function positionPopover(dialog: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // jsdom / detached anchor: leave default CSS positioning. The
    // production CSS sets the popover to absolute positioning
    // anchored to the editor root; callers running in a real
    // browser will see real coordinates.
    return;
  }
  // Place below the anchor by default. The CSS keeps it inside the
  // editor scroll container; if the editor is short and the anchor
  // is near the bottom, the user sees the popover overflow rather
  // than the popover flipping above — flip-up logic is deferred to
  // a follow-up if that becomes a real-world annoyance.
  dialog.style.position = 'absolute';
  dialog.style.top = `${rect.bottom + window.scrollY + 4}px`;
  dialog.style.left = `${rect.left + window.scrollX}px`;
}
