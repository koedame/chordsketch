// Pure DOM renderer for `IrealbEditorState`. `render(state, onUserEdit)`
// appends the form + read-only bar grid to a freshly-created root
// element, wires `input` / `change` listeners on the form fields so a
// user edit mutates `state.song` in place and calls `onUserEdit`, and
// returns the root + a `dispose` function that releases the listeners.
//
// The design is intentionally diff-free: every `setValue` in the
// editor adapter calls `dispose` then re-runs `render` rather than
// patching individual nodes. iRealb chart edits do not happen at
// keystroke speed (the user is changing metadata fields one click at
// a time), so the simpler "rebuild on demand" path stays well under
// any perceptible latency floor and avoids the bookkeeping cost a
// real diff would impose.

import type {
  Accidental,
  Bar,
  Chord,
  ChordQuality,
  ChordRoot,
  KeyMode,
  Section,
  SectionLabel,
} from './ast.js';
import { clearChildren, el, field, FieldIdMinter } from './dom.js';
import type { IrealbEditorState } from './state.js';

/** Callback signature used by the bar grid to delegate "user clicked
 * a bar cell" up to the editor adapter. The adapter opens the
 * popover (built in `popover.ts`), which on Save replaces the bar
 * via `(secIndex, barIndex, next)` and then triggers a full
 * re-render plus the user-edit notification. Threading the
 * callback through render avoids importing `popover.ts` here —
 * `render.ts` stays the pure-DOM half of the package. */
export type OpenBarPopover = (
  bar: Bar,
  anchor: HTMLElement,
  secIndex: number,
  barIndex: number,
) => void;

/** Mutators the renderer invokes for structural edits (#2365). The
 * editor adapter implements each one as a `state.song` mutation
 * followed by `renderNow()` + `fireUserEdit()`. Threading them as a
 * single object keeps `render`'s signature stable while letting the
 * adapter own the rebuild + notification cycle. */
export interface StructuralOps {
  /** Append a new section after the last one. The label dialog is
   * opened by the adapter; the new section starts with one default
   * bar so the user can immediately click to edit. */
  addSection(): void;
  /** Replace a section's label. */
  renameSection(secIndex: number, label: SectionLabel): void;
  /** Delete a section. The adapter invokes `confirmDeleteSection`
   * internally; returning `false` from that hook cancels the
   * operation before any AST mutation occurs. */
  deleteSection(secIndex: number): void;
  /** Move a section one position up (lower index). No-op at index 0. */
  moveSectionUp(secIndex: number): void;
  /** Move a section one position down (higher index). No-op at the
   * last section. */
  moveSectionDown(secIndex: number): void;
  /** Append a fresh bar to a section. */
  addBar(secIndex: number): void;
  /** Delete a bar. The renderer does not require a confirm; the AST
   * stores undo-equivalent state via the URL field that the host
   * can re-load. */
  deleteBar(secIndex: number, barIndex: number): void;
  /** Move a bar one position left within its section. No-op at
   * the first bar. */
  moveBarLeft(secIndex: number, barIndex: number): void;
  /** Move a bar one position right within its section. No-op at
   * the last bar. */
  moveBarRight(secIndex: number, barIndex: number): void;
}

/** Result returned by {@link render}. `dispose` removes every event
 * listener registered during this render pass; call before
 * re-rendering or before tearing the editor down. */
export interface RenderHandle {
  /** Disconnect every listener registered by this render pass. */
  dispose(): void;
}

/** Build the form + bar grid into `root` from `state`. `onUserEdit`
 * fires after every successful user-initiated mutation;
 * `openBarPopover` fires when a user clicks a bar cell (the
 * adapter opens the bar-edit popover, #2364); `ops` exposes the
 * structural mutations the per-section / per-bar UI buttons drive
 * (#2365). The adapter owns the popover container, structural
 * confirm dialogs, and the post-mutation re-render + onUserEdit
 * dispatch. */
