// Chord-editor footer for the ChordPro surface (#2622, #2630, #2638,
// #2644).
//
// A non-modal panel that edits the chord under the caret / selection. It
// began as a top-left overlay (#2630 moved it to a bottom sheet; #2638
// made it a full-width footer below the song). #2644 lifted it to a
// shell-level bar spanning the editor + preview, driven by the editor
// caret, and gave it two states:
//
//   - SELECTED ("Editing chord"): the caret sits on a `[chord]` (or a
//     rendered chord was clicked). Root / accidental / type / suffix /
//     bass changes rewrite that chord in place; ◀ / ▶ move it one lyric
//     character; "Remove chord" deletes it.
//   - IDLE ("New chord"): the caret is in the lyrics. The same controls
//     build a draft chord; "Insert chord" places it at the caret. Move /
//     remove are disabled (there is no chord to move or remove).
//
// It is purely presentational — the parent owns the chord parts and the
// source mutation (via `chord-source-edit`'s `buildChordName` /
// `applyChordEdit` / `applyChordInsert` / `applyChordDelete`), so there
// is no parallel chord state here. It is the ChordPro sibling of the
// iReal Pro `<IrealBarPopover>` chord-row editor.

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
  /**
   * Whether a chord is currently selected (the caret is on a `[chord]`,
   * or a rendered chord was clicked). When `false`, the panel is in idle
   * mode: the controls build a draft chord for insertion, the header
   * reads "New chord", and the move / remove controls are disabled.
   * Defaults to `true` so the standalone (preview-click) callers that
   * only ever show the panel for a selected chord need not pass it.
   */
  selected?: boolean;
  /** The selected chord's RAW name (as it appears in source), e.g.
   * `"Bbm7"`. Used as the header fallback when {@link displayName} is
   * omitted, and in the group's accessible label. */
  chordName?: string;
  /** The chord name with Unicode accidentals (e.g. `"B♭m7"`), matching
   * how the renderer paints the chord. Shown in the header so the
   * editor's title agrees with the preview instead of the raw ASCII
   * `b` / `#`. Falls back to {@link chordName} when omitted. In idle
   * mode this is the draft chord being built. */
  displayName?: string;
  /** Current root letter `A`–`G` (empty for a rootless / un-editable
   * token). */
  root: string;
  /** Current root accidental. */
  accidental: '' | '#' | 'b';
  /** Current quality+extension suffix (e.g. `"m7"`, `""` for major). */
  suffix: string;
  /** Current slash-bass token without the leading `/` (e.g. `"G"`), or
   * empty for no slash. */
  bass: string;
  /** Whether the selected chord can move one lyric character left /
   * right. Ignored in idle mode (the move buttons are disabled). */
  canLeft: boolean;
  canRight: boolean;
  /** Fired with the full updated parts on any root / accidental / type /
   * suffix / bass change. When a chord is selected the parent rebuilds
   * the chord token and writes it back to source; in idle mode the
   * parent updates the draft chord used by {@link onInsert}. */
  onChange: (parts: ChordParts) => void;
  /** Fired when a move button is pressed. `-1` = left, `+1` = right.
   * Only reachable when {@link selected} is true. */
  onNudge: (direction: -1 | 1) => void;
  /** Insert the current parts as a NEW `[chord]` at the caret. Omit to
   * hide the "Insert chord" button (e.g. when source-coordinate editing
   * is gated by an active transpose / capo). */
  onInsert?: () => void;
  /** Remove the selected chord (delete its `[chord]` token). Omit to
   * hide the "Remove chord" button (e.g. in idle mode, or when no delete
   * handler is wired). */
  onRemove?: () => void;
  /** Close the inspector (deselect). Omit to hide the close button —
   * the caret-driven shell has no separate "deselect" (the user moves
   * the caret off the chord), so it does not pass this. */
  onClose?: () => void;
  /** Optional hint shown in the header, e.g. when source-coordinate
   * editing is gated by an active transpose / capo so the controls are
   * inert. */
  note?: string;
}

/**
 * The chord-editor footer panel. Renders design-system-styled controls
 * keyed off `.chordsketch-sheet__cins*` classes (see `styles.css`). Not
 * a modal — the surface stays interactive while it is open — so it does
 * not trap focus; Escape closes it when {@link ChordInspectorProps.onClose}
 * is wired.
 */
export function ChordInspector(props: ChordInspectorProps): JSX.Element {
  const {
    selected = true,
    chordName,
    displayName,
    root,
    accidental,
    suffix,
    bass,
    canLeft,
    canRight,
  } = props;
  // Header / aria title: prefer the Unicode-accidental display name so
  // the editor's title matches the rendered chord (B♭, not Bb).
  const titleName = displayName ?? chordName ?? '';
  const eyebrow = selected ? 'Editing chord' : 'New chord';
  const ariaLabel = selected
    ? `Edit chord ${titleName || '(empty)'}`
    : 'Build and insert a new chord';

  const emit = (patch: Partial<ChordParts>): void => {
    props.onChange({ root, accidental, suffix, bass, ...patch });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && props.onClose) {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      className="chordsketch-sheet__cins"
      role="group"
      aria-label={ariaLabel}
      data-mode={selected ? 'edit' : 'idle'}
      onKeyDown={onKeyDown}
    >
      <div className="chordsketch-sheet__cins-head">
        <div>
          <div className="chordsketch-sheet__cins-eyebrow">{eyebrow}</div>
          <div className="chordsketch-sheet__cins-name">{titleName || '—'}</div>
          {props.note ? (
            <div className="chordsketch-sheet__cins-note">{props.note}</div>
          ) : null}
        </div>
        {props.onClose ? (
          <button
            type="button"
            className="chordsketch-sheet__cins-close"
            aria-label="Close chord editor"
            onClick={props.onClose}
          >
            ✕
          </button>
        ) : null}
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

      <div className="chordsketch-sheet__cins-group chordsketch-sheet__cins-group--type">
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
            disabled={!selected || !canLeft}
            onClick={() => props.onNudge(-1)}
          >
            ◀
          </button>
          <span className="chordsketch-sheet__cins-movelbl">lyric position</span>
          <button
            type="button"
            className="chordsketch-sheet__cins-movebtn"
            aria-label="Move chord right"
            disabled={!selected || !canRight}
            onClick={() => props.onNudge(1)}
          >
            ▶
          </button>
        </div>
      </div>

      <div className="chordsketch-sheet__cins-footer">
        {props.onRemove && selected ? (
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
        {props.onInsert ? (
          <button
            type="button"
            className="chordsketch-sheet__cins-insert"
            onClick={props.onInsert}
          >
            Insert chord
          </button>
        ) : null}
      </div>
    </div>
  );
}
