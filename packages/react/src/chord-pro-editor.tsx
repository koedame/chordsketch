import type { HTMLAttributes, ReactNode } from 'react';
import { useCallback, useState } from 'react';

import { ChordProPreview } from './chord-pro-preview';
import { ChordSourceArea } from './chord-source-area';
import type { PreviewFormat } from './renderer-preview';
import { SplitLayout } from './split-layout';
import type { ChordWasmLoader } from './use-chord-render';

/** Props accepted by {@link ChordProEditor}. */
export interface ChordProEditorProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'title'> {
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
   * change the format via the preview header `<select>`; the change
   * does not bubble unless `onFormatChange` is supplied (uncontrolled
   * mode keeps state internally).
   */
  defaultFormat?: PreviewFormat;
  /** Controlled preview format. */
  format?: PreviewFormat;
  /** Fires when the preview format changes. */
  onFormatChange?: (next: PreviewFormat) => void;
  /**
   * Initial transposition offset. Defaults to `0`.
   */
  defaultTranspose?: number;
  /** Controlled transposition offset. */
  transpose?: number;
  /** Fires when the transposition control commits a new offset. */
  onTransposeChange?: (next: number) => void;
  /** Heading text shown in the header bar. Defaults to `"ChordSketch"`. */
  title?: ReactNode;
  /** Filename used for the PDF download. Defaults to `"chordsketch-output.pdf"`. */
  pdfFilename?: string;
  /**
   * Optional render prop appended to the right of the header — useful
   * for hosts that want to add their own controls (e.g. an
   * input-format toggle, a save button) without fully replacing the
   * layout.
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

/**
 * Tier 3 composed editor — opinionated all-in-one ChordPro editor +
 * preview shell. Composes {@link ChordSourceArea} (CodeMirror)
 * on the left and {@link ChordProPreview} (format select +
 * transpose + renderer) on the right, separated by a
 * {@link SplitLayout}.
 *
 * Each piece is independently exported, so hosts that want a
 * different arrangement (vertical stack, no header, custom format
 * toggle) can compose the primitives directly. {@link
 * ChordProEditor} is the convenience component for the common case.
 *
 * Source / format / transpose all support both controlled and
 * uncontrolled modes. Pass the corresponding `value` + `onChange`
 * pair to lift state into the parent; pass only `default*` to keep
 * state inside the component.
 *
 * ```tsx
 * <ChordProEditor defaultSource="{title: Hello}" />
 * ```
 */
export function ChordProEditor({
  defaultSource = '',
  source: sourceProp,
  onSourceChange,
  defaultFormat = 'html',
  format: formatProp,
  onFormatChange,
  defaultTranspose = 0,
  transpose: transposeProp,
  onTransposeChange,
  title = 'ChordSketch',
  pdfFilename,
  headerExtras,
  wasmLoader,
  className,
  ...divProps
}: ChordProEditorProps): JSX.Element {
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

  const wrapperClass = ['chordsketch-chord-pro-editor', className]
    .filter(Boolean)
    .join(' ');

  const hasTitle =
    title !== null && title !== undefined && title !== false && title !== '';
  const hasHeader = hasTitle || headerExtras !== undefined;

  return (
    <div {...divProps} className={wrapperClass}>
      {hasHeader ? (
        <header className="chordsketch-chord-pro-editor__header">
          {hasTitle ? (
            <h1 className="chordsketch-chord-pro-editor__title">
              <span
                className="chordsketch-chord-pro-editor__brand-mark"
                aria-hidden="true"
              />
              <span className="chordsketch-chord-pro-editor__brand-text">{title}</span>
            </h1>
          ) : null}
          {headerExtras !== undefined ? (
            <div className="chordsketch-chord-pro-editor__controls">{headerExtras}</div>
          ) : null}
        </header>
      ) : null}

      <SplitLayout
        className="chordsketch-chord-pro-editor__split"
        start={
          <ChordSourceArea
            value={source}
            onChange={handleSourceChange}
            placeholder="Paste your ChordPro here…"
          />
        }
        end={
          <ChordProPreview
            className="chordsketch-chord-pro-editor__preview-pane"
            source={source}
            format={formatProp}
            defaultFormat={defaultFormat}
            onFormatChange={onFormatChange}
            transpose={transposeProp}
            defaultTranspose={defaultTranspose}
            onTransposeChange={onTransposeChange}
            pdfFilename={pdfFilename}
            wasmLoader={wasmLoader}
          />
        }
      />
    </div>
  );
}