export function render(
  root: HTMLElement,
  state: IrealbEditorState,
  onUserEdit: () => void,
  openBarPopover: OpenBarPopover,
  ops: StructuralOps,
): RenderHandle {
  clearChildren(root);
  const cleanups: Array<() => void> = [];
  // Per-render ID minter so two coexisting editors in the same
  // document do not interleave field IDs. The minter resets on
  // every render pass (rebuild-on-demand model) — IDs are not
  // expected to be stable across renders.
  const minter = new FieldIdMinter();

  /** Subscribe to an event and remember how to unsubscribe. */
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  // ---- Header (metadata form) -----------------------------------------------
  const header = el('div', { class: 'irealb-editor__header' });

  const titleInput = el('input', {
    attrs: { type: 'text', value: state.song.title },
    class: 'irealb-editor__input',
  });
  listen(titleInput, 'input', () => {
    state.song.title = titleInput.value;
    onUserEdit();
  });
  header.appendChild(field('Title', titleInput, minter));

  const composerInput = el('input', {
    attrs: { type: 'text', value: state.song.composer ?? '' },
    class: 'irealb-editor__input',
  });
  listen(composerInput, 'input', () => {
    const v = composerInput.value;
    state.song.composer = v === '' ? null : v;
    onUserEdit();
  });
  header.appendChild(field('Composer', composerInput, minter));

  const styleInput = el('input', {
    attrs: { type: 'text', value: state.song.style ?? '' },
    class: 'irealb-editor__input',
  });
  listen(styleInput, 'input', () => {
    const v = styleInput.value;
    state.song.style = v === '' ? null : v;
    onUserEdit();
  });
  header.appendChild(field('Style', styleInput, minter));

  // Key root: combined "letter + accidental" dropdown (12 enharmonic
  // names). Splitting note and accidental into two selects exposed a
  // double-update race in early prototypes (a user picking "A♭" via
  // letter→A then accidental→flat would briefly serialise as A
  // natural). One select makes the change atomic.
  const keyRootSelect = makeKeyRootSelect(state.song.key_signature.root);
  listen(keyRootSelect, 'change', () => {
    state.song.key_signature.root = decodeKeyRootValue(keyRootSelect.value);
    onUserEdit();
  });
  header.appendChild(field('Key root', keyRootSelect, minter));

  const keyModeSelect = makeKeyModeSelect(state.song.key_signature.mode);
  listen(keyModeSelect, 'change', () => {
    state.song.key_signature.mode = keyModeSelect.value as KeyMode;
    onUserEdit();
  });
  header.appendChild(field('Key mode', keyModeSelect, minter));

  const timeNumSelect = makeTimeNumeratorSelect(state.song.time_signature.numerator);
  listen(timeNumSelect, 'change', () => {
    state.song.time_signature.numerator = Number.parseInt(timeNumSelect.value, 10);
    onUserEdit();
  });
  header.appendChild(field('Time numerator', timeNumSelect, minter));

  const timeDenSelect = makeTimeDenominatorSelect(state.song.time_signature.denominator);
  listen(timeDenSelect, 'change', () => {
    state.song.time_signature.denominator = Number.parseInt(timeDenSelect.value, 10);
    onUserEdit();
  });
  header.appendChild(field('Time denominator', timeDenSelect, minter));

  const tempoInput = el('input', {
    attrs: {
      type: 'number',
      min: 0,
      max: 999,
      step: 1,
      // 0 represents "unset" in the form — serialised as `null` in
      // the AST so a chart with no tempo round-trips byte-equal.
      value: state.song.tempo ?? 0,
    },
    class: 'irealb-editor__input',
  });
  listen(tempoInput, 'input', () => {
    const n = Number.parseInt(tempoInput.value, 10);
    if (!Number.isFinite(n) || n < 0 || n > 999) {
      // Reject NaN / out-of-range values; `change` event will
      // re-fire with a valid integer when the user moves focus away.
      // Upper bound 999 matches the `max` HTML attribute and prevents
      // values the Rust serialiser rejects from silently breaking the
      // serialize/getValue cycle (cf. transpose guard `n < -11 || n > 11`).
      return;
    }
    state.song.tempo = n === 0 ? null : n;
    onUserEdit();
  });
  header.appendChild(field('Tempo (0 = unset)', tempoInput, minter));

  const transposeInput = el('input', {
    attrs: {
      type: 'number',
      min: -11,
      max: 11,
      step: 1,
      value: state.song.transpose,
    },
    class: 'irealb-editor__input',
  });
  listen(transposeInput, 'input', () => {
    const n = Number.parseInt(transposeInput.value, 10);
    if (!Number.isFinite(n) || n < -11 || n > 11) {
      // Out-of-range values are dropped; the iReal AST clamps to
      // `[-11, 11]` and a serialiser-side error would surface as a
      // missed onChange anyway.
      return;
    }
    state.song.transpose = n;
    onUserEdit();
  });
  header.appendChild(field('Transpose', transposeInput, minter));

  root.appendChild(header);

  // ---- Bar grid -------------------------------------------------------------
  const grid = el('div', { class: 'irealb-editor__grid' });
  const sectionsCount = state.song.sections.length;
  state.song.sections.forEach((section, secIndex) => {
    grid.appendChild(
      renderSection(section, secIndex, sectionsCount, openBarPopover, ops, listen, root),
    );
  });

  // "Add Section" trailer — always present so the user can append
  // to an empty chart too. Click → the adapter opens the section-
  // label dialog and then calls `ops.addSection`.
  const addSectionBtn = el('button', {
    class: 'irealb-editor__add-section',
    attrs: { type: 'button' },
    text: '+ Add section',
  });
  listen(addSectionBtn, 'click', () => {
    ops.addSection();
  });
  grid.appendChild(addSectionBtn);
  root.appendChild(grid);

  return {
    dispose() {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Section / bar rendering
// ---------------------------------------------------------------------------

function renderSection(
  section: Section,
  secIndex: number,
  sectionsCount: number,
  openBarPopover: OpenBarPopover,
  ops: StructuralOps,
  listen: <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ) => void,
  root: HTMLElement,
): HTMLElement {
  const wrapper = el('div', {
    class: 'irealb-editor__section',
    attrs: { 'data-section-index': String(secIndex) },
  });

  // Section header: label + per-section action buttons (rename,
  // delete, move up/down). The header sits inline with the label so
  // the actions stay visually attached to their target section.
  const headerRow = el('div', { class: 'irealb-editor__section-header' });
  const heading = el('h3', {
    class: 'irealb-editor__section-label',
    text: formatSectionLabel(section.label),
  });
  headerRow.appendChild(heading);

  const renameBtn = el('button', {
    class: 'irealb-editor__section-action',
    attrs: { type: 'button', 'aria-label': 'Rename section' },
    text: '✎',
  });
  listen(renameBtn, 'click', () => {
    ops.renameSection(secIndex, section.label);
  });
  headerRow.appendChild(renameBtn);

  const upBtn = el('button', {
    class: 'irealb-editor__section-action',
    attrs: { type: 'button', 'aria-label': 'Move section up' },
    text: '↑',
  });
  if (secIndex === 0) upBtn.setAttribute('disabled', '');
  listen(upBtn, 'click', () => {
    ops.moveSectionUp(secIndex);
  });
  headerRow.appendChild(upBtn);

  const downBtn = el('button', {
    class: 'irealb-editor__section-action',
    attrs: { type: 'button', 'aria-label': 'Move section down' },
    text: '↓',
  });
  if (secIndex === sectionsCount - 1) downBtn.setAttribute('disabled', '');
  listen(downBtn, 'click', () => {
    ops.moveSectionDown(secIndex);
  });
  headerRow.appendChild(downBtn);

  const deleteSectionBtn = el('button', {
    class: 'irealb-editor__section-action irealb-editor__section-action--danger',
    attrs: { type: 'button', 'aria-label': 'Delete section' },
    text: '×',
  });
  listen(deleteSectionBtn, 'click', () => {
    ops.deleteSection(secIndex);
  });
  headerRow.appendChild(deleteSectionBtn);

  wrapper.appendChild(headerRow);

  // 4-bars-per-line CSS grid. Emits a flat list of bar wrappers
  // (each wrapper holds the bar `<button>` plus its delete /
  // reorder controls). ARIA grid semantics arrive in #2368.
  const row = el('div', { class: 'irealb-editor__bars' });
  const barsCount = section.bars.length;
  section.bars.forEach((bar, barIndex) => {
    row.appendChild(
      renderBar(bar, secIndex, barIndex, barsCount, openBarPopover, ops, listen, root),
    );
  });
  wrapper.appendChild(row);

  // Append-bar trailer.
  const addBarBtn = el('button', {
    class: 'irealb-editor__add-bar',
    attrs: { type: 'button' },
    text: '+ Add bar',
  });
  listen(addBarBtn, 'click', () => {
    ops.addBar(secIndex);
  });
  wrapper.appendChild(addBarBtn);

  return wrapper;
}

function renderBar(
  bar: Bar,
  secIndex: number,
  barIndex: number,
  barsCount: number,
  openBarPopover: OpenBarPopover,
  ops: StructuralOps,
  listen: <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ) => void,
  root: HTMLElement,
): HTMLElement {
  const wrapper = el('div', {
    class: 'irealb-editor__bar-wrapper',
    attrs: { 'data-bar-index': String(barIndex) },
  });

  const text = bar.chords.map((c) => formatChord(c.chord)).join(' ');
  // `<button type="button">` so the cell announces as a button to
  // screen readers and so Enter / Space activation works without
  // explicit keyboard handlers. ARIA grid semantics on the wrapping
  // grid (`role="grid"` / `gridcell`) are deferred to #2368.
  const cell = el('button', {
    class: 'irealb-editor__bar',
    attrs: {
      type: 'button',
      'aria-label': `Edit bar ${barIndex + 1}`,
    },
    text: text || ' ', // U+00A0 keeps empty cells height-stable.
  });
  listen(cell, 'click', () => {
    openBarPopover(bar, cell, secIndex, barIndex);
  });
  // Keyboard shortcuts (#2376) for the focused bar cell:
  //   Delete / Backspace          → remove the bar
  //   Alt+ArrowLeft / ArrowRight  → reorder within the section
  // Behaviour mirrors the per-bar `×` / `←` / `→` UI buttons. The
  // delete shortcut intentionally has no confirmation prompt — the
  // UI `×` button is also unconfirmed, and an asymmetric path would
  // surprise keyboard users.
  listen(cell, 'keydown', (ev) => {
    handleBarCellKeydown(ev, secIndex, barIndex, barsCount, ops, root);
  });
  wrapper.appendChild(cell);

  const actions = el('div', { class: 'irealb-editor__bar-actions' });

  const leftBtn = el('button', {
    class: 'irealb-editor__bar-action',
    attrs: { type: 'button', 'aria-label': 'Move bar left' },
    text: '←',
  });
  if (barIndex === 0) leftBtn.setAttribute('disabled', '');
  listen(leftBtn, 'click', () => {
    ops.moveBarLeft(secIndex, barIndex);
  });
  actions.appendChild(leftBtn);

  const rightBtn = el('button', {
    class: 'irealb-editor__bar-action',
    attrs: { type: 'button', 'aria-label': 'Move bar right' },
    text: '→',
  });
  if (barIndex === barsCount - 1) rightBtn.setAttribute('disabled', '');
  listen(rightBtn, 'click', () => {
    ops.moveBarRight(secIndex, barIndex);
  });
  actions.appendChild(rightBtn);

  const deleteBtn = el('button', {
    class: 'irealb-editor__bar-action irealb-editor__bar-action--danger',
    attrs: { type: 'button', 'aria-label': 'Delete bar' },
    text: '×',
  });
  listen(deleteBtn, 'click', () => {
    ops.deleteBar(secIndex, barIndex);
  });
  actions.appendChild(deleteBtn);

  wrapper.appendChild(actions);
  return wrapper;
}

/** Bar-cell `keydown` handler (#2376). Dispatches to the structural
 * ops object, then re-focuses the freshly-rendered bar cell so a
 * keyboard user can repeat the shortcut without re-grabbing focus.
 *
 * The structural ops in `index.ts` already restore focus — but they
 * target the action buttons (`Move bar left/right`, `Delete bar`),
 * which is the right behaviour for a click on those buttons but not
 * for a keyboard user who was driving the cell directly. We let the
 * op fire first, then override focus to land back on the bar cell
 * (or, on delete, the next-sibling cell or the section's
 * "+ Add bar" trailer if the section was emptied).
 *
 * Modifier-key gating: shortcuts only fire with the documented
 * modifier set (`Alt` for arrow keys, no modifier for Delete /
 * Backspace). Combinations such as `Ctrl+Backspace`, `Meta+Delete`,
 * or `Alt+Shift+ArrowLeft` are left to the platform / browser so we
 * do not silently shadow OS-level bindings (e.g. text-editor
 * jump-by-word selection that some screen readers map onto bar
 * cells via assistive overlays). */
function handleBarCellKeydown(
  ev: KeyboardEvent,
  secIndex: number,
  barIndex: number,
  barsCount: number,
  ops: StructuralOps,
  root: HTMLElement,
): void {
  // Defense in depth against a focus-trap regression in popover.ts.
  // The bar popover is a W3C APG modal dialog whose focus trap
  // structurally prevents `keydown` from reaching this handler while
  // the dialog is open — a real browser cannot focus a bar cell at
  // that point. A `dispatchEvent` from a test (or, more worryingly,
  // a future assistive-tech overlay that synthesises events without
  // honouring the focus trap) can bypass the trap; bailing on an
  // active popover keeps destructive shortcuts off the cell while a
  // modal owns the user's input.
  if (root.querySelector('.irealb-editor__popover') !== null) return;

  // Reject any modifier combination outside the two we recognise.
  // `ctrlKey` / `metaKey` are always disqualifying; `shiftKey` is
  // disqualifying in combination with `altKey` (see rationale above).
  if (ev.ctrlKey || ev.metaKey) return;

  if (ev.altKey && !ev.shiftKey) {
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      if (barIndex === 0) return; // bounded no-op at the first bar
      ops.moveBarLeft(secIndex, barIndex);
      focusBarCell(root, secIndex, barIndex - 1);
      return;
    }
    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      if (barIndex === barsCount - 1) return; // bounded no-op at the last bar
      ops.moveBarRight(secIndex, barIndex);
      focusBarCell(root, secIndex, barIndex + 1);
      return;
    }
    return;
  }

  if (!ev.altKey && !ev.shiftKey && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    ev.preventDefault();
    ops.deleteBar(secIndex, barIndex);
    // Restore focus on the post-delete grid. The structural op has
    // already pointed focus at the next-sibling Delete button; we
    // override it with the matching bar cell (or the section's
    // "+ Add bar" trailer if the section is now empty) so a
    // keyboard user can keep deleting from the same focus context.
    const sectionEl = root.querySelector<HTMLElement>(
      `.irealb-editor__section[data-section-index="${secIndex}"]`,
    );
    if (sectionEl === null) return;
    // `cells` ordering tracks `barIndex` because `renderBar` appends
    // bars in order and `querySelectorAll` returns nodes in document
    // order. A future drag-reorder or virtualised grid would need to
    // re-establish this invariant before re-using this lookup.
    const cells = sectionEl.querySelectorAll<HTMLButtonElement>('.irealb-editor__bar');
    if (cells.length === 0) {
      sectionEl.querySelector<HTMLButtonElement>('.irealb-editor__add-bar')?.focus();
      return;
    }
    const nextIndex = Math.min(barIndex, cells.length - 1);
    cells[nextIndex]?.focus();
  }
}

