import type { ChangeEvent, HTMLAttributes, ReactNode } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { PreviewToolbar } from './preview-toolbar';
import { RendererPreview, type PreviewFormat } from './renderer-preview';
import { Transpose } from './transpose';
import type { ChordDiagramInstrument } from './use-chord-diagram';
import type { ChordWasmLoader } from './use-chord-render';

// Minimal `process.env.NODE_ENV` typing so we do not pull in
// `@types/node` for a single dev-only reference. The exact
// `process.env.NODE_ENV` token is required — bundlers (esbuild,
// Rollup, Vite, webpack DefinePlugin) replace it at build time and
// a helper that accesses it via `globalThis.process` would not
// match the substitution pattern, so the production build would
// still carry the warning code path.
declare const process: { env: { NODE_ENV?: string } };

/** Props accepted by {@link ChordProPreview}. */
export interface ChordProPreviewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onChange'> {
  /** ChordPro source to render. */
  source: string;
  /**
   * Controlled preview format. Pair with `onFormatChange` to lift
   * the format state into the parent; pass only `defaultFormat`
   * to keep state inside the component.
   */
  format?: PreviewFormat;
  /**
   * Initial preview format for uncontrolled usage. Defaults to
   * `"html"`. Ignored when `format` is supplied.
   */
  defaultFormat?: PreviewFormat;
  /** Fires when the format select changes. */
  onFormatChange?: (next: PreviewFormat) => void;
  /**
   * Format options to include in the select. Defaults to
   * `['html', 'text', 'pdf']`. Use this to restrict the menu — for
   * example, host surfaces that do not ship the PDF wasm bundle
   * should drop `'pdf'` so the user does not pick an unavailable
   * format.
   */
  formats?: ReadonlyArray<PreviewFormat>;
  /**
   * Controlled transposition offset. Pair with `onTransposeChange`.
   */
  transpose?: number;
  /**
   * Initial transposition offset for uncontrolled usage. Defaults
   * to `0`. Ignored when `transpose` is supplied.
   */
  defaultTranspose?: number;
  /** Fires when the transpose control commits a new offset. */
  onTransposeChange?: (next: number) => void;
  /** Minimum transpose offset emitted by the control. Defaults to `-11`. */
  transposeMin?: number;
  /** Maximum transpose offset emitted by the control. Defaults to `11`. */
  transposeMax?: number;
  /** Filename used for the PDF download. */
  pdfFilename?: string;
  /** Optional content rendered while the wasm runtime is initialising. */
  loadingFallback?: ReactNode;
  /**
   * Optional render prop that takes over when a parse or render
   * error occurs. Receives the `Error` instance; return any
   * `ReactNode`. Pass `null` to suppress the error UI.
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Selects the header toolbar layout.
   *
   * - `"transpose-only"` (default) — preserves the pre-#2545
   *   behaviour: format `<select>` + `<Transpose>`.
   * - `"performance"` — adds a pane-level {@link PreviewToolbar}
   *   (Transpose + Capo + Export) below the header. Capo and
   *   Export require {@link ChordProPreviewProps.onSourceChange};
   *   without it the Capo group is silently dropped.
   * - `false` — no toolbar / no header at all (preview body only).
   * - A `ReactNode` — escape hatch that replaces the entire
   *   toolbar with caller-supplied JSX.
   */
  toolbar?: 'transpose-only' | 'performance' | false | ReactNode;
  /**
   * Required by `toolbar="performance"`'s Capo group — invoked
   * when the user steps the capo and the {@link PreviewToolbar}
   * rewrites the `{capo: N}` directive in `source`. Hosts that
   * pipe document edits through a separate channel (e.g. VS
   * Code's `WorkspaceEdit` over a message protocol) should
   * forward this through that channel.
   */
  onSourceChange?: (next: string) => void;
  /** Forwarded to {@link PreviewToolbar} when toolbar="performance". */
  pdfExportFilename?: string;
  /** Forwarded to the underlying {@link RendererPreview}. */
  chordDiagramsInstrument?: ChordDiagramInstrument;
  /**
   * Test-only WASM loader override for the inline (`html` / `text`)
   * formats. Production callers never need to supply this.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
}

const DEFAULT_FORMATS: ReadonlyArray<PreviewFormat> = ['html', 'text', 'pdf'];

const FORMAT_LABELS: Readonly<Record<PreviewFormat, string>> = {
  html: 'HTML',
  text: 'Text',
  pdf: 'PDF',
};

/**
 * Tier 2 preview-with-controls — header (format `<select>` +
 * `<Transpose>`) above a {@link RendererPreview} body.
 *
 * This is the right surface for hosts that bring their own
 * ChordPro source (e.g. VS Code's WebView preview, an embedded
 * docs viewer) but want the same in-pane controls the
 * playground exposes without composing them by hand. Pair with
 * {@link ChordProEditor} for the full editor + preview Tier 3
 * shell, or compose Tier 1 atoms (`<ChordSourceArea>` /
 * `<ChordTextarea>` / `<RendererPreview>` / `<Transpose>`)
 * directly for fully custom layouts.
 *
 * Both `format` and `transpose` support controlled and
 * uncontrolled state independently — supply a `value` + `onChange`
 * pair to lift state, or only `default*` to keep state inside
 * this component. Mixing the two for the same axis is a
 * configuration error and the controlled value wins.
 */
