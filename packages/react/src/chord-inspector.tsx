// Chord-editor footer for the ChordPro surface (#2622, #2630, #2638,
// #2644, #2648).
//
// A non-modal, edit-only panel for the chord under the caret / selection.
// It began as a top-left overlay (#2630 moved it to a bottom sheet; #2638
// made it a full-width footer below the song). #2644 lifted it to a
// shell-level bar spanning the editor + preview, driven by the editor
// caret. It has two states:
//
//   - SELECTED ("Editing chord"): the caret sits on a `[chord]` (or a
//     rendered chord was clicked). Root / accidental / type / suffix /
//     bass changes rewrite that chord in place; ◀ / ▶ move it one lyric
//     character; "Remove chord" deletes it.
//   - IDLE ("No chord selected"): the caret is in the lyrics. The footer
//     shows only a hint — it is edit-only, so it offers no controls when
//     nothing is selected (#2648). Inserting a new chord is handled by a
//     separate surface.
//
// It is purely presentational — the parent owns the chord parts and the
// source mutation (via `chord-source-edit`'s `buildChordName` /
// `applyChordEdit` / `applyChordDelete`), so there is no parallel chord
// state here. It is the ChordPro sibling of the iReal Pro
// `<IrealBarPopover>` chord-row editor.

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';

