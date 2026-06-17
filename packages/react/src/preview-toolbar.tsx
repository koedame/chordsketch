import type { HTMLAttributes, ReactNode } from 'react';

import { Capo } from './capo';
import { PDF_EXPORT_DEFAULT_LABEL, PdfExport } from './pdf-export';
import {
  TRANSPOSE_DEFAULT_MAX,
  TRANSPOSE_DEFAULT_MIN,
  Transpose,
} from './transpose';
import type { WasmLoader } from './use-pdf-export';
import { CAPO_MAX, CAPO_MIN } from './chord-source-edit';
import type {
  ChordDiagramOrientation,
} from './use-chord-diagram';

/** Props accepted by {@link PreviewToolbar}. */
export interface PreviewToolbarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onChange'> {
  /** ChordPro source. Required for the Capo and Export groups. */
  source: string;
  /**
   * Called when the Capo group writes a new `{capo: N}` directive
   * into `source`. Required to enable the Capo group; if omitted
   * the Capo group is hidden (the toolbar still shows Transpose
   * and Export, matching the pre-#2545 VS Code preview behaviour).
   */
  onSourceChange?: (next: string) => void;
  /** Current transpose offset. */
  transpose: number;
  /** Fires when the user clicks the Transpose +/− / Reset buttons. */
  onTransposeChange: (next: number) => void;
  /**
   * Minimum transpose offset. Defaults to
   * {@link TRANSPOSE_DEFAULT_MIN} (`-6`) — the same default the
   * standalone `<Transpose>` select uses. Hosts that need the
   * wider feature range (`±11`) pass it explicitly.
   */
  transposeMin?: number;
  /** Maximum transpose offset. Defaults to {@link TRANSPOSE_DEFAULT_MAX} (`+6`). */
  transposeMax?: number;
  /** Minimum capo position. Defaults to {@link CAPO_MIN} (`0`). */
  capoMin?: number;
  /** Maximum capo position. Defaults to {@link CAPO_MAX} (`12`). */
  capoMax?: number;
  /** Show the Transpose group. Defaults to `true`. */
  showTranspose?: boolean;
  /**
   * Show the Capo group. Defaults to `true` when `onSourceChange`
   * is provided, and `false` otherwise. Pass an explicit value to
   * override the auto-default.
   */
  showCapo?: boolean;
  /** Show the Export group. Defaults to `true`. */
  showExport?: boolean;
  /**
   * Current chord-diagram orientation (#2572). Enables the Diagrams
   * group when paired with `onChordDiagramsOrientationChange`. Omit
   * (or pass without the change handler) to hide the group entirely
   * — hosts that don't want diagram controls in their toolbar pay
   * no extra DOM.
   */
  chordDiagramsOrientation?: ChordDiagramOrientation;
  /** Fires when the user picks a new orientation in the Diagrams group. */
  onChordDiagramsOrientationChange?: (next: ChordDiagramOrientation) => void;
  /**
   * Force-show / force-hide the Diagrams group. Defaults to true
   * when `onChordDiagramsOrientationChange` is provided, false
   * otherwise. Pass an explicit value to override the auto-default.
   */
  showChordDiagrams?: boolean;
  /**
   * Current chord-audio mode state (#2650). Enables the Audio group
   * when paired with `onChordAudioToggle`. Omit (or pass without the
   * handler) to hide the group entirely — hosts that don't want a chord
   * playback control pay no extra DOM.
   */
  chordAudioEnabled?: boolean;
  /**
   * Fires with the next desired state when the user clicks the Audio
   * toggle. The host owns the boolean and forwards it to
   * `<ChordSheet chordAudio={…}>`.
   */
  onChordAudioToggle?: (next: boolean) => void;
  /**
   * Force-show / force-hide the Audio group. Defaults to `true` when
   * `onChordAudioToggle` is provided, `false` otherwise.
   */
  showChordAudio?: boolean;
  /** Filename for the PDF download. Defaults to `chordsketch-output.pdf`. */
  exportFilename?: string;
  /**
   * Test-only WASM loader override for the Export group's
   * `<PdfExport>`. Production callers never supply this — the
   * default dynamic import of `@chordsketch/wasm-export` resolves
   * at click time. Tests inject a stub renderer to drive the
   * export click path without loading real wasm.
   *
   * @internal
   */
  wasmLoader?: WasmLoader;
  /**
   * Optional extra content rendered as a fourth group at the end
   * of the toolbar. Useful for host-specific actions (e.g. a
   * "Send to host" button in a VS Code preview).
   */
  trailing?: ReactNode;
}

const AUDIO_ON_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

// Muted-speaker glyph (a struck-out volume mark) so the off state is
// distinguishable from the on state by shape alone, not just by the
// active fill colour — see #2669.
const AUDIO_OFF_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);

const EXPORT_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

/**
 * Pane-level performance toolbar — Transpose / Capo / Export PDF.
 *
 * Composes `<Transpose>`, `<Capo>`, and `<PdfExport>` into the
 * three-group layout the playground previously hand-rolled inline.
 * Designed to drop into `<ChordProPreview toolbar="performance">`
 * and to be reused by the VS Code preview WebView and any future
 * host (desktop app, embedded library widget).
 *
 * Each group can be hidden independently. The Capo group requires
 * `onSourceChange` because it round-trips through the ChordPro
 * `{capo: N}` directive — hosts that own the source elsewhere
 * (VS Code's `TextDocument`) route the edit through a host-side
 * pipeline by listening for the new `source` argument.
 *
 * The DOM uses both the library's `chordsketch-preview-toolbar*`
 * BEM classes (styled by `@chordsketch/react/styles.css`) and the
 * playground's legacy `pane-toolbar` / `tool-group` / `btn`
 * classes so the playground's existing CSS continues to skin the
 * toolbar after the migration. New consumers can ignore the
 * legacy classes and target the BEM ones only.
 */
