import type { HTMLAttributes, ReactNode } from 'react';

import { ChordSheet } from './chord-sheet';
import type { ChordAudioConfig, ChordSelection } from './chordpro-jsx';
import type { ChordAudioWasmLoader } from './use-chord-audio';
import { PdfExport } from './pdf-export';
import type {
  ChordDeleteTarget,
  ChordEditEvent,
  ChordRepositionEvent,
} from './chord-source-edit';
import type {
  ChordDiagramInstrument,
  ChordDiagramOrientation,
} from './use-chord-diagram';
import { type ChordRenderFormat, type ChordWasmLoader } from './use-chord-render';

/** Preview format selectable in {@link RendererPreview}. */
export type PreviewFormat = ChordRenderFormat | 'pdf';

/** Props accepted by {@link RendererPreview}. */
export interface RendererPreviewProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** ChordPro source to render. */
  source: string;
  /** Semitone transposition offset forwarded to the renderer. */
  transpose?: number;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or an
   * inline RRJSON configuration string.
   */
  config?: string;
  /**
   * Output format. `"html"` renders the song as design-system styled
   * HTML; `"text"` renders the chords-above-lyrics text format;
   * `"pdf"` shows an export button that produces a PDF on demand.
   */
  format: PreviewFormat;
  /** Filename used for the PDF download. Defaults to `"chordsketch-output.pdf"`. */
  pdfFilename?: string;
  /**
   * Opt-in: render the auto-injected chord-diagrams grid at the end
   * of the song for the given instrument. The grid is then gated by
   * the song's `{diagrams: on/off}` / `{no_diagrams}` directives.
   * Omit (the default) to suppress the grid regardless of the
   * directive — the React surface intentionally keeps this
   * consumer-driven rather than auto-emitting like the Rust HTML
   * renderer does.
   */
  chordDiagramsInstrument?: ChordDiagramInstrument;
  /**
   * Orientation forwarded to {@link ChordSheet}, which threads it
   * through to every emitted `<ChordDiagram>`. Defaults to
   * `"vertical"`; pass `"horizontal"` for the Japanese-tablature
   * layout (reader-view, high pitch on top — see ADR-0026). Has no
   * effect when `chordDiagramsInstrument` is omitted or when
   * `format !== "html"`.
   */
  chordDiagramsOrientation?: ChordDiagramOrientation;
  /**
   * 1-indexed source line that should be highlighted in the
   * rendered preview. Forwarded to {@link ChordSheet}'s
   * `activeSourceLine` prop. Pair with `<ChordSourceArea>`'s
   * `onCaretLineChange` callback for editor↔preview caret sync.
   * Only consumed by `format="html"`.
   */
  activeSourceLine?: number;
  /** See {@link ChordSheetProps.caretColumn}. */
  caretColumn?: number;
  /** See {@link ChordSheetProps.caretLineLength}. */
  caretLineLength?: number;
  /**
   * Optional drag-and-drop chord reposition callback. Forwarded
   * to {@link ChordSheet}; see `ChordSheetProps.onChordReposition`
   * for semantics. Only consumed by `format="html"`.
   */
  onChordReposition?: (event: ChordRepositionEvent) => void;
  /**
   * Optional in-place chord-edit callback (#2622). Forwarded to
   * {@link ChordSheet}; see `ChordSheetProps.onChordEdit`. Enables the
   * left-docked chord-editor inspector. Only consumed by `format="html"`.
   */
  onChordEdit?: (event: ChordEditEvent) => void;
  /**
   * Optional chord-delete callback (#2622). Forwarded to
   * {@link ChordSheet}; see `ChordSheetProps.onChordDelete`.
   */
  onChordDelete?: (target: ChordDeleteTarget) => void;
  /**
   * Controlled chord-selection (#2644). Forwarded to {@link ChordSheet};
   * see `ChordSheetProps.chordSelection` / `onChordSelectionChange`.
   * Supply `onChordSelectionChange` to put the sheet in
   * controlled-selection mode (shell owns the selection + renders a
   * lifted footer). Only consumed by `format="html"`.
   */
  chordSelection?: ChordSelection | null;
  /** Setter paired with {@link chordSelection}; see its docs. */
  onChordSelectionChange?: (selection: ChordSelection | null) => void;
  /**
   * Enable chord-audio playback (#2650). Forwarded to {@link ChordSheet};
   * see `ChordSheetProps.chordAudio`. Pass `true` to let the sheet own
   * the audio instance, or an injected {@link ChordAudioConfig} (e.g.
   * `useChordEditor`'s `chordAudio` field) to share one instance with a
   * panel-edit playback path. Audio is additive — chords stay selectable
   * / editable while it is on. Only consumed by `format="html"`; degrades
   * to inert chords without Web Audio support.
   */
  chordAudio?: boolean | ChordAudioConfig | null;
  /**
   * Test-only WASM loader override for the chord-audio hook. Forwarded
   * to {@link ChordSheet}; production callers never supply this.
   *
   * @internal
   */
  chordAudioLoader?: ChordAudioWasmLoader;
  /**
   * Optional content rendered while the wasm runtime is initialising.
   *
   * Only honoured by the inline `html` / `text` branches — the
   * `pdf` branch is an export button (rendered by
   * {@link PdfExport}), not a streaming surface, so it has no
   * "loading" state to show before the user clicks. PDF in-flight
   * state is communicated via the button's `aria-busy` attribute
   * instead.
   */
  loadingFallback?: ReactNode;
  /**
   * Optional render prop that takes over when a parse or render
   * error occurs. Receives the `Error` instance; return any
   * `ReactNode`. Defaults to a minimal `role="alert"` div showing
   * the error message.
   *
   * Honoured by every branch: the `html` / `text` branches forward
   * to {@link ChordSheet}, and the `pdf` branch wraps
   * {@link PdfExport}'s default inline error rendering.
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override for the inline (`html` / `text`)
   * formats. The PDF branch uses its own default loader via
   * {@link PdfExport}; production callers never need to supply
   * this.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
}

/**
 * Format-aware preview surface. Both `html` and `text` delegate
 * to {@link ChordSheet}, which renders the AST directly via the
 * chordpro-jsx walker (`html`) or via a `<pre>` block (`text`)
 * — see ADR-0017 for the architectural split between the React
 * surface (AST → JSX) and the Rust surface (`chordsketch-render-html`,
 * which still backs the CLI / FFI / GitHub Action). PDF stays a
 * download action via {@link PdfExport} because PDF generation is
 * binary and remains owned by `chordsketch-render-pdf`.
 *
 * The previous iframe-sandbox HTML branch was retired in #2475 —
 * with React owning the DOM, body-style isolation is provided by
 * the consumer's stylesheet rather than by an embedded
 * `<iframe srcdoc>`.
 *
 * ```tsx
 * <RendererPreview source={chordpro} format={format} transpose={offset} />
 * ```
 */