import { ChordStaff } from './chord-staff';
import {
  DEFAULT_CHORD_SELECTION,
  SEVENTH_OPTIONS,
  TENSION_OPTIONS,
  TRIAD_OPTIONS,
  composeChordSuffix,
  decomposeChordSuffix,
  isSeventhAvailable,
  isTensionAvailable,
  toggleTension,
  withSeventh,
  withTriad,
  type ChordParts,
} from './chord-source-edit';
import type { ChordStaffWasmLoader } from './use-chord-staff';

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
   * mode: it shows a hint prompting the user to select a chord, with no
   * editing controls (the footer is edit-only — inserting a new chord is
   * handled elsewhere). Defaults to `true` so the standalone
   * (preview-click) callers that only ever show the panel for a selected
   * chord need not pass it.
   */
  selected?: boolean;
  /** The selected chord's RAW name (as it appears in source), e.g.
   * `"Bbm7"`. Used as the header fallback when {@link displayName} is
   * omitted, and in the group's accessible label. */
  chordName?: string;
  /** The chord name with Unicode accidentals (e.g. `"B♭m7"`), matching
   * how the renderer paints the chord. Shown in the header so the
   * editor's title agrees with the preview instead of the raw ASCII
   * `b` / `#`. Falls back to {@link chordName} when omitted. */
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
   * right. Only consulted in the selected state — the idle state renders
   * no move buttons. */
  canLeft: boolean;
  canRight: boolean;
  /** Fired with the full updated parts on any root / accidental / type /
   * suffix / bass change. The parent rebuilds the chord token and writes
   * it back to source. Only reachable when a chord is selected (the idle
   * state renders no controls). */
  onChange: (parts: ChordParts) => void;
  /** Fired when a move button is pressed. `-1` = left, `+1` = right.
   * Only reachable when {@link selected} is true. */
  onNudge: (direction: -1 | 1) => void;
  /** Remove the selected chord (delete its `[chord]` token). Omit to
   * hide the "Remove chord" button (e.g. when no delete handler is
   * wired). */
  onRemove?: () => void;
  /** Close the inspector (deselect). Omit to hide the close button —
   * the caret-driven shell has no separate "deselect" (the user moves
   * the caret off the chord), so it does not pass this. */
  onClose?: () => void;
  /** Optional hint shown in place of the default idle message, e.g. when
   * source-coordinate editing is gated by an active transpose / capo.
   * Only rendered in the idle state (when {@link selected} is false); a
   * `note` passed alongside `selected: true` is not shown. */
  note?: string;
  /** The song key in effect at the selected chord's position (a ChordPro
   * `{key}` value), honouring any mid-song modulation. Forwarded to the
   * `<ChordStaff>` so the constituent-notes staff draws that key's signature
   * and renders accidentals relative to it. Omit for the key-agnostic staff. */
  musicKey?: string | null;
  /** Test-only WASM loader override forwarded to the `<ChordStaff>` shown
   * beneath the chord name. Production callers never supply this — the staff
   * lazy-loads `@chordsketch/wasm` itself.
   *
   * @internal */
  staffLoader?: ChordStaffWasmLoader;
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

  const emit = (patch: Partial<ChordParts>): void => {
    props.onChange({ root, accidental, suffix, bass, ...patch });
  };

  // Decompose the current suffix into the structured triad / seventh /
  // tension selection so the controls light up for the chord under the
  // caret. A suffix the structured model cannot represent (e.g. `7alt`, or
  // any free-form text) yields `null`: the controls then render unpressed
  // (`recognized` is false) and the chord is edited through the free-form
  // field. Toggling any control rebuilds the suffix from `selection`, so an
  // unrecognised suffix is normalised the moment the user touches a control.
  const decomposed = decomposeChordSuffix(suffix);
  const recognized = decomposed !== null;
  const selection = decomposed ?? DEFAULT_CHORD_SELECTION;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && props.onClose) {
      event.preventDefault();
      props.onClose();
    }
  };

  // Idle state — the footer is edit-only, so when no chord is selected
  // it shows a hint instead of editing controls (inserting a new chord
  // is handled elsewhere). Also carries the gated-editing `note`.
  if (!selected) {
    return (
      <div
        className="chordsketch-sheet__cins chordsketch-sheet__cins--idle"
        role="group"
        aria-label="Chord editor"
        data-mode="idle"
        onKeyDown={onKeyDown}
      >
        <div className="chordsketch-sheet__cins-head">
          <div>
            <div className="chordsketch-sheet__cins-eyebrow">No chord selected</div>
            <div className="chordsketch-sheet__cins-idle-hint">
              {props.note ??
                'Click a chord in the preview, or move the caret onto one in the editor, to edit it.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="chordsketch-sheet__cins"
      role="group"
      aria-label={`Edit chord ${titleName || '(empty)'}`}
      data-mode="edit"
      onKeyDown={onKeyDown}
    >
      <div className="chordsketch-sheet__cins-head">
        <div className="chordsketch-sheet__cins-title">
          <div className="chordsketch-sheet__cins-eyebrow">Editing chord</div>
          <div className="chordsketch-sheet__cins-name">{titleName || '—'}</div>
          {/* Constituent notes of the chord on a five-line staff, beneath
              the name. Empty `chordName` (a rootless / unparseable token)
              still renders the placeholder rather than a broken staff. */}
          {chordName ? (
            <ChordStaff
              chord={chordName}
              displayName={titleName || undefined}
              musicKey={props.musicKey}
              wasmLoader={props.staffLoader}
              className="chordsketch-sheet__cins-staff"
            />
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

      {/* Structured chord-type controls (ADR-0037): triad quality, seventh,
          and tensions are three orthogonal groups whose composition only ever
          yields an explicit, unambiguous suffix (e.g. `7(9,11,13)`, never the
          ambiguous `13`). The current suffix is decomposed to light up the
          controls; an unrecognised (free-form) suffix leaves them all
          unpressed and is edited through the Quality / ext. field below. */}
      <div className="chordsketch-sheet__cins-group chordsketch-sheet__cins-group--type">
        <span className="chordsketch-sheet__cins-label">Triad</span>
        <div
          className="chordsketch-sheet__cins-chips"
          role="group"
          aria-label="Triad quality"
        >
          {TRIAD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="chordsketch-sheet__cins-chip"
              aria-pressed={recognized && selection.triad === opt.value}
              onClick={() => emit({ suffix: composeChordSuffix(withTriad(selection, opt.value)) })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chordsketch-sheet__cins-group chordsketch-sheet__cins-group--type">
        <span className="chordsketch-sheet__cins-label">7th</span>
        <div
          className="chordsketch-sheet__cins-chips"
          role="group"
          aria-label="Seventh"
        >
          {SEVENTH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="chordsketch-sheet__cins-chip"
              disabled={!isSeventhAvailable(selection.triad, opt.value)}
              aria-pressed={recognized && selection.seventh === opt.value}
              onClick={() => emit({ suffix: composeChordSuffix(withSeventh(selection, opt.value)) })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chordsketch-sheet__cins-group chordsketch-sheet__cins-group--type">
        <span className="chordsketch-sheet__cins-label">Tensions</span>
        <div
          className="chordsketch-sheet__cins-chips"
          role="group"
          aria-label="Tensions"
        >
          {TENSION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="chordsketch-sheet__cins-chip"
              disabled={!isTensionAvailable(selection.triad, selection.seventh, opt.value)}
              aria-pressed={recognized && selection.tensions.includes(opt.value)}
              onClick={() => emit({ suffix: composeChordSuffix(toggleTension(selection, opt.value)) })}
            >
              {opt.label}
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
          <span className="chordsketch-sheet__cins-movelbl">Move chord</span>
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
      </div>
    </div>
  );
}
