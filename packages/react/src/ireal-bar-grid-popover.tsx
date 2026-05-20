// Bar-edit popover for `<IrealBarGrid>`. Sister-site (DOM) to
// `packages/ui-irealb-editor/src/popover.ts`.
//
// Structure: a `<div role="dialog" aria-modal="true">` rendered
// inside the editor root, with a focus trap + Escape + outside-
// click dismissal (via the `useFocusTrap` hook landed in PR
// #2510). The popover edits a deep-cloned `draft: IrealBar`
// against which sub-components mutate; Save commits the draft via
// `onSave(next)` which the host wraps onto its `emit` path.
// Cancel / Escape / outside-click dispose the draft without
// firing onSave.
//
// Compared to the DOM reference, the React port:
// - Replaces the imperative `renderChordsSection` rebuild with a
//   React state `chords: IrealBarChord[]` that drives the JSX
//   list. Reorder / add / remove become `useState` mutators.
// - Reuses the `useFocusTrap` hook for the focus-trap + Escape +
//   outside-click contract so the wiring stays in one place.
// - Does NOT position the popover absolutely below the anchor —
//   positioning is left to CSS via the `__popover` class. The
//   reference does an inline `style.top/left` write that breaks
//   when the host renders inside a scroll container; the React
//   port punts to CSS so a host's stylesheet can pin it.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type RefObject,
} from 'react';

import {
  irealCanonicalSymbolText,
  type IrealAccidental,
  type IrealBar,
  type IrealBarChord,
  type IrealBarLine,
  type IrealChordQuality,
  type IrealChordRoot,
  type IrealMusicalSymbol,
} from './ireal-ast';
import { useFocusTrap } from './use-focus-trap';

// ---------------------------------------------------------------------------
// Static option tables — mirror sister-site at
// `packages/ui-irealb-editor/src/popover.ts:28-86`.
// ---------------------------------------------------------------------------

/** Subset of beat positions the popover offers in its dropdown.
 * 1 / 1.5 / 2 / 2.5 / 3 / 3.5 / 4 / 4.5 — on-the-beat plus the
 * "and-of" subdivisions for a 4-beat bar. Values outside this set
 * (rarer subdivisions, 5+/4 / 7/8 charts) keep their AST value
 * untouched on round-trip; the dropdown shows the closest match
 * but does not normalise. Sister-site:
 * `popover.ts:35-44` `BEAT_POSITION_OPTIONS`. */
const BEAT_POSITION_OPTIONS: ReadonlyArray<{
  value: string;
  beat: number;
  subdivision: number;
}> = [
  { value: '1', beat: 1, subdivision: 0 },
  { value: '1.5', beat: 1, subdivision: 1 },
  { value: '2', beat: 2, subdivision: 0 },
  { value: '2.5', beat: 2, subdivision: 1 },
  { value: '3', beat: 3, subdivision: 0 },
  { value: '3.5', beat: 3, subdivision: 1 },
  { value: '4', beat: 4, subdivision: 0 },
  { value: '4.5', beat: 4, subdivision: 1 },
];

const BARLINE_OPTIONS: ReadonlyArray<{ value: IrealBarLine; label: string }> = [
  { value: 'single', label: 'Single │' },
  { value: 'double', label: 'Double ‖' },
  { value: 'final', label: 'Final ‖|' },
  { value: 'open_repeat', label: 'Open repeat |:' },
  { value: 'close_repeat', label: 'Close repeat :|' },
];