function focusBarCell(root: HTMLElement, secIndex: number, barIndex: number): void {
  // Selectors are scoped to `.irealb-editor__section` /
  // `.irealb-editor__bar-wrapper` so a host that wraps the editor in
  // a container that re-uses `data-section-index` / `data-bar-index`
  // (e.g. an outer "song book" widget) does not match those foreign
  // nodes and steal focus.
  root
    .querySelector<HTMLButtonElement>(
      `.irealb-editor__section[data-section-index="${secIndex}"] ` +
        `.irealb-editor__bar-wrapper[data-bar-index="${barIndex}"] ` +
        `.irealb-editor__bar`,
    )
    ?.focus();
}

function formatSectionLabel(label: SectionLabel): string {
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

function formatChord(chord: Chord): string {
  const root = formatChordRoot(chord.root);
  const quality = formatChordQuality(chord.quality);
  const bass = chord.bass !== null ? `/${formatChordRoot(chord.bass)}` : '';
  return `${root}${quality}${bass}`;
}

function formatChordRoot(root: ChordRoot): string {
  return `${root.note}${formatAccidental(root.accidental)}`;
}

function formatAccidental(a: Accidental): string {
  switch (a) {
    case 'natural':
      return '';
    case 'sharp':
      return '♯'; // ♯
    case 'flat':
      return '♭'; // ♭
  }
}

function formatChordQuality(q: ChordQuality): string {
  switch (q.kind) {
    case 'major':
      return '';
    case 'minor':
      return 'm';
    case 'diminished':
      return 'dim';
    case 'augmented':
      return 'aug';
    case 'major7':
      return 'maj7';
    case 'minor7':
      return 'm7';
    case 'dominant7':
      return '7';
    case 'half_diminished':
      // `m7♭5` mirrors `crates/render-ireal/src/chord_typography.rs`
      // (HalfDiminished arm) — the iReal Pro convention. Keep both
      // sites in lockstep so the bar-grid editor and the SVG
      // renderer present the same glyph for the same AST.
      return 'm7♭5';
    case 'diminished7':
      return 'dim7';
    case 'suspended2':
      return 'sus2';
    case 'suspended4':
      return 'sus4';
    case 'custom':
      return q.value;
  }
}

// ---------------------------------------------------------------------------
// Form helpers — key / time / mode dropdowns
// ---------------------------------------------------------------------------

/** Encoded form value for a (note, accidental) pair: `"C-natural"`,
 * `"C-sharp"`, `"D-flat"`, etc. The hyphen is unambiguous (note
 * letters are A..G, accidentals are flat/natural/sharp). */
function encodeKeyRootValue(root: ChordRoot): string {
  return `${root.note}-${root.accidental}`;
}

function decodeKeyRootValue(v: string): ChordRoot {
  const [note, accidental] = v.split('-');
  if (
    !note ||
    note.length !== 1 ||
    note < 'A' ||
    note > 'G' ||
    (accidental !== 'natural' && accidental !== 'sharp' && accidental !== 'flat')
  ) {
    // The dropdown is the only producer of values reaching this
    // function; an unrecognised value means a contract violation
    // (e.g. a future refactor that introduces a free-text root
    // input without updating this site). Throw so the bug is
    // surfaced rather than silently coerced into C natural.
    throw new Error(`decodeKeyRootValue: invalid value: ${v}`);
  }
  return { note, accidental };
}

const KEY_ROOT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = (() => {
  const out: Array<{ value: string; label: string }> = [];
  for (const note of ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const) {
    for (const accidental of ['natural', 'sharp', 'flat'] as const) {
      const value = `${note}-${accidental}`;
      const sym = accidental === 'sharp' ? '♯' : accidental === 'flat' ? '♭' : '';
      out.push({ value, label: `${note}${sym}` });
    }
  }
  return out;
})();

function makeKeyRootSelect(current: ChordRoot): HTMLSelectElement {
  return makeSelect(
    KEY_ROOT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    encodeKeyRootValue(current),
  );
}

function makeKeyModeSelect(current: KeyMode): HTMLSelectElement {
  return makeSelect(
    [
      { value: 'major', label: 'Major' },
      { value: 'minor', label: 'Minor' },
    ],
    current,
  );
}

function makeTimeNumeratorSelect(current: number): HTMLSelectElement {
  // Numerator range matches `chordsketch_ireal::TimeSignature::new`:
  // `1..=12`. The Rust validator rejects 0 / >12, so the dropdown
  // never offers them.
  const opts = [];
  for (let n = 1; n <= 12; n += 1) {
    opts.push({ value: String(n), label: String(n) });
  }
  return makeSelect(opts, String(current));
}

function makeTimeDenominatorSelect(current: number): HTMLSelectElement {
  // Denominator allow-list matches `chordsketch_ireal::TimeSignature::new`:
  // `2 | 4 | 8`. `1` and `16` are rejected by the validator.
  return makeSelect(
    [
      { value: '2', label: '2' },
      { value: '4', label: '4' },
      { value: '8', label: '8' },
    ],
    String(current),
  );
}

function makeSelect(
  options: ReadonlyArray<{ value: string; label: string }>,
  current: string,
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
    // Selected value is not in the option list (e.g. an unusual
    // imported value the dropdown does not enumerate). Force the
    // first option visually so the form does not show a blank
    // selection — the AST keeps its actual value until the user
    // explicitly picks one. Returning here matches what `<select>`
    // does by default in most browsers but pins the behaviour
    // across jsdom + headless test runs.
    select.selectedIndex = 0;
  }
  return select;
}
