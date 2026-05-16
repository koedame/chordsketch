import type { HTMLAttributes, ReactNode } from 'react';
import { useCallback, useId, useState } from 'react';

import { RendererPreview, type PreviewFormat } from './renderer-preview';
import { SourceEditor } from './source-editor';
import { SplitLayout } from './split-layout';
import { Transpose } from './transpose';
import type { ChordWasmLoader } from './use-chord-render';
import { useTranspose } from './use-transpose';

/** Props accepted by {@link Playground}. */
export interface PlaygroundProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'title'> {
  /**
   * Initial ChordPro source to seed the editor with. Ignored when
   * `source` is supplied (controlled mode). Defaults to an empty
   * document so the editor mounts cleanly when the host wants to
   * supply content asynchronously.
   */
  defaultSource?: string;
  /**
   * Controlled source value. When set, the host owns the source of
   * truth; pair with `onSourceChange` to capture edits.
   */
  source?: string;
  /** Fires synchronously on every editor edit. */
  onSourceChange?: (next: string) => void;
  /**
   * Initial preview format. Defaults to `"html"`. The user can
   * change the format via the header `<select>`; the change does
   * not bubble unless `onFormatChange` is supplied (uncontrolled
   * mode keeps state internally).
   */
  defaultFormat?: PreviewFormat;
  /** Controlled preview format. */
  format?: PreviewFormat;
  /** Fires when the preview format changes. */
  onFormatChange?: (next: PreviewFormat) => void;
  /**
   * Initial transposition offset. Defaults to `0`. The component
   * delegates state to {@link useTranspose} when uncontrolled.
   */
  defaultTranspose?: number;
  /** Controlled transposition offset. */
  transpose?: number;
  /** Fires when the transposition control commits a new offset. */
  onTransposeChange?: (next: number) => void;
  /** Heading text shown in the header bar. Defaults to `"ChordSketch Playground"`. */
  title?: ReactNode;
  /** Filename used for the PDF download. Defaults to `"chordsketch-output.pdf"`. */
  pdfFilename?: string;
  /**
   * Optional render prop appended to the right of the header
   * controls — useful for hosts that want to add their own
   * controls (e.g. an input-format toggle, a save button) without
   * fully replacing the layout.
   */
  headerExtras?: ReactNode;
  /**
   * Test-only WASM loader override. Production callers never need
   * to supply this.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
}

const FORMAT_OPTIONS: ReadonlyArray<{ value: PreviewFormat; label: string }> = [
  { value: 'html', label: 'HTML' },
  { value: 'text', label: 'Text' },
  { value: 'pdf', label: 'PDF' },
];

/**
 * Opinionated all-in-one ChordPro playground. Composes
 * {@link SourceEditor}, {@link RendererPreview}, {@link Transpose},
 * and {@link SplitLayout} into a header-plus-split layout that
 * matches the design-system reference at
 * `design-system/ui_kits/web/editor.html`.
 *
 * Each piece is independently exported, so hosts that want a
 * different arrangement (vertical stack, no header, custom format
 * toggle) can compose the primitives directly. {@link Playground}
 * is the convenience component for the common case.
 *
 * Source / format / transpose all support both controlled and
 * uncontrolled modes. Pass the corresponding `value` + `onChange`
 * pair to lift state into the parent; pass only `default*` to keep
 * state inside the component.
 *
 * ```tsx
 * <Playground defaultSource="{title: Hello}" />
 * ```
 */
export function Playground({
  defaultSource = '',
  source: sourceProp,
  onSourceChange,
  defaultFormat = 'html',
  format: formatProp,
  onFormatChange,
  defaultTranspose = 0,
  transpose: transposeProp,
  onTransposeChange,
  title = 'ChordSketch Playground',
  pdfFilename,
  headerExtras,
  wasmLoader,
  className,
  ...divProps
}: PlaygroundProps): JSX.Element {
  // Source — controlled vs uncontrolled.
  const [internalSource, setInternalSource] = useState(defaultSource);
  const isSourceControlled = sourceProp !== undefined;
  const source = isSourceControlled ? sourceProp : internalSource;
  const handleSourceChange = useCallback(
    (next: string) => {
      if (!isSourceControlled) setInternalSource(next);
      onSourceChange?.(next);
    },
    [isSourceControlled, onSourceChange],
  );

  // Format — controlled vs uncontrolled.
  const [internalFormat, setInternalFormat] = useState<PreviewFormat>(defaultFormat);
  const isFormatControlled = formatProp !== undefined;
  const format = isFormatControlled ? formatProp : internalFormat;
  const handleFormatChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = event.currentTarget.value as PreviewFormat;
      if (!isFormatControlled) setInternalFormat(next);
      onFormatChange?.(next);
    },
    [isFormatControlled, onFormatChange],
  );

  // Transpose — controlled vs uncontrolled. `useTranspose` carries
  // the clamping + reset semantics, so we use it for both modes
  // and let the controlled-mode handler short-circuit the
  // internal update.
  const transposeHook = useTranspose({ initial: defaultTranspose });
  const isTransposeControlled = transposeProp !== undefined;
  const transposeValue = isTransposeControlled ? transposeProp : transposeHook.value;
  const handleTransposeChange = useCallback(
    (next: number) => {
      if (!isTransposeControlled) transposeHook.setValue(next);
      onTransposeChange?.(next);
    },
    [isTransposeControlled, onTransposeChange, transposeHook],
  );

  const formatSelectId = useId();
  const wrapperClass = ['chordsketch-playground', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div {...divProps} className={wrapperClass}>
      <header className="chordsketch-playground__header">
        <h1 className="chordsketch-playground__title">
          <span className="chordsketch-playground__brand-mark" aria-hidden="true" />
          <span className="chordsketch-playground__brand-text">{title}</span>
        </h1>
        <div className="chordsketch-playground__controls">
          <label
            htmlFor={formatSelectId}
            className="chordsketch-playground__control-label"
          >
            Format
            <select
              id={formatSelectId}
              className="chordsketch-playground__select"
              value={format}
              onChange={handleFormatChange}
            >
              {FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Transpose
            className="chordsketch-playground__transpose"
            value={transposeValue}
            onChange={handleTransposeChange}
            label="Transpose"
          />
          {headerExtras}
        </div>
      </header>

      <SplitLayout
        className="chordsketch-playground__split"
        start={
          <SourceEditor
            value={source}
            onChange={handleSourceChange}
            placeholder="Paste your ChordPro here…"
          />
        }
        end={
          <RendererPreview
            className="chordsketch-playground__preview-pane"
            source={source}
            transpose={transposeValue}
            format={format}
            pdfFilename={pdfFilename}
            wasmLoader={wasmLoader}
          />
        }
      />
    </div>
  );
}
