import type { HTMLAttributes, ReactNode } from 'react';

import { Capo } from './capo';
import { PdfExport } from './pdf-export';
import { Transpose } from './transpose';
import {
  CAPO_MAX,
  CAPO_MIN,
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
} from './chord-source-edit';

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
  /** Minimum transpose offset. Defaults to {@link TRANSPOSE_MIN} (`-11`). */
  transposeMin?: number;
  /** Maximum transpose offset. Defaults to {@link TRANSPOSE_MAX} (`11`). */
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
  /** Filename for the PDF download. Defaults to `chordsketch-output.pdf`. */
  exportFilename?: string;
  /**
   * Optional extra content rendered as a fourth group at the end
   * of the toolbar. Useful for host-specific actions (e.g. a
   * "Send to host" button in a VS Code preview).
   */
  trailing?: ReactNode;
}

const DOWNLOAD_ICON = (
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
  transposeMin = TRANSPOSE_MIN,
  transposeMax = TRANSPOSE_MAX,
  capoMin = CAPO_MIN,
  capoMax = CAPO_MAX,
  showTranspose = true,
  showCapo,
  showExport = true,
  exportFilename = 'chordsketch-output.pdf',
  trailing,
  className,
  ...divProps
}: PreviewToolbarProps): JSX.Element {
  const capoEnabled = (showCapo ?? onSourceChange !== undefined) && onSourceChange !== undefined;
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
        />
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
            className="chordsketch-preview-toolbar__export btn btn-secondary btn-sm"
          >
            {DOWNLOAD_ICON}
            Download PDF
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
