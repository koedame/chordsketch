import { useEffect, useRef, useState } from 'react';

// Narrow WASM surface this hook touches. Kept structural so the
// React package does not drag the WASM glue into its type graph —
// the module is dynamically imported at runtime. Keep in sync with
// `tests/helpers/*` stubs that simulate this module.
interface DiagramRenderer {
  default: () => Promise<unknown>;
  /**
   * Returns the SVG for the given chord+instrument pair, or
   * `null` / `undefined` when the built-in voicing database has no
   * entry. Returning `null` (rather than throwing) lets hosts
   * render a "chord not found" fallback without try/catch.
   *
   * Throws a `JsError` when `instrument` is not one of the
   * supported values (`"guitar"`, `"ukulele"`, `"piano"` +
   * aliases).
   */
  chord_diagram_svg: (chord: string, instrument: string) => string | null | undefined;
  /**
   * Same as `chord_diagram_svg` but consults song-level
   * `{define}` directives first. `defines` is an array of
   * `[name, raw]` tuples (e.g.
   * `[["Gsus4", "base-fret 1 frets 3 3 0 0 1 3"]]`) extracted
   * from the AST. Mirrors `chordsketch_chordpro::voicings::lookup_diagram`'s
   * "song-level defines take priority" rule so user-defined
   * voicings render in `<ChordDiagram>` exactly like the Rust
   * HTML renderer's `<section class="chord-diagrams">` block.
   */
  chordDiagramSvgWithDefines?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
  ) => string | null | undefined;
}

/** Supported instrument families for chord diagram lookup. */
export type ChordDiagramInstrument =
  | 'guitar'
  | 'ukulele'
  | 'uke'
  | 'piano'
  | 'keyboard'
  | 'keys';

/** State exposed by {@link useChordDiagram}. */
export interface ChordDiagramResult {
  /**
   * Inline SVG string, or `null` when the voicing database has no
   * entry for this (chord, instrument) pair. Consumers typically
   * render a "chord not found" fallback when this is `null`.
   */
  svg: string | null;
  /** `true` while the WASM module loads or a lookup is in flight. */
  loading: boolean;
  /**
   * Set when the instrument is rejected by the underlying renderer
   * or when WASM init fails. Unknown chords are NOT errors —
   * they surface via `svg === null`.
   */
  error: Error | null;
}

/**
 * WASM loader injected by tests. Production callers take the
 * default, which lazy-loads `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordDiagramWasmLoader = () => Promise<DiagramRenderer>;

// Two-step cast through `unknown` — the wasm module's TS types,
// when resolved against the `chordsketch-wasm` JS bundle (which is
// what host bundlers see), do not formally include
// `chord_diagram_svg`'s typed signature even though the export is
// present at runtime. The `DiagramRenderer` shape models the
// runtime contract; consumers that pass their own loader are
// expected to satisfy it directly.
const defaultLoader: ChordDiagramWasmLoader = () =>
  import('@chordsketch/wasm') as unknown as Promise<DiagramRenderer>;

/**
 * Look up an SVG chord diagram for `(chord, instrument)` via
 * `@chordsketch/wasm`. The WASM module is loaded lazily and
 * cached per hook instance. Results are keyed against the
 * argument tuple so a re-render with the same inputs is a no-op.
 *
 * `defines` is an optional list of `[chordName, raw]` tuples
 * extracted from the song's `{define: …}` directives — pass them
 * in to make `<ChordDiagram>` honour user-defined voicings
 * the same way the Rust HTML renderer does. Omitting the
 * argument keeps the built-in-voicings-only behaviour.
 *
 * ```ts
 * const { svg, loading, error } = useChordDiagram('Am', 'guitar');
 * ```
 */
export function useChordDiagram(
  chord: string,
  instrument: ChordDiagramInstrument,
  loader: ChordDiagramWasmLoader = defaultLoader,
  defines?: ReadonlyArray<readonly [string, string]>,
): ChordDiagramResult {
  const [svg, setSvg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const rendererRef = useRef<DiagramRenderer | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // `defines` is the per-call list of user-defined voicings.
  // Serialise it to a stable key so the effect doesn't re-fire on
  // every render when callers pass a fresh array reference with
  // the same contents.
  const definesKey = defines ? JSON.stringify(defines) : '';

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        if (rendererRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          if (cancelled) return;
          rendererRef.current = mod;
        }
        const renderer = rendererRef.current;
        // Prefer the defines-aware export when the host wasm
        // bundle ships it. Older bundles (pre-#2466 follow-up)
        // only expose `chord_diagram_svg`, so fall back to that
        // path — user-defined voicings won't be honoured there,
        // but at least the built-in lookup still works.
        const result = renderer.chordDiagramSvgWithDefines
          ? renderer.chordDiagramSvgWithDefines(
              chord,
              instrument,
              defines ? defines.map(([n, r]) => [n, r]) : [],
            )
          : renderer.chord_diagram_svg(chord, instrument);
        if (cancelled) return;
        setSvg(result ?? null);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        // Clear previous SVG so a bad instrument does not keep
        // showing the previous chord's diagram — unlike
        // `<ChordSheet>`, diagrams are tiny / per-chord, and
        // keeping a stale image alongside an instrument-mismatch
        // error would be visually confusing.
        setSvg(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chord, instrument, definesKey]);

  return { svg, loading, error };
}
