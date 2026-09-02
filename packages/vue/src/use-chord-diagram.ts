import {
  ref,
  toValue,
  watchEffect,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';

import { defaultWasmLoader, loadWasm } from './wasm-loader';

// Narrow WASM surface this composable touches. Kept structural so
// the Vue package does not drag the WASM glue into its type graph —
// the module is dynamically imported at runtime.
interface DiagramRenderer {
  /**
   * Browser-build init function. Optional because the Node build
   * has none — see `wasm-loader.ts`, which owns the call.
   */
  default?: unknown;
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
   * `[["Gsus4", "base-fret 1 frets 3 3 0 0 1 3"]]`).
   */
  chordDiagramSvgWithDefines?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
  ) => string | null | undefined;
  /**
   * Variant honouring the horizontal-orientation knob. Absent on
   * bundles that predate it, so callers feature-detect and fall
   * back to the vertical layout.
   */
  chordDiagramSvgWithDefinesOrientation?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
    orientation: ChordDiagramOrientation | null | undefined,
  ) => string | null | undefined;
  /**
   * Compact above-a-lyric variant. Same arguments as
   * `chordDiagramSvgWithDefinesOrientation` but returns the smaller
   * layout. Also absent on older bundles.
   */
  chordDiagramSvgWithDefinesOrientationCompact?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
    orientation: ChordDiagramOrientation | null | undefined,
  ) => string | null | undefined;
}

/** Diagram orientation accepted by {@link useChordDiagram}. */
export type ChordDiagramOrientation = 'vertical' | 'horizontal';

/**
 * Mirror of the Rust-side `MAX_RESOLVER_INPUT_LEN` (64 bytes) — see
 * `crates/chordpro/src/chord_diagram.rs`. The wasm boundary applies
 * the same cap inside `resolve_orientation`, so this JS-side check
 * is defense-in-depth: it clears wildly oversized strings before
 * they cross the wasm ABI. The `ChordDiagramOrientation` type
 * already constrains TS callers to the two short literals; this
 * guard catches hostile direct callers that cast around the type.
 */
const MAX_ORIENTATION_INPUT_LEN = 64;

/** Supported instrument families for chord diagram lookup. */
export type ChordDiagramInstrument =
  | 'guitar'
  | 'ukulele'
  | 'uke'
  | 'piano'
  | 'keyboard'
  | 'keys';

/** Options accepted by {@link useChordDiagram}. */
export interface UseChordDiagramOptions {
  /** Instrument family. Defaults to `"guitar"`. */
  instrument?: ChordDiagramInstrument;
  /**
   * Song-level `{define: <name> <raw>}` voicings consulted before
   * the built-in voicing database, as `[chord_name, raw]` tuples.
   */
  defines?: ReadonlyArray<readonly [string, string]>;
  /** Diagram orientation. Defaults to the renderer's vertical layout. */
  orientation?: ChordDiagramOrientation;
  /** Render the compact above-a-lyric layout. Defaults to `false`. */
  compact?: boolean;
}

/** State exposed by {@link useChordDiagram}. */
export interface ChordDiagramResult {
  /**
   * Inline SVG string, or `null` when the voicing database has no
   * entry for this (chord, instrument) pair. Consumers typically
   * render a "chord not found" fallback when this is `null`.
   */
  svg: Ref<string | null>;
  /** `true` while the WASM module loads or a lookup is in flight. */
  loading: Ref<boolean>;
  /**
   * Set when the instrument is rejected by the underlying renderer
   * or when WASM init fails. Unknown chords are NOT errors — they
   * surface via `svg.value === null`.
   */
  error: Ref<Error | null>;
}

/**
 * WASM loader injected by tests. Production callers take the
 * default, which lazy-loads `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordDiagramWasmLoader = () => Promise<DiagramRenderer>;

// Module-level latch for the stale-bundle warnings. Each
// `<ChordDiagram>` instance creates its own composable, so a
// per-instance latch would let a chord grid mounting N components
// emit N copies of the same message. Hoisting it out makes the
// "warn at most once per page load" contract hold across the whole
// component tree. Exported for tests to reset between cases.
const staleBundleWarnings = new Set<string>();

/** @internal Test-only — reset the stale-bundle warning latch. */
export function __resetStaleBundleWarnings(): void {
  staleBundleWarnings.clear();
}

