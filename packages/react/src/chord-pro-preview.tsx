import type { ChangeEvent, HTMLAttributes, ReactNode } from 'react';
import { useCallback, useId, useState } from 'react';

import { RendererPreview, type PreviewFormat } from './renderer-preview';
import { Transpose } from './transpose';
import type { ChordDiagramInstrument } from './use-chord-diagram';
import type { ChordWasmLoader } from './use-chord-render';

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
  wasmLoader,
  className,
  ...divProps
}: ChordProPreviewProps): JSX.Element {
  // Format — controlled vs uncontrolled.
  const [internalFormat, setInternalFormat] = useState<PreviewFormat>(defaultFormat);
  const isFormatControlled = formatProp !== undefined;
  const format = isFormatControlled ? formatProp : internalFormat;
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
  const transposeValue = isTransposeControlled ? transposeProp : internalTranspose;
  const handleTransposeChange = useCallback(
    (next: number) => {
      if (!isTransposeControlled) setInternalTranspose(next);
      onTransposeChange?.(next);
    },
    [isTransposeControlled, onTransposeChange],
  );

  const formatSelectId = useId();
  const wrapperClass = ['chordsketch-chord-pro-preview', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div {...divProps} className={wrapperClass}>
      <header className="chordsketch-chord-pro-preview__header">
        <div className="chordsketch-chord-pro-preview__controls">
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
          <Transpose
            className="chordsketch-chord-pro-preview__transpose"
            value={transposeValue}
            onChange={handleTransposeChange}
            min={transposeMin}
            max={transposeMax}
            label="Transpose"
          />
        </div>
      </header>
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