export function RendererPreview({
  source,
  transpose,
  config,
  format,
  pdfFilename = 'chordsketch-output.pdf',
  chordDiagramsInstrument,
  chordDiagramsOrientation,
  activeSourceLine,
  caretColumn,
  caretLineLength,
  onChordReposition,
  onChordEdit,
  onChordDelete,
  chordSelection,
  onChordSelectionChange,
  chordAudio,
  chordAudioLoader,
  loadingFallback,
  errorFallback,
  wasmLoader,
  className,
  ...divProps
}: RendererPreviewProps): JSX.Element {
  const wrapperClass = ['chordsketch-preview', className].filter(Boolean).join(' ');

  if (format === 'pdf') {
    return (
      <div {...divProps} className={`${wrapperClass} chordsketch-preview--pdf`}>
        <p className="chordsketch-preview__hint">
          Click the button to generate and download a PDF.
        </p>
        <PdfExport
          source={source}
          options={{ transpose, config }}
          filename={pdfFilename}
          className="chordsketch-pdf-export"
        />
      </div>
    );
  }

  return (
    <ChordSheet
      {...divProps}
      className={`${wrapperClass} chordsketch-preview--${format}`}
      source={source}
      format={format}
      transpose={transpose}
      config={config}
      chordDiagramsInstrument={chordDiagramsInstrument}
      chordDiagramsOrientation={chordDiagramsOrientation}
      activeSourceLine={activeSourceLine}
      caretColumn={caretColumn}
      caretLineLength={caretLineLength}
      onChordReposition={onChordReposition}
      onChordEdit={onChordEdit}
      onChordDelete={onChordDelete}
      chordSelection={chordSelection}
      onChordSelectionChange={onChordSelectionChange}
      chordAudio={chordAudio}
      chordAudioLoader={chordAudioLoader}
      loadingFallback={loadingFallback}
      errorFallback={errorFallback}
      wasmLoader={wasmLoader}
    />
  );
}