function warnOnce(key: string, message: string): void {
  if (staleBundleWarnings.has(key)) return;
  staleBundleWarnings.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * Look up an SVG chord diagram for `(chord, instrument)` via
 * `@chordsketch/wasm`. The WASM module is loaded lazily and cached
 * per composable instance; the lookup re-runs whenever one of the
 * reactive inputs changes.
 *
 * ```ts
 * const { svg, loading, error } = useChordDiagram('Am', { instrument: 'guitar' });
 * ```
 */
export function useChordDiagram(
  chord: MaybeRefOrGetter<string>,
  options: MaybeRefOrGetter<UseChordDiagramOptions> = {},
  loader: ChordDiagramWasmLoader = defaultWasmLoader,
): ChordDiagramResult {
  const svg = ref<string | null>(null);
  const loading = ref(true);
  const error = ref<Error | null>(null);

  watchEffect((onCleanup) => {
    // Read every reactive input before the first await — see the
    // same note in `use-chord-render.ts`.
    const name = toValue(chord);
    const {
      instrument = 'guitar',
      defines,
      orientation,
      compact,
    } = toValue(options);
    const definesArray: Array<[string, string]> = defines
      ? defines.map(([n, raw]) => [n, raw])
      : [];

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    const run = async (): Promise<void> => {
      loading.value = true;
      try {
        const renderer = await loadWasm(loader);
        if (cancelled) return;
        // Clear oversized orientation strings before crossing the
        // wasm ABI — see `MAX_ORIENTATION_INPUT_LEN`.
        const safeOrientation =
          typeof orientation === 'string' && orientation.length > MAX_ORIENTATION_INPUT_LEN
            ? null
            : (orientation ?? null);

        // Prefer the compact export, then the orientation-aware
        // one, then the defines-aware one, and finally the plain
        // export. A caller who asked for a knob the loaded bundle
        // does not expose gets the closest working diagram plus a
        // one-shot warning, so the staleness is auditable instead
        // of silently ignored.
        let result: string | null | undefined;
        if (compact && renderer.chordDiagramSvgWithDefinesOrientationCompact) {
          result = renderer.chordDiagramSvgWithDefinesOrientationCompact(
            name,
            instrument,
            definesArray,
            safeOrientation,
          );
        } else if (renderer.chordDiagramSvgWithDefinesOrientation) {
          if (compact) {
            warnOnce(
              'compact-export-missing',
              '[@chordsketch/vue] useChordDiagram: the loaded @chordsketch/wasm bundle ' +
                'does not expose chordDiagramSvgWithDefinesOrientationCompact; rendering the ' +
                'regular (full-size) diagram. Update @chordsketch/wasm to honour the ' +
                'compact option.',
            );
          }
          result = renderer.chordDiagramSvgWithDefinesOrientation(
            name,
            instrument,
            definesArray,
            safeOrientation,
          );
        } else {
          if (orientation !== undefined) {
            warnOnce(
              'orientation-export-missing',
              '[@chordsketch/vue] useChordDiagram: the loaded @chordsketch/wasm bundle ' +
                'does not expose chordDiagramSvgWithDefinesOrientation; rendering in the ' +
                'legacy vertical layout. Update @chordsketch/wasm to honour the ' +
                'orientation option.',
            );
          }
          result = renderer.chordDiagramSvgWithDefines
            ? renderer.chordDiagramSvgWithDefines(name, instrument, definesArray)
            : renderer.chord_diagram_svg(name, instrument);
        }
        if (cancelled) return;
        svg.value = result ?? null;
        error.value = null;
      } catch (e) {
        if (cancelled) return;
        error.value = e instanceof Error ? e : new Error(String(e));
        // Clear the previous SVG so a bad instrument does not keep
        // showing the previous chord's diagram — unlike
        // `<ChordSheet>`, diagrams are tiny / per-chord, and
        // keeping a stale image alongside an instrument-mismatch
        // error would be visually confusing.
        svg.value = null;
      } finally {
        if (!cancelled) {
          loading.value = false;
        }
      }
    };

    void run();
  });

  return { svg, loading, error };
}
