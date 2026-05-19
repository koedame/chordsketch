// Bar grid + per-section / per-bar action buttons + ARIA grid
// semantics + roving-tabindex + keyboard navigation for
// `<IrealEditor>`. Sister-site (DOM) to
// `packages/ui-irealb-editor/src/render.ts`'s
// `renderSection` + `renderBar` + `handleBarCellKeydown` (lines
// 305-695). Each cell is a `<button type="button">` so screen
// readers announce it as activatable and Enter / Space natively
// trigger the (future) popover open.

import { useRef, type KeyboardEvent, type ReactElement } from 'react';

import {
  irealChordToString,
  irealSectionLabelToString,
  type IrealSection,
  type IrealSectionLabel,
} from './ireal-ast';

/**
 * Number of bar cells per visual row. The CSS uses
 * `grid-template-columns: repeat(4, ...)`, and the ARIA
 * `aria-rowindex` / `aria-colindex` reflect the same wrap. Changing
 * this MUST update `.chordsketch-ireal-editor__row` in
 * `packages/react/src/styles.css` in lockstep. Sister-site:
 * `BARS_PER_ROW` in `packages/ui-irealb-editor/src/render.ts`.
 */
export const BARS_PER_ROW = 4;

/** Identifies a bar cell by `(sectionIndex, barIndex)`. The active
 * bar is the cell that holds the grid's single `tabindex="0"` slot
 * per the W3C APG roving-tabindex pattern. */
export interface IrealActiveBarRef {
  secIndex: number;
  barIndex: number;
}

/** Structural mutations the grid invokes on its action buttons +
 * keyboard shortcuts. The host owns implementation (it mutates the
 * parsed AST + re-emits the URL via `serializeIrealb`). Mirrors
 * `StructuralOps` in `packages/ui-irealb-editor/src/render.ts`
 * (lines 47-75). */
export interface IrealStructuralOps {
  addSection(): void;
  renameSection(secIndex: number, current: IrealSectionLabel): void;
  deleteSection(secIndex: number): void;
  moveSectionUp(secIndex: number): void;
  moveSectionDown(secIndex: number): void;
  addBar(secIndex: number): void;
  deleteBar(secIndex: number, barIndex: number): void;
  moveBarLeft(secIndex: number, barIndex: number): void;
  moveBarRight(secIndex: number, barIndex: number): void;
}

export interface IrealBarGridProps {
  sections: readonly IrealSection[];
  /** The cell that should hold `tabindex="0"`. May be `null` for
   * an empty chart, in which case the grid contributes no Tab
   * stop. */
  activeBar: IrealActiveBarRef | null;
  onActiveBarChange: (next: IrealActiveBarRef) => void;
  /** Called when the user clicks (or hits Enter / Space on) a bar
   * cell. The popover that consumes this lands in a follow-up
   * slice; for now the host can use it to drive any future
   * dialog. */
  onOpenBar: (secIndex: number, barIndex: number) => void;
  /** Structural mutators wired to per-section / per-bar action
   * buttons + keyboard shortcuts. */
  ops: IrealStructuralOps;
  /** Disable every interactive control. Used by `<IrealEditor>` in
   * the parse-error / loading states. */
  disabled: boolean;
}

/**
 * Bar grid with ARIA-grid semantics + roving tabindex + structural
 * editing buttons. Renders one `<SectionBlock>` per section; each
 * section's bars wrap into 4-bar rows.
 *
 * Sister-site (DOM): `renderSection` / `renderBar` in
 * `packages/ui-irealb-editor/src/render.ts`. Behaviour parity is
 * load-bearing — every assertion in the upstream
 * `tests/aria-grid.test.ts` / `tests/structural.test.ts` /
 * `tests/keyboard.test.ts` (DOM-side) maps to an equivalent
 * assertion in `tests/ireal-editor-{bar-grid,structural,keyboard}.test.tsx`
 * (React side).
 */