export function ChordProPreview({
  source,
  format: formatProp,
  defaultFormat = 'html',
  onFormatChange,
  formats = DEFAULT_FORMATS,
  transpose: transposeProp,
  defaultTranspose = 0,
  onTransposeChange,
  transposeMin = -11,
  transposeMax = 11,
  pdfFilename,
  loadingFallback,
  errorFallback,
  chordDiagramsInstrument,
  toolbar = 'transpose-only',
  onSourceChange,
  pdfExportFilename,
  wasmLoader,
  className,
  ...divProps
}: ChordProPreviewProps): JSX.Element {
  // Format — controlled vs uncontrolled.
  const [internalFormat, setInternalFormat] = useState<PreviewFormat>(defaultFormat);
  const isFormatControlled = formatProp !== undefined;
  const rawFormat = isFormatControlled ? formatProp : internalFormat;

  // Dev-only warning + safe fallback: if the active format is not
  // a member of `formats`, the `<select>`'s `value` attribute would
  // not match any `<option>`, and React itself emits a "no matching
  // option" warning while also visually selecting an arbitrary
  // entry. Fall back to the first allowed format so the visible UI
  // stays in sync with the value the consumer reads back.
  const formatIsAllowed = formats.includes(rawFormat);
  const fallbackFormat = formats[0] ?? 'html';
  const format: PreviewFormat = formatIsAllowed ? rawFormat : fallbackFormat;
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!formatIsAllowed) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: <ChordProPreview> received format="${rawFormat}" which is not in the allowed \`formats\` list [${formats.join(', ')}]. ` +
          `Falling back to "${fallbackFormat}". Pass a format from \`formats\` to silence this warning.`,
      );
    }
  }, [formatIsAllowed, rawFormat, formats, fallbackFormat]);

  const handleFormatChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.currentTarget.value as PreviewFormat;
      if (!isFormatControlled) setInternalFormat(next);
      onFormatChange?.(next);
    },
    [isFormatControlled, onFormatChange],
  );

  // Transpose — controlled vs uncontrolled.
  const [internalTranspose, setInternalTranspose] = useState<number>(defaultTranspose);
  const isTransposeControlled = transposeProp !== undefined;
  const rawTransposeValue = isTransposeControlled ? transposeProp : internalTranspose;
  const handleTransposeChange = useCallback(
    (next: number) => {
      if (!isTransposeControlled) setInternalTranspose(next);
      onTransposeChange?.(next);
    },
    [isTransposeControlled, onTransposeChange],
  );

  // Dev-only warning + defensive swap: callers occasionally pass an
  // inverted bound pair (`transposeMin > transposeMax`); normalise
  // to `[min(a,b), max(a,b)]` so the control stays well-defined.
  // Mirrors `<ChordTextarea>`'s identical guard.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (transposeMin > transposeMax) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: <ChordProPreview> received transposeMin (${transposeMin}) > transposeMax (${transposeMax}). ` +
          `The bounds will be swapped to keep the control usable, but the caller should pass min ≤ max.`,
      );
    }
  }, [transposeMin, transposeMax]);
  const effectiveTransposeMin = Math.min(transposeMin, transposeMax);
  const effectiveTransposeMax = Math.max(transposeMin, transposeMax);

  // L1: clamp the incoming transpose value into the effective
  // `[min, max]` window before forwarding to `<Transpose>` and
  // `<RendererPreview>`. Without this, a caller passing
  // `transpose=15, transposeMax=11` would render a chord sheet
  // transposed by 15 semitones while the `<Transpose>` readout
  // showed `+11`, and the next "−" click would emit `+10` — a
  // jump the consumer never asked for.
  const transposeValue = useMemo(() => {
    if (rawTransposeValue < effectiveTransposeMin) return effectiveTransposeMin;
    if (rawTransposeValue > effectiveTransposeMax) return effectiveTransposeMax;
    return rawTransposeValue;
  }, [rawTransposeValue, effectiveTransposeMin, effectiveTransposeMax]);

  // L4: dev-only controlled/uncontrolled flip warnings for both
  // axes — mirrors the `<ChordTextarea>` pattern. Captures the
  // initial control mode at mount and warns if the caller swaps
  // mid-lifetime. Production builds strip via dead-code elimination
  // on the literal `process.env.NODE_ENV` token.
  const wasFormatControlledRef = useRef(isFormatControlled);
  const wasTransposeControlledRef = useRef(isTransposeControlled);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (wasFormatControlledRef.current !== isFormatControlled) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: A component is changing an ${wasFormatControlledRef.current ? 'controlled' : 'uncontrolled'} <ChordProPreview> format to be ${isFormatControlled ? 'controlled' : 'uncontrolled'}. ` +
          `<ChordProPreview> should not switch between controlled and uncontrolled (or vice versa) during its lifetime. ` +
          `Decide between using a controlled or uncontrolled <ChordProPreview> format for the lifetime of the component.`,
      );
      wasFormatControlledRef.current = isFormatControlled;
    }
  }, [isFormatControlled]);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (wasTransposeControlledRef.current !== isTransposeControlled) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: A component is changing an ${wasTransposeControlledRef.current ? 'controlled' : 'uncontrolled'} <ChordProPreview> transpose to be ${isTransposeControlled ? 'controlled' : 'uncontrolled'}. ` +
          `<ChordProPreview> should not switch between controlled and uncontrolled (or vice versa) during its lifetime. ` +
          `Decide between using a controlled or uncontrolled <ChordProPreview> transpose for the lifetime of the component.`,
      );
      wasTransposeControlledRef.current = isTransposeControlled;
    }
  }, [isTransposeControlled]);

  const formatSelectId = useId();
  const wrapperClass = ['chordsketch-chord-pro-preview', className]
    .filter(Boolean)
    .join(' ');

  // Resolve the `toolbar` prop into the three render-time
  // decisions. The string literals are the supported keywords;
  // anything else that is not `false` is treated as caller-
  // supplied JSX that replaces the header.
  const isPerformanceToolbar = toolbar === 'performance';
  const isHidden = toolbar === false;
  const isStandardHeader =
    toolbar === 'transpose-only' || toolbar === 'performance';
  const customHeader = !isStandardHeader && !isHidden ? toolbar : null;

  // In `performance` mode the format `<select>` is hidden when
  // only one format is allowed — a single-option select is dead
  // UI, and hosts like the VS Code WebView pin to `['html']`.
  // In the default `transpose-only` mode the select always
  // renders to preserve the pre-#2545 behaviour.
  const showFormatSelect = isPerformanceToolbar ? formats.length > 1 : true;
  // The header-level Transpose moves into <PreviewToolbar> when
  // the performance toolbar is active.
  const showHeaderTranspose = !isPerformanceToolbar;
  const showStandardHeader =
    isStandardHeader && !isHidden && (showFormatSelect || showHeaderTranspose);

  return (
    <div {...divProps} className={wrapperClass}>
      {customHeader}
      {showStandardHeader ? (
        <header className="chordsketch-chord-pro-preview__header">
          <div className="chordsketch-chord-pro-preview__controls">
            {showFormatSelect ? (
              <label
                htmlFor={formatSelectId}
                className="chordsketch-chord-pro-preview__control-label"
              >
                Format
                <select
                  id={formatSelectId}
                  className="chordsketch-chord-pro-preview__select"
                  value={format}
                  onChange={handleFormatChange}
                >
                  {formats.map((value) => (
                    <option key={value} value={value}>
                      {FORMAT_LABELS[value] ?? value}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {showHeaderTranspose ? (
              <Transpose
                className="chordsketch-chord-pro-preview__transpose"
                value={transposeValue}
                onChange={handleTransposeChange}
                min={effectiveTransposeMin}
                max={effectiveTransposeMax}
                label="Transpose"
              />
            ) : null}
          </div>
        </header>
      ) : null}
      {isPerformanceToolbar ? (
        <PreviewToolbar
          source={source}
          onSourceChange={onSourceChange}
          transpose={transposeValue}
          onTransposeChange={handleTransposeChange}
          transposeMin={effectiveTransposeMin}
          transposeMax={effectiveTransposeMax}
          exportFilename={pdfExportFilename}
        />
      ) : null}
      <div className="chordsketch-chord-pro-preview__body">
        <RendererPreview
          className="chordsketch-chord-pro-preview__renderer"
          source={source}
          transpose={transposeValue}
          format={format}
          pdfFilename={pdfFilename}
          loadingFallback={loadingFallback}
          errorFallback={errorFallback}
          chordDiagramsInstrument={chordDiagramsInstrument}
          wasmLoader={wasmLoader}
        />
      </div>
    </div>
  );
}
