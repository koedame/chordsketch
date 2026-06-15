// Floating chord-editor inspector for the ChordPro preview (#2622).
//
// A bottom-docked, non-modal panel that appears when a chord is selected
// in the preview (#2630 moved it from a top-left overlay to a bottom
// sheet so it no longer covers the lyrics / chord being edited; the
// parent scrolls the selected chord into view above the dock). It edits
// the selected chord's root, accidental, type
// (a quality+extension preset or free-form suffix), and optional slash
// bass, and hosts the relocated ◀ / ▶ "move one lyric character"
// controls plus delete. It is the ChordPro sibling of the iReal Pro
// `<IrealBarPopover>` chord-row editor, and like that surface it is
// purely presentational: the parent owns the chord parts and the source
// mutation (via `chord-source-edit`'s `buildChordName` / `applyChordEdit`
// / `applyChordDelete`), so there is no parallel chord state here.

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';

import {
  CHORD_TYPE_PRESETS,
  type ChordParts,
} from './chord-source-edit';

/** Root letters offered in the segmented control, C-major order. */
const ROOT_NOTES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

/** Accidental options: natural / sharp / flat, mapped to the source
 * characters {@link ChordParts.accidental} carries. */
const ACCIDENTALS: ReadonlyArray<{ value: '' | '#' | 'b'; label: string; aria: string }> = [
  { value: '', label: '♮', aria: 'Natural' },
  { value: '#', label: '♯', aria: 'Sharp' },
  { value: 'b', label: '♭', aria: 'Flat' },
];

/** Props for {@link ChordInspector}. Controlled: the parent supplies the
 * current parts + bounds and receives every edit through the callbacks. */
export interface ChordInspectorProps {
  /** The selected chord's display name for the header, e.g. `"Am7"`. */
  chordName: string;
  /** Current root letter `A`–`G`. */
  root: string;
  /** Current root accidental. */
  accidental: '' | '#' | 'b';
  /** Current quality+extension suffix (e.g. `"m7"`, `""` for major). */
  suffix: string;
  /** Current slash-bass token without the leading `/` (e.g. `"G"`), or
   * empty for no slash. */
  bass: string;
  /** Whether the chord can move one lyric character left / right. */
  canLeft: boolean;
  canRight: boolean;
  /** Fired with the full updated parts on any root / accidental / type /
   * suffix / bass change. The parent rebuilds the chord token and writes
   * it back to source. */
  onChange: (parts: ChordParts) => void;
  /** Fired when a move button is pressed. `-1` = left, `+1` = right. */
  onNudge: (direction: -1 | 1) => void;
  /** Remove the chord (delete its `[chord]` token). Omit to hide the
   * "Remove chord" button (e.g. when no delete handler is wired). */
  onRemove?: () => void;
  /** Close the inspector (deselect). */
  onClose: () => void;
}

/**
 * The chord-editor inspector panel. Renders design-system-styled
 * controls keyed off `.chordsketch-sheet__cins*` classes (see
 * `styles.css`). Not a modal — the sheet stays interactive while it is
 * open — so it does not trap focus; Escape closes it.
 */
export function ChordInspector(props: ChordInspectorProps): JSX.Element {
  const { chordName, root, accidental, suffix, bass, canLeft, canRight } = props;

  const emit = (patch: Partial<ChordParts>): void => {
    props.onChange({ root, accidental, suffix, bass, ...patch });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      className="chordsketch-sheet__cins"
      role="group"
      aria-label={`Edit chord ${chordName || '(empty)'}`}
      onKeyDown={onKeyDown}
    >
      <div className="chordsketch-sheet__cins-head">
        <div>
          <div className="chordsketch-sheet__cins-eyebrow">Editing chord</div>
          <div className="chordsketch-sheet__cins-name">{chordName || '—'}</div>
        </div>
        <button
          type="button"
          className="chordsketch-sheet__cins-close"
          aria-label="Close chord editor"
          onClick={props.onClose}
        >
          ✕
        </button>
      </div>

      <div className="chordsketch-sheet__cins-group">
        <span className="chordsketch-sheet__cins-label">Root</span>
        <div
          className="chordsketch-sheet__cins-seg"
          role="group"
          aria-label="Root note"
        >
          {ROOT_NOTES.map((note) => (
            <button
              key={note}
              type="button"
              aria-pressed={root === note}
              onClick={() => emit({ root: note })}
            >
              {note}
            </button>
          ))}
        </div>
        <div
          className="chordsketch-sheet__cins-seg"
          role="group"
          aria-label="Accidental"
        >
          {ACCIDENTALS.map((acc) => (
            <button
              key={acc.aria}
              type="button"
              aria-label={acc.aria}
              aria-pressed={accidental === acc.value}
              onClick={() => emit({ accidental: acc.value })}
            >
              {acc.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chordsketch-sheet__cins-group">
        <span className="chordsketch-sheet__cins-label">Type</span>
        <div
          className="chordsketch-sheet__cins-chips"
          role="group"
          aria-label="Chord type"
        >
          {CHORD_TYPE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="chordsketch-sheet__cins-chip"
              aria-pressed={suffix === preset.text}
              onClick={() => emit({ suffix: preset.text })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chordsketch-sheet__cins-row2">
        <label className="chordsketch-sheet__cins-field">
          <span className="chordsketch-sheet__cins-label">Quality / ext.</span>
          <input
            className="chordsketch-sheet__cins-input"
            value={suffix}
            placeholder="m7, sus4…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => emit({ suffix: e.target.value })}
          />
        </label>
        <label className="chordsketch-sheet__cins-field">
          <span className="chordsketch-sheet__cins-label">/ Bass</span>
          <input
            className="chordsketch-sheet__cins-input"
            value={bass}
            placeholder="G, F#…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => emit({ bass: e.target.value })}
          />
        </label>
      </div>

      <div className="chordsketch-sheet__cins-divider" />

      <div className="chordsketch-sheet__cins-group">
        <span className="chordsketch-sheet__cins-label">Move one step</span>
        <div className="chordsketch-sheet__cins-move">
          <button
            type="button"
            className="chordsketch-sheet__cins-movebtn"
            aria-label="Move chord left"
            disabled={!canLeft}
            onClick={() => props.onNudge(-1)}
          >
            ◀
          </button>
          <span className="chordsketch-sheet__cins-movelbl">lyric position</span>
          <button
            type="button"
            className="chordsketch-sheet__cins-movebtn"
            aria-label="Move chord right"
            disabled={!canRight}
            onClick={() => props.onNudge(1)}
          >
            ▶
          </button>
        </div>
      </div>

      <div className="chordsketch-sheet__cins-footer">
        {props.onRemove ? (
          <button
            type="button"
            className="chordsketch-sheet__cins-remove"
            onClick={props.onRemove}
          >
            Remove chord
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="chordsketch-sheet__cins-done"
          onClick={props.onClose}
        >
          Done
        </button>
      </div>
    </div>
  );
}