export function IrealBarGrid({
  sections,
  activeBar,
  onActiveBarChange,
  onOpenBar,
  ops,
  disabled,
}: IrealBarGridProps): ReactElement {
  return (
    <div className="chordsketch-ireal-editor__sections">
      {sections.map((section, secIndex) => (
        <SectionBlock
          key={secIndex}
          section={section}
          secIndex={secIndex}
          sectionsCount={sections.length}
          activeBar={activeBar}
          onActiveBarChange={onActiveBarChange}
          onOpenBar={onOpenBar}
          ops={ops}
          disabled={disabled}
        />
      ))}
      <button
        type="button"
        className="chordsketch-ireal-editor__add-section"
        onClick={() => ops.addSection()}
        disabled={disabled}
      >
        + Add section
      </button>
    </div>
  );
}

interface SectionBlockProps {
  section: IrealSection;
  secIndex: number;
  sectionsCount: number;
  activeBar: IrealActiveBarRef | null;
  onActiveBarChange: (next: IrealActiveBarRef) => void;
  onOpenBar: (secIndex: number, barIndex: number) => void;
  ops: IrealStructuralOps;
  disabled: boolean;
}

function SectionBlock({
  section,
  secIndex,
  sectionsCount,
  activeBar,
  onActiveBarChange,
  onOpenBar,
  ops,
  disabled,
}: SectionBlockProps): ReactElement {
  const barsCount = section.bars.length;
  // `rowCount` matches the number of `role="row"` children we
  // actually render — including 0 for an empty section. Reporting
  // a higher row count would diverge from the accessibility tree
  // (ARIA 1.2: `aria-rowcount` SHOULD agree with the rendered row
  // descendants). Screen-reader verbalisation of "0 rows" is
  // strictly correct for an empty grid; the user opens the
  // structural "+ Add bar" trailer (which is sibling to the grid)
  // to populate the first row. Sister-site comment:
  // `packages/ui-irealb-editor/src/render.ts:386-394`.
  const rowCount = Math.ceil(barsCount / BARS_PER_ROW);
  const sectionLabel = irealSectionLabelToString(section.label);

  return (
    <section
      className="chordsketch-ireal-editor__section"
      data-section-index={secIndex}
    >
      <div className="chordsketch-ireal-editor__section-header">
        <h3 className="chordsketch-ireal-editor__section-label">{sectionLabel}</h3>
        <button
          type="button"
          className="chordsketch-ireal-editor__section-action"
          aria-label="Rename section"
          onClick={() => ops.renameSection(secIndex, section.label)}
          disabled={disabled}
        >
          ✎
        </button>
        <button
          type="button"
          className="chordsketch-ireal-editor__section-action"
          aria-label="Move section up"
          onClick={() => ops.moveSectionUp(secIndex)}
          disabled={disabled || secIndex === 0}
        >
          ↑
        </button>
        <button
          type="button"
          className="chordsketch-ireal-editor__section-action"
          aria-label="Move section down"
          onClick={() => ops.moveSectionDown(secIndex)}
          disabled={disabled || secIndex === sectionsCount - 1}
        >
          ↓
        </button>
        <button
          type="button"
          className="chordsketch-ireal-editor__section-action chordsketch-ireal-editor__section-action--danger"
          aria-label="Delete section"
          onClick={() => ops.deleteSection(secIndex)}
          disabled={disabled}
        >
          ×
        </button>
      </div>

      <div
        className="chordsketch-ireal-editor__bars"
        role="grid"
        aria-rowcount={rowCount}
        aria-colcount={BARS_PER_ROW}
        aria-label={`Bars in section ${sectionLabel}`}
      >
        {Array.from({ length: rowCount }).map((_, rowIdx) => {
          const startBar = rowIdx * BARS_PER_ROW;
          const endBar = Math.min(startBar + BARS_PER_ROW, barsCount);
          return (
            <div
              key={rowIdx}
              className="chordsketch-ireal-editor__row"
              role="row"
              aria-rowindex={rowIdx + 1}
            >
              {Array.from({ length: endBar - startBar }).map((_, offset) => {
                const barIndex = startBar + offset;
                return (
                  <BarCell
                    key={barIndex}
                    bar={section.bars[barIndex]!}
                    secIndex={secIndex}
                    barIndex={barIndex}
                    barsCount={barsCount}
                    isActive={
                      activeBar !== null &&
                      activeBar.secIndex === secIndex &&
                      activeBar.barIndex === barIndex
                    }
                    onActivate={onActiveBarChange}
                    onOpen={onOpenBar}
                    ops={ops}
                    disabled={disabled}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="chordsketch-ireal-editor__add-bar"
        onClick={() => ops.addBar(secIndex)}
        disabled={disabled}
      >
        + Add bar
      </button>
    </section>
  );
}

interface BarCellProps {
  bar: IrealSection['bars'][number];
  secIndex: number;
  barIndex: number;
  barsCount: number;
  isActive: boolean;
  onActivate: (next: IrealActiveBarRef) => void;
  onOpen: (secIndex: number, barIndex: number) => void;
  ops: IrealStructuralOps;
  disabled: boolean;
}

function BarCell({
  bar,
  secIndex,
  barIndex,
  barsCount,
  isActive,
  onActivate,
  onOpen,
  ops,
  disabled,
}: BarCellProps): ReactElement {
  const cellRef = useRef<HTMLButtonElement | null>(null);
  const colIndex = barIndex % BARS_PER_ROW;
  // U+00A0 (non-breaking space) keeps empty cells height-stable
  // when no chords have been entered yet — mirrors `renderBar`
  // at `packages/ui-irealb-editor/src/render.ts:501`.
  const text = bar.chords.length === 0
    ? ' '
    : bar.chords.map((c) => irealChordToString(c.chord)).join(' ');

  const handleKeyDown = (ev: KeyboardEvent<HTMLButtonElement>): void => {
    handleBarCellKeydown(ev, secIndex, barIndex, barsCount, ops, cellRef.current);
  };

  return (
    <div
      className="chordsketch-ireal-editor__bar-wrapper"
      data-bar-index={barIndex}
      role="gridcell"
      aria-colindex={colIndex + 1}
    >
      <button
        ref={cellRef}
        type="button"
        className="chordsketch-ireal-editor__bar"
        // Include the rendered chord text in the accessible name
        // so screen-reader users hear which bar they are on, not
        // just its index. `text` is `' '` (U+00A0) for an empty
        // bar; the conditional drops the trailing `: ` in that
        // case so the name stays "Edit bar N" rather than "Edit
        // bar N: " (a screen-reader-announced colon followed by
        // a non-breaking space).
        aria-label={
          text.trim().length === 0
            ? `Edit bar ${barIndex + 1}`
            : `Edit bar ${barIndex + 1}: ${text}`
        }
        tabIndex={isActive ? 0 : -1}
        onClick={() => onOpen(secIndex, barIndex)}
        onFocus={() => onActivate({ secIndex, barIndex })}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      >
        {text}
      </button>
      <div className="chordsketch-ireal-editor__bar-actions">
        <button
          type="button"
          className="chordsketch-ireal-editor__bar-action"
          aria-label="Move bar left"
          onClick={() => ops.moveBarLeft(secIndex, barIndex)}
          disabled={disabled || barIndex === 0}
        >
          ←
        </button>
        <button
          type="button"
          className="chordsketch-ireal-editor__bar-action"
          aria-label="Move bar right"
          onClick={() => ops.moveBarRight(secIndex, barIndex)}
          disabled={disabled || barIndex === barsCount - 1}
        >
          →
        </button>
        <button
          type="button"
          className="chordsketch-ireal-editor__bar-action chordsketch-ireal-editor__bar-action--danger"
          aria-label="Delete bar"
          onClick={() => ops.deleteBar(secIndex, barIndex)}
          disabled={disabled}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * Bar-cell `keydown` handler. Sister-site:
 * `handleBarCellKeydown` in
 * `packages/ui-irealb-editor/src/render.ts` (lines 586-695).
 *
 * Dispatch table (modifier-key gated):
 *
 *   Arrow{Left,Right,Up,Down} / Home / End  → roving navigation
 *   Alt+ArrowLeft / Alt+ArrowRight           → reorder
 *   Delete / Backspace (no modifier)         → delete this bar
 *   Enter / Space                            → activate (native `<button>` handling — not in this handler)
 *
 * `Ctrl` / `Meta` modifiers and `Alt+Shift` combinations are
 * passed through to the browser / OS, mirroring the upstream
 * rationale.
 *
 * Defense-in-depth: if a popover dialog is mounted anywhere in
 * the editor's subtree, the handler bails. A real browser cannot
 * focus a bar cell while a popover's focus trap is active; this
 * guard catches a synthesised `keydown` from a test (or a
 * hypothetical future assistive overlay) that bypasses the trap.
 * Mirrors `render.ts:594-609`.
 *
 * The guard matches against three shapes so the future popover
 * mount path activates it unconditionally:
 *   1. The future `.chordsketch-ireal-editor__popover` class —
 *      the canonical sister-site selector
 *      (`render.ts:609` checks `.irealb-editor__popover`).
 *   2. An element with explicit `role="dialog"` — what
 *      `<BarPopover>` will render at top level.
 *   3. A native HTML5 `<dialog>` element — whose implicit ARIA
 *      role is "dialog" but does NOT match `[role="dialog"]`.
 * A `role="dialog"` host element injected elsewhere inside the
 * editor by a consumer would also match (3) and disable
 * shortcuts; that is accepted because shadowing a destructive
 * key bind behind any modal is a strictly safer default than
 * shadowing it behind none.
 */
function handleBarCellKeydown(
  ev: KeyboardEvent<HTMLButtonElement>,
  secIndex: number,
  barIndex: number,
  barsCount: number,
  ops: IrealStructuralOps,
  cellEl: HTMLButtonElement | null,
): void {
  if (cellEl !== null) {
    const editorRoot = cellEl.closest('.chordsketch-ireal-editor');
    if (editorRoot !== null && hasOpenPopover(editorRoot)) {
      return;
    }
  }

  if (ev.ctrlKey || ev.metaKey) return;

  if (ev.altKey && !ev.shiftKey) {
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      if (barIndex === 0) return; // bounded no-op
      ops.moveBarLeft(secIndex, barIndex);
      focusBarCell(cellEl, secIndex, barIndex - 1);
      return;
    }
    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      if (barIndex === barsCount - 1) return; // bounded no-op
      ops.moveBarRight(secIndex, barIndex);
      focusBarCell(cellEl, secIndex, barIndex + 1);
      return;
    }
    return;
  }

  if (!ev.altKey && !ev.shiftKey) {
    let nextBarIndex: number | null = null;
    switch (ev.key) {
      case 'ArrowLeft':
        if (barIndex > 0) nextBarIndex = barIndex - 1;
        break;
      case 'ArrowRight':
        if (barIndex < barsCount - 1) nextBarIndex = barIndex + 1;
        break;
      case 'ArrowUp':
        if (barIndex - BARS_PER_ROW >= 0) nextBarIndex = barIndex - BARS_PER_ROW;
        break;
      case 'ArrowDown':
        if (barIndex + BARS_PER_ROW < barsCount) {
          nextBarIndex = barIndex + BARS_PER_ROW;
        }
        break;
      case 'Home':
        if (barIndex !== 0) nextBarIndex = 0;
        break;
      case 'End':
        if (barIndex !== barsCount - 1) nextBarIndex = barsCount - 1;
        break;
    }
    if (nextBarIndex !== null) {
      ev.preventDefault();
      focusBarCell(cellEl, secIndex, nextBarIndex);
      return;
    }
  }

  if (!ev.altKey && !ev.shiftKey && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    ev.preventDefault();
    ops.deleteBar(secIndex, barIndex);
    // After the structural op + React re-render, focus the
    // next-sibling cell (or the section's "+ Add bar" trailer
    // when the section is now empty). The cell DOM was rebuilt by
    // the re-render, so we resolve through `data-` selectors. The
    // op is synchronous from the caller's perspective: the host
    // updates state inside it, React re-renders before the next
    // microtask, and our queueMicrotask below sees the new DOM.
    queueMicrotask(() => {
      focusAfterBarDelete(cellEl, secIndex, barIndex);
    });
  }
}

/** Returns `true` when any popover-shaped modal is mounted as a
 * descendant of the editor root. See the guard documentation on
 * `handleBarCellKeydown` for the three shapes recognised. */
function hasOpenPopover(editorRoot: Element): boolean {
  return (
    editorRoot.querySelector('.chordsketch-ireal-editor__popover') !== null ||
    editorRoot.querySelector('[role="dialog"]') !== null ||
    editorRoot.querySelector('dialog') !== null
  );
}

function focusBarCell(
  cellEl: HTMLElement | null,
  secIndex: number,
  barIndex: number,
): void {
  if (cellEl === null) return;
  const editorRoot = cellEl.closest('.chordsketch-ireal-editor');
  if (editorRoot === null) return;
  editorRoot
    .querySelector<HTMLButtonElement>(
      `.chordsketch-ireal-editor__section[data-section-index="${secIndex}"] ` +
        `.chordsketch-ireal-editor__bar-wrapper[data-bar-index="${barIndex}"] ` +
        `.chordsketch-ireal-editor__bar`,
    )
    ?.focus();
}

function focusAfterBarDelete(
  cellEl: HTMLElement | null,
  secIndex: number,
  removedBarIndex: number,
): void {
  if (cellEl === null) return;
  const editorRoot = cellEl.closest('.chordsketch-ireal-editor');
  if (editorRoot === null) return;
  const sectionEl = editorRoot.querySelector(
    `.chordsketch-ireal-editor__section[data-section-index="${secIndex}"]`,
  );
  if (sectionEl === null) return;
  const cells = sectionEl.querySelectorAll<HTMLButtonElement>(
    '.chordsketch-ireal-editor__bar',
  );
  if (cells.length === 0) {
    sectionEl
      .querySelector<HTMLButtonElement>('.chordsketch-ireal-editor__add-bar')
      ?.focus();
    return;
  }
  const nextIndex = Math.min(removedBarIndex, cells.length - 1);
  cells[nextIndex]?.focus();
}

/**
 * Reconcile a `activeBar` reference against a possibly-restructured
 * `sections` array so the bar grid always exposes exactly one
 * Tab stop (or `null` for a completely empty chart). Used by
 * `<IrealEditor>`'s `useEffect` whenever the parsed song changes.
 *
 * Returns the same reference when no reconciliation is needed (so
 * callers can use `===` to skip a state update). Sister-site:
 * `reconcileActiveBar` in
 * `packages/ui-irealb-editor/src/index.ts` (lines 151-191).
 */
export function reconcileActiveBar(
  prev: IrealActiveBarRef | null,
  sections: readonly IrealSection[],
): IrealActiveBarRef | null {
  if (sections.length === 0) return null;
  if (prev === null) {
    // Default to the first bar of the first non-empty section.
    for (let s = 0; s < sections.length; s += 1) {
      const section = sections[s]!;
      if (section.bars.length > 0) {
        return { secIndex: s, barIndex: 0 };
      }
    }
    // Every section is empty — anchor at (0, 0) so the grid still
    // has a notional Tab stop position even if no cell exists yet.
    return { secIndex: 0, barIndex: 0 };
  }
  const sec = sections[prev.secIndex];
  if (!sec || sec.bars.length === 0) {
    for (let s = 0; s < sections.length; s += 1) {
      const section = sections[s]!;
      if (section.bars.length > 0) {
        return { secIndex: s, barIndex: 0 };
      }
    }
    return { secIndex: 0, barIndex: 0 };
  }
  if (prev.barIndex >= sec.bars.length) {
    return { secIndex: prev.secIndex, barIndex: sec.bars.length - 1 };
  }
  return prev;
}