const QUALITY_OPTIONS: ReadonlyArray<{ value: IrealChordQuality['kind']; label: string }> = [
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

/**
 * Symbol picker options. Sourced from `IrealMusicalSymbol` —
 * every variant the AST can carry. The label combines the
 * canonical phrase (via `irealCanonicalSymbolText`) for the
 * D.C. / D.S. family + Fine + Break with the glyph-only variants
 * (Segno / Coda / Fermata). Sister-site `popover.ts:69-77` ships
 * a shorter list; this React port is exhaustive against the AST
 * so charts using `dal_segno_al_2nd_end` etc. round-trip without
 * dropping to `None` on edit.
 */
const SYMBOL_OPTIONS: ReadonlyArray<{ value: IrealMusicalSymbol | ''; label: string }> = [
  { value: '', label: 'None' },
  { value: 'segno', label: 'Segno 𝄋' },
  { value: 'coda', label: 'Coda 𝄌' },
  { value: 'fine', label: irealCanonicalSymbolText('fine') ?? 'Fine' },
  { value: 'fermata', label: 'Fermata 𝄐' },
  { value: 'break', label: irealCanonicalSymbolText('break') ?? 'Break' },
  { value: 'da_capo', label: irealCanonicalSymbolText('da_capo') ?? 'D.C.' },
  { value: 'da_capo_al_coda', label: irealCanonicalSymbolText('da_capo_al_coda') ?? 'D.C. al Coda' },
  { value: 'da_capo_al_fine', label: irealCanonicalSymbolText('da_capo_al_fine') ?? 'D.C. al Fine' },
  { value: 'da_capo_al_1st_end', label: irealCanonicalSymbolText('da_capo_al_1st_end') ?? 'D.C. al 1st End.' },
  { value: 'da_capo_al_2nd_end', label: irealCanonicalSymbolText('da_capo_al_2nd_end') ?? 'D.C. al 2nd End.' },
  { value: 'da_capo_al_3rd_end', label: irealCanonicalSymbolText('da_capo_al_3rd_end') ?? 'D.C. al 3rd End.' },
  { value: 'dal_segno', label: irealCanonicalSymbolText('dal_segno') ?? 'D.S.' },
  { value: 'dal_segno_al_coda', label: irealCanonicalSymbolText('dal_segno_al_coda') ?? 'D.S. al Coda' },
  { value: 'dal_segno_al_fine', label: irealCanonicalSymbolText('dal_segno_al_fine') ?? 'D.S. al Fine' },
  { value: 'dal_segno_al_1st_end', label: irealCanonicalSymbolText('dal_segno_al_1st_end') ?? 'D.S. al 1st End.' },
  { value: 'dal_segno_al_2nd_end', label: irealCanonicalSymbolText('dal_segno_al_2nd_end') ?? 'D.S. al 2nd End.' },
  { value: 'dal_segno_al_3rd_end', label: irealCanonicalSymbolText('dal_segno_al_3rd_end') ?? 'D.S. al 3rd End.' },
];

const ACCIDENTAL_OPTIONS: ReadonlyArray<{ value: IrealAccidental; label: string }> = [
  { value: 'natural', label: '♮' },
  { value: 'sharp', label: '♯' },
  { value: 'flat', label: '♭' },
];

const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

// ---------------------------------------------------------------------------
// Helper: bass-note parser
// ---------------------------------------------------------------------------

/** Render `IrealChordRoot` as a string for the bass-input field.
 * Inverse of `parseBassInput`. Sister-site: `popover.ts:608-611`. */
function formatBass(root: IrealChordRoot): string {
  const acc = root.accidental === 'sharp' ? '♯' : root.accidental === 'flat' ? '♭' : '';
  return `${root.note}${acc}`;
}

/** Parse a free-text bass entry into one of three outcomes:
 *
 *   - `null`        — empty input; the chord is no longer a slash chord.
 *   - `IrealChordRoot` — `A`..`G` followed by optional `♭` / `♯` / `b` / `#`.
 *   - `'invalid'`   — anything else; the caller should NOT mutate the
 *                     AST (the previous bass stays intact) and SHOULD
 *                     surface the rejection visually.
 *
 * The three-valued return distinguishes the cases at the type
 * level so the call site can act differently. Sister-site:
 * `popover.ts:627-638`. */
function parseBassInput(s: string): IrealChordRoot | null | 'invalid' {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  const note = trimmed.charAt(0).toUpperCase();
  if (note < 'A' || note > 'G') return 'invalid';
  const rest = trimmed.slice(1);
  let accidental: IrealAccidental = 'natural';
  if (rest === '♯' || rest === '#') accidental = 'sharp';
  else if (rest === '♭' || rest === 'b') accidental = 'flat';
  else if (rest !== '') return 'invalid';
  return { note, accidental };
}

/** Default new chord row used by "+ Add chord". C major on beat 1.
 * Sister-site: `popover.ts:595-604` `makeDefaultBarChord`. */
function makeDefaultBarChord(): IrealBarChord {
  return {
    chord: {
      root: { note: 'C', accidental: 'natural' },
      quality: { kind: 'major' },
      bass: null,
    },
    position: { beat: 1, subdivision: 0 },
  };
}

/** Encode an `IrealBeatPosition` as the matching dropdown value. */
function encodeBeatPosition(beat: number, subdivision: number): string {
  const found = BEAT_POSITION_OPTIONS.find(
    (o) => o.beat === beat && o.subdivision === subdivision,
  );
  return found?.value ?? '1';
}

// ---------------------------------------------------------------------------
// <IrealBarPopover> component
// ---------------------------------------------------------------------------

export interface IrealBarPopoverProps {
  /** The bar to edit. Mounted into a deep-cloned draft; mutations
   * inside the popover do NOT affect this prop. */
  bar: IrealBar;
  /** Ref to the anchor (clicked bar cell). The focus trap excludes
   * this element from outside-click dismissal so the click that
   * opened the popover does not immediately close it. Focus
   * returns here when the popover closes (if the anchor is still
   * in the document). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Called with the edited bar when the user clicks Save. */
  onSave: (next: IrealBar) => void;
  /** Called when the popover closes — Save, Cancel, Escape, or
   * outside-click. */
  onDismiss: () => void;
}

export function IrealBarPopover({
  bar,
  anchorRef,
  onSave,
  onDismiss,
}: IrealBarPopoverProps): ReactElement {
  // Seed each piece of draft state lazily — `useState(() => ...)`
  // runs the initializer exactly once on mount, regardless of how
  // many times the host re-renders with new `bar` values.
  // Subsequent re-renders driven by sub-component edits cannot
  // reset the draft. The IrealBar type is pure-data (no functions
  // / Maps / Dates) so JSON cloning preserves it byte-equal.
  // Sister-site: `popover.ts:128`.
  const [start, setStart] = useState<IrealBarLine>(() => bar.start);
  const [end, setEnd] = useState<IrealBarLine>(() => bar.end);
  const [chords, setChords] = useState<IrealBarChord[]>(
    () => JSON.parse(JSON.stringify(bar.chords)) as IrealBarChord[],
  );
  const [ending, setEnding] = useState<number | null>(() => bar.ending);
  const [symbol, setSymbol] = useState<IrealMusicalSymbol | null>(
    () => bar.symbol,
  );

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, { onDismiss, anchorRef, enabled: true });

  const handleSave = useCallback((): void => {
    onSave({
      start,
      end,
      chords,
      ending,
      symbol,
      // Preserve every other AST field on the seed bar that the
      // popover does not edit yet (e.g. staff-text, system-break
      // hints, beat-grouping overrides). Without the spread, those
      // fields would be silently dropped on Save.
      ...(({ start: _s, end: _e, chords: _c, ending: _en, symbol: _sym, ...rest }) => rest)(bar),
    });
    onDismiss();
  }, [bar, start, end, chords, ending, symbol, onSave, onDismiss]);

  const updateChord = useCallback(
    (index: number, next: IrealBarChord): void => {
      setChords((prev) => prev.map((c, i) => (i === index ? next : c)));
    },
    [],
  );

  const moveChordUp = useCallback((index: number): void => {
    setChords((prev) => {
      if (index <= 0 || index >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[index - 1]!;
      next[index - 1] = next[index]!;
      next[index] = tmp;
      return next;
    });
  }, []);

  const moveChordDown = useCallback((index: number): void => {
    setChords((prev) => {
      if (index < 0 || index >= prev.length - 1) return prev;
      const next = [...prev];
      const tmp = next[index + 1]!;
      next[index + 1] = next[index]!;
      next[index] = tmp;
      return next;
    });
  }, []);

  const removeChord = useCallback((index: number): void => {
    setChords((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addChord = useCallback((): void => {
    setChords((prev) => [...prev, makeDefaultBarChord()]);
  }, []);

  return (
    <div
      ref={dialogRef}
      className="chordsketch-ireal-bar-grid__popover"
      role="dialog"
      aria-modal="true"
      aria-label="Edit bar"
      tabIndex={-1}
    >
      <div className="chordsketch-ireal-bar-grid__popover-body">
        <BarLineSelect label="Start barline" value={start} onChange={setStart} />
        <BarLineSelect label="End barline" value={end} onChange={setEnd} />

        <div className="chordsketch-ireal-bar-grid__popover-section">
          <h4>Chords</h4>
          {chords.map((bc, index) => (
            <ChordRowEditor
              key={index}
              barChord={bc}
              index={index}
              count={chords.length}
              onChange={(next) => updateChord(index, next)}
              onMoveUp={() => moveChordUp(index)}
              onMoveDown={() => moveChordDown(index)}
              onRemove={() => removeChord(index)}
            />
          ))}
          <button
            type="button"
            className="chordsketch-ireal-bar-grid__popover-addrow"
            onClick={addChord}
          >
            + Add chord
          </button>
        </div>

        <EndingInput value={ending} onChange={setEnding} />
        <SymbolPicker value={symbol} onChange={setSymbol} />
      </div>

      <div className="chordsketch-ireal-bar-grid__popover-footer">
        <button
          type="button"
          className="chordsketch-ireal-bar-grid__popover-cancel"
          onClick={onDismiss}
        >
          Cancel
        </button>
        <button
          type="button"
          className="chordsketch-ireal-bar-grid__popover-save"
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface BarLineSelectProps {
  label: string;
  value: IrealBarLine;
  onChange: (next: IrealBarLine) => void;
}

function BarLineSelect({ label, value, onChange }: BarLineSelectProps): ReactElement {
  return (
    <label className="chordsketch-ireal-bar-grid__field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as IrealBarLine)}
      >
        {BARLINE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ChordRowEditorProps {
  barChord: IrealBarChord;
  index: number;
  count: number;
  onChange: (next: IrealBarChord) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function ChordRowEditor({
  barChord,
  index,
  count,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: ChordRowEditorProps): ReactElement {
  // Three-valued bass input state. `null` (initial valid empty),
  // `valid` (parser produced a ChordRoot), `invalid` (free-text
  // garbage). The AST mutation only fires on `null` or `valid`;
  // `invalid` keeps the previous bass intact and surfaces an
  // `--invalid` modifier class so the user sees their input was
  // rejected. Sister-site rationale: `popover.ts:288-300`.
  const [bassRaw, setBassRaw] = useState<string>(
    barChord.chord.bass !== null ? formatBass(barChord.chord.bass) : '',
  );
  const [bassInvalid, setBassInvalid] = useState<boolean>(false);

  // Sync the bass display whenever the barChord prop changes from outside
  // this component. Using `barChord` (the whole object) as the dep rather
  // than `barChord.chord.bass` alone ensures that a null→null reorder
  // (both outgoing and incoming chord have no bass) still resets any
  // in-progress `bassRaw` / `bassInvalid` state — `null === null` would
  // make a narrower dep silently skip the reset, leaving `bassRaw = 'ZZZ'`
  // and `aria-invalid` set against the wrong chord after the swap.
  //
  // The broader dep means the display also resets to the committed state
  // when the user changes root / accidental / quality / position, which is
  // defensively correct: those edits produce a new `barChord` reference,
  // and the committed bass value is the right one to show at that point.
  // Sister-site rationale: the DOM editor at
  // `packages/ui-irealb-editor/src/popover.ts` rebuilds the row DOM on
  // every reorder via `renderChordsSection()`, implicitly discarding
  // stale state — this useEffect is the React-idiomatic equivalent.
  //
  // `formatBass` is a stable module-scope pure function; the eslint-disable
  // below suppresses the false-positive exhaustive-deps warning for it.
  useEffect(() => {
    const propStr = barChord.chord.bass !== null ? formatBass(barChord.chord.bass) : '';
    setBassRaw((prev) => (prev === propStr ? prev : propStr));
    setBassInvalid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barChord]);

  const setRoot = (note: string): void => {
    onChange({
      ...barChord,
      chord: {
        ...barChord.chord,
        root: { ...barChord.chord.root, note },
      },
    });
  };

  const setAccidental = (accidental: IrealAccidental): void => {
    onChange({
      ...barChord,
      chord: {
        ...barChord.chord,
        root: { ...barChord.chord.root, accidental },
      },
    });
  };

  const setQuality = (kind: IrealChordQuality['kind']): void => {
    if (kind === 'custom') {
      const value =
        barChord.chord.quality.kind === 'custom' ? barChord.chord.quality.value : '';
      onChange({
        ...barChord,
        chord: { ...barChord.chord, quality: { kind: 'custom', value } },
      });
    } else {
      onChange({
        ...barChord,
        chord: { ...barChord.chord, quality: { kind } as IrealChordQuality },
      });
    }
  };

  const setCustomValue = (value: string): void => {
    if (barChord.chord.quality.kind !== 'custom') return;
    onChange({
      ...barChord,
      chord: { ...barChord.chord, quality: { kind: 'custom', value } },
    });
  };

  const handleBassChange = (raw: string): void => {
    setBassRaw(raw);
    const result = parseBassInput(raw);
    if (result === 'invalid') {
      setBassInvalid(true);
      return;
    }
    setBassInvalid(false);
    onChange({
      ...barChord,
      chord: { ...barChord.chord, bass: result },
    });
  };

  const setPosition = (value: string): void => {
    const opt = BEAT_POSITION_OPTIONS.find((o) => o.value === value);
    if (!opt) return;
    onChange({
      ...barChord,
      position: { beat: opt.beat, subdivision: opt.subdivision },
    });
  };

  return (
    <div
      className="chordsketch-ireal-bar-grid__popover-chordrow"
      data-row-index={index}
    >
      <label className="chordsketch-ireal-bar-grid__field">
        <span>Root</span>
        <select
          value={barChord.chord.root.note}
          onChange={(e) => setRoot(e.target.value)}
        >
          {NOTE_LETTERS.map((letter) => (
            <option key={letter} value={letter}>
              {letter}
            </option>
          ))}
        </select>
      </label>
      <label className="chordsketch-ireal-bar-grid__field">
        <span>Acc.</span>
        <select
          value={barChord.chord.root.accidental}
          onChange={(e) => setAccidental(e.target.value as IrealAccidental)}
        >
          {ACCIDENTAL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="chordsketch-ireal-bar-grid__field">
        <span>Quality</span>
        <select
          value={barChord.chord.quality.kind}
          onChange={(e) =>
            setQuality(e.target.value as IrealChordQuality['kind'])
          }
        >
          {QUALITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {barChord.chord.quality.kind === 'custom' && (
        <label className="chordsketch-ireal-bar-grid__field">
          <span>Custom</span>
          <input
            type="text"
            placeholder="e.g. 7♯9"
            value={barChord.chord.quality.value}
            onChange={(e) => setCustomValue(e.target.value)}
          />
        </label>
      )}
      <label className="chordsketch-ireal-bar-grid__field">
        <span>Bass</span>
        <input
          type="text"
          placeholder="/X (optional)"
          value={bassRaw}
          onChange={(e) => handleBassChange(e.target.value)}
          className={bassInvalid ? 'chordsketch-ireal-bar-grid__input--invalid' : undefined}
          aria-invalid={bassInvalid || undefined}
        />
      </label>
      <label className="chordsketch-ireal-bar-grid__field">
        <span>Pos.</span>
        <select
          value={encodeBeatPosition(barChord.position.beat, barChord.position.subdivision)}
          onChange={(e) => setPosition(e.target.value)}
        >
          {BEAT_POSITION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="chordsketch-ireal-bar-grid__popover-rowbtn"
        aria-label="Move chord up"
        onClick={onMoveUp}
        disabled={index === 0}
      >
        ↑
      </button>
      <button
        type="button"
        className="chordsketch-ireal-bar-grid__popover-rowbtn"
        aria-label="Move chord down"
        onClick={onMoveDown}
        disabled={index === count - 1}
      >
        ↓
      </button>
      <button
        type="button"
        className="chordsketch-ireal-bar-grid__popover-rowbtn"
        aria-label="Remove chord"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

interface EndingInputProps {
  /** `null` = no bracket, `0` = N0 untitled sentinel, `1..9` = numbered. */
  value: number | null;
  onChange: (next: number | null) => void;
}

function EndingInput({ value, onChange }: EndingInputProps): ReactElement {
  return (
    <label className="chordsketch-ireal-bar-grid__field">
      <span>N-th ending</span>
      <input
        type="number"
        min={0}
        max={9}
        step={1}
        value={value ?? ''}
        placeholder="None (0 = untitled)"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(null);
            return;
          }
          const n = Number.parseInt(raw, 10);
          if (!Number.isFinite(n) || n < 0 || n > 9) {
            // Out-of-range / non-numeric values are dropped. The
            // AST keeps its previous value until a valid number is
            // entered. Mirrors `popover.ts:400-414`.
            return;
          }
          onChange(n);
        }}
      />
    </label>
  );
}

interface SymbolPickerProps {
  value: IrealMusicalSymbol | null;
  onChange: (next: IrealMusicalSymbol | null) => void;
}

function SymbolPicker({ value, onChange }: SymbolPickerProps): ReactElement {
  return (
    <label className="chordsketch-ireal-bar-grid__field">
      <span>Symbol</span>
      <select
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? null : (v as IrealMusicalSymbol));
        }}
      >
        {SYMBOL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
