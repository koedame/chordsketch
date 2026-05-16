import type { HTMLAttributes, ReactNode } from 'react';

import {
  type ChordDiagramInstrument,
  type ChordDiagramWasmLoader,
  useChordDiagram,
} from './use-chord-diagram';

/** Props accepted by {@link ChordDiagram}. */
export interface ChordDiagramProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Chord name (e.g. `"Am"`, `"C#m7"`, `"Bb"`). */
  chord: string;
  /** Instrument family. Defaults to `"guitar"`. */
  instrument?: ChordDiagramInstrument;
  /**
   * Optional list of song-level `{define: <name> <raw>}` voicings
   * to consult before falling back to the built-in voicing
   * database. Each entry is a `[chord_name, raw]` tuple — the raw
   * string carries the directive body (e.g. `"base-fret 1 frets
   * 3 3 0 0 1 3"`). Mirrors `chordsketch_chordpro::voicings::lookup_diagram`'s
   * "song-level defines take priority" rule so user-defined
   * chords show up here exactly like the Rust HTML renderer's
   * `<section class="chord-diagrams">` block.
   */
  defines?: ReadonlyArray<readonly [string, string]>;
  /**
   * Optional node shown while the WASM module loads. Defaults to
   * a minimal `role="status"` placeholder.
   */
  loadingFallback?: ReactNode;
  /**
   * Rendered when the voicing database has no entry for the given
   * chord+instrument pair. Defaults to an inline `role="note"`
   * "Chord not found" message so the chord name remains visible
   * to a reader skimming the page.
   */
  notFoundFallback?: ((chord: string, instrument: ChordDiagramInstrument) => ReactNode) | ReactNode;
  /**
   * Rendered when the underlying call errors (unknown instrument,
   * WASM init failure). Defaults to an inline `role="alert"`
   * showing the error message. Pass `null` to hide and surface
   * errors via your own channel (e.g. a toast).
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override. Production callers never
   * supply this — the default lazy-loads `@chordsketch/wasm`.
   *
   * @internal
   */
  wasmLoader?: ChordDiagramWasmLoader;
}

function defaultNotFoundFallback(
  chord: string,
  instrument: ChordDiagramInstrument,
): ReactNode {
  return (
    <div role="note" className="chordsketch-diagram__notfound">
      <strong>{chord}</strong>
      <span> — no {instrument} voicing in the built-in database</span>
    </div>
  );
}

function defaultErrorFallback(error: Error): ReactNode {
  return (
    <div role="alert" className="chordsketch-diagram__error">
      {error.message}
    </div>
  );
}

function defaultLoadingFallback(): ReactNode {
  return (
    <div role="status" aria-live="polite" className="chordsketch-diagram__loading">
      Loading diagram…
    </div>
  );
}

/**
 * Render a chord diagram (guitar / ukulele / piano) as inline SVG
 * via `@chordsketch/wasm`. The SVG comes from the trusted
 * `chordsketch_chordpro::chord_diagram` Rust module — the same
 * generator `<ChordSheet>`'s HTML output uses — so injection via
 * `dangerouslySetInnerHTML` is safe.
 *
 * ```tsx
 * <ChordDiagram chord="Am" instrument="guitar" />
 * ```
 *
 * When the chord is not known to the built-in voicing database
 * the component renders `notFoundFallback` instead of the SVG
 * (defaults to an inline "chord not found" note). When the
 * underlying call errors (unknown instrument, WASM init failure),
 * `errorFallback` is rendered.
 */
export function ChordDiagram({
  chord,
  instrument = 'guitar',
  defines,
  loadingFallback,
  notFoundFallback = defaultNotFoundFallback,
  errorFallback = defaultErrorFallback,
  wasmLoader,
  className,
  ...divProps
}: ChordDiagramProps): JSX.Element {
  const { svg, loading, error } = useChordDiagram(chord, instrument, wasmLoader, defines);

  const wrapperClass = ['chordsketch-diagram', className].filter(Boolean).join(' ');

  if (error !== null && errorFallback !== null) {
    const node =
      typeof errorFallback === 'function' ? errorFallback(error) : errorFallback;
    return (
      <div {...divProps} className={wrapperClass}>
        {node}
      </div>
    );
  }

  if (svg === null) {
    if (loading) {
      const node = loadingFallback ?? defaultLoadingFallback();
      return (
        <div {...divProps} className={wrapperClass} aria-busy="true">
          {node}
        </div>
      );
    }
    // Not loading and no SVG — the voicing database has no entry.
    const node =
      typeof notFoundFallback === 'function'
        ? notFoundFallback(chord, instrument)
        : notFoundFallback;
    return (
      <div {...divProps} className={wrapperClass}>
        {node}
      </div>
    );
  }

  return (
    <div
      {...divProps}
      className={wrapperClass}
      // Expose the diagram as a labelled image to assistive tech
      // (without this, the inline SVG's accessible name is the
      // empty string and the chord identity is invisible to
      // screen readers).
      role="img"
      aria-label={`${chord} chord diagram (${instrument})`}
      // The SVG is produced by our own Rust renderer
      // (`chord_diagram::render_svg` / `render_keyboard_svg`),
      // which emits a fixed, hand-written template — nothing in
      // the output is derived from user-controlled attributes.
      // Injection via `dangerouslySetInnerHTML` is safe here.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