export function PreviewToolbar({
  source,
  onSourceChange,
  transpose,
  onTransposeChange,
  transposeMin = TRANSPOSE_DEFAULT_MIN,
  transposeMax = TRANSPOSE_DEFAULT_MAX,
  capoMin = CAPO_MIN,
  capoMax = CAPO_MAX,
  showTranspose = true,
  showCapo,
  showExport = true,
  exportFilename = 'chordsketch-output.pdf',
  wasmLoader,
  chordDiagramsOrientation,
  onChordDiagramsOrientationChange,
  showChordDiagrams,
  chordAudioEnabled,
  onChordAudioToggle,
  showChordAudio,
  trailing,
  className,
  ...divProps
}: PreviewToolbarProps): JSX.Element {
  const capoEnabled = (showCapo ?? onSourceChange !== undefined) && onSourceChange !== undefined;
  const diagramsEnabled =
    (showChordDiagrams ?? onChordDiagramsOrientationChange !== undefined) &&
    onChordDiagramsOrientationChange !== undefined;
  const audioEnabled =
    (showChordAudio ?? onChordAudioToggle !== undefined) && onChordAudioToggle !== undefined;
  const effectiveOrientation: ChordDiagramOrientation =
    chordDiagramsOrientation ?? 'vertical';
  const wrapperClass = [
    'chordsketch-preview-toolbar',
    'pane-toolbar',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      {...divProps}
      role="toolbar"
      aria-label={
        typeof divProps['aria-label'] === 'string'
          ? divProps['aria-label']
          : 'Preview performance controls'
      }
      className={wrapperClass}
    >
      {showTranspose ? (
        <Transpose
          className="chordsketch-preview-toolbar__group tool-group chordsketch-preview-toolbar__group--transpose"
          value={transpose}
          onChange={onTransposeChange}
          min={transposeMin}
          max={transposeMax}
          label="Transpose"
        />
      ) : null}
      {capoEnabled ? (
        <Capo
          className="chordsketch-preview-toolbar__group tool-group chordsketch-preview-toolbar__group--capo"
          source={source}
          onSourceChange={onSourceChange!}
          min={capoMin}
          max={capoMax}
          label="Capo"
          /* Thread the active transpose offset through so the
             ★ best-capo markers shift with the host's
             `<Transpose>` select — best-capo recommendations
             are computed against the *transposed* chord roots. */
          transpose={transpose}
        />
      ) : null}
      {diagramsEnabled ? (
        <div
          className="chordsketch-preview-toolbar__group tool-group chordsketch-preview-toolbar__group--diagrams"
          role="group"
          aria-label="Chord diagrams"
        >
          <span
            className="chordsketch-preview-toolbar__label label"
            id="chordsketch-preview-toolbar-diagrams-orientation-label"
            aria-hidden="true"
          >
            Diagrams
          </span>
          <select
            className="chordsketch-preview-toolbar__diagrams-orientation"
            value={effectiveOrientation}
            aria-labelledby="chordsketch-preview-toolbar-diagrams-orientation-label"
            onChange={(e) =>
              onChordDiagramsOrientationChange!(
                e.target.value as ChordDiagramOrientation,
              )
            }
          >
            <option value="vertical">Vertical (nut top)</option>
            <option value="horizontal">Horizontal (nut left)</option>
          </select>
        </div>
      ) : null}
      {audioEnabled ? (
        <div
          className="chordsketch-preview-toolbar__group tool-group chordsketch-preview-toolbar__group--audio"
          role="group"
          aria-label="Chord audio"
        >
          <span
            className="chordsketch-preview-toolbar__label label"
            aria-hidden="true"
          >
            Audio
          </span>
          <button
            type="button"
            className="chordsketch-preview-toolbar__audio-toggle btn btn-secondary btn-sm"
            aria-pressed={Boolean(chordAudioEnabled)}
            aria-label="Play chords on click"
            title={
              chordAudioEnabled
                ? 'Chord audio on — click to stop playing chords'
                : 'Chord audio off — click to play chords'
            }
            onClick={() => onChordAudioToggle!(!chordAudioEnabled)}
          >
            {chordAudioEnabled ? AUDIO_ON_ICON : AUDIO_OFF_ICON}
            <span>Chord audio</span>
            <span
              className="chordsketch-preview-toolbar__audio-state"
              aria-hidden="true"
            >
              {chordAudioEnabled ? 'On' : 'Off'}
            </span>
          </button>
        </div>
      ) : null}
      {showExport ? (
        <div
          className="chordsketch-preview-toolbar__group tool-group chordsketch-preview-toolbar__group--export"
          role="group"
          aria-label="Export"
        >
          <span
            className="chordsketch-preview-toolbar__label label"
            aria-hidden="true"
          >
            Export
          </span>
          <PdfExport
            source={source}
            options={{ transpose }}
            filename={exportFilename}
            wasmLoader={wasmLoader}
            className="chordsketch-preview-toolbar__export btn btn-secondary btn-sm"
          >
            {EXPORT_ICON}
            {PDF_EXPORT_DEFAULT_LABEL}
          </PdfExport>
        </div>
      ) : null}
      {trailing ? (
        <div
          className="chordsketch-preview-toolbar__group tool-group chordsketch-preview-toolbar__group--trailing"
          role="group"
          aria-label="Additional actions"
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
