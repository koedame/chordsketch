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
  /**
   * Variant honouring the horizontal-orientation knob added in
   * #2572. `orientation` accepts the same string values the Rust
   * `resolve_orientation` helper does; `null` / `undefined` falls
   * back to the default (vertical layout). Horizontal mode is
   * reader-view only — see ADR-0026.
   *
   * Typed as `ChordDiagramOrientation | null | undefined` so callers
   * that construct their own stub renderer cannot accidentally pass
   * arbitrary strings — the wasm side caps at
   * `MAX_RESOLVER_INPUT_LEN` regardless, but the narrower TS type
   * catches mistakes at the consumer-package boundary.
   */
  chordDiagramSvgWithDefinesOrientation?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
    orientation: ChordDiagramOrientation | null | undefined,
  ) => string | null | undefined;
  /**
   * Compact-size variant honouring the chordsketch `{diagrams: inline}`
   * / `{diagrams: hover}` modes. Same arguments as
   * `chordDiagramSvgWithDefinesOrientation` but returns the smaller
   * above-a-lyric layout (geometry shrunk, glyphs kept legible — see
   * the Rust `DiagramSize::Compact`). Absent on `@chordsketch/wasm`
   * bundles predating the compact export, so callers must
   * feature-detect and fall back to the regular export.
   */
  chordDiagramSvgWithDefinesOrientationCompact?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
    orientation: ChordDiagramOrientation | null | undefined,
  ) => string | null | undefined;
  /**
   * MIDI note numbers **sounded** by the diagram drawn for
   * `(chord, instrument)` — the audio companion to the SVG exports, used to
   * audition a diagram as exactly the shape it depicts. Runs the same
   * voicing lookup as the SVG path, so the pitches and the drawn diagram
   * cannot drift. `defines` is the same `[name, raw]` list the SVG exports
   * accept (ignored for keyboard instruments). Returns `null` / `undefined`
   * when no diagram is available for the chord.
   *
   * Absent on `@chordsketch/wasm` bundles predating #2736, so callers must
   * feature-detect and fall back to the name-based block voicing
   * (`chordPitches`) when it is missing.
   */
  diagramPitches?: (
    chord: string,
    instrument: string,
    defines: Array<[string, string]>,
  ) => Uint8Array | null | undefined;
}

/** Diagram orientation accepted by {@link useChordDiagram}. */
export type ChordDiagramOrientation = 'vertical' | 'horizontal';

/**
 * Mirror of the Rust-side `MAX_RESOLVER_INPUT_LEN` (64 bytes) — see
 * `crates/chordpro/src/chord_diagram.rs`. The wasm boundary applies
 * the same cap inside `resolve_orientation`, so this JS-side check is
 * defense-in-depth: it clears wildly oversized strings before they
 * cross the wasm ABI rather than relying solely on the Rust side. The
 * `ChordDiagramOrientation` type already constrains TS callers to the
 * two short literals; this guard catches hostile direct callers that
 * cast around the type.
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
//
// Asymmetry note: a single-step `as Promise<T>` cast on a dynamic
// `import('@chordsketch/wasm')` would surface a `TS2352` if the
// real wasm-pack declarations supersede the ambient shim
// (`wasm-shim.d.ts`, #2540) with a shape incompatible with `T`.
// The `unknown` step here erases shape conformance by construction,
// so the cast at this site cannot carry that divergence-detection
// responsibility — it lives in the runtime test against a stubbed
// renderer instead.
const defaultLoader: ChordDiagramWasmLoader = () =>
  import('@chordsketch/wasm') as unknown as Promise<DiagramRenderer>;

// Module-level latch for the stale-bundle warning. Each `<ChordDiagram>`
// instance creates its own `useChordDiagram` hook, so a per-`useRef`
// latch would let a chord-grid mounting N components emit N copies of
// the same message. Hoisting the latch out of the hook makes the
// "warn at most once per page load" contract actually hold across the
// component tree. A `Set<string>` keyed on the warning text lets future
// stale-bundle paths add distinct messages without sharing a single
// boolean. Exported for tests to reset between cases.
const staleBundleWarnings = new Set<string>();
/** @internal Test-only — reset the module-level stale-bundle warning latch. */
export function __resetStaleBundleWarnings(): void {
  staleBundleWarnings.clear();
}

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
  orientation?: ChordDiagramOrientation,
  compact?: boolean,
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
        // Prefer the orientation-aware export when present; fall back to
        // the defines-aware export (pre-#2572 bundles) and ultimately to
        // the plain export (pre-#2466 bundles).
        //
        // When the caller asked for a non-default orientation but the
        // loaded bundle does not expose the orientation export, the
        // diagram falls back to the legacy vertical layout. That is
        // graceful degradation, but a silent fallback would leave a
        // developer wondering why `orientation="horizontal"` was
        // ignored — emit a one-shot dev-mode warning so the staleness
        // is auditable. The warning is latched on the module-level
        // `staleBundleWarnings` set, so a chord grid mounting N
        // `<ChordDiagram>` instances logs the message exactly once
        // across the whole page rather than once per instance.
        const definesArray = defines ? defines.map(([n, r]) => [n, r] as [string, string]) : [];
        // Clear oversized orientation strings before crossing the
        // wasm ABI — see `MAX_ORIENTATION_INPUT_LEN`. A hostile
        // direct caller that bypasses the TS `ChordDiagramOrientation`
        // constraint with `as` cannot force the wasm side into an
        // allocation it would otherwise reject.
        const safeOrientation =
          typeof orientation === 'string' && orientation.length > MAX_ORIENTATION_INPUT_LEN
            ? null
            : (orientation ?? null);
        let result: string | null | undefined;
        if (compact && renderer.chordDiagramSvgWithDefinesOrientationCompact) {
          // Compact above-a-lyric layout (`{diagrams: inline}` /
          // `{diagrams: hover}`). Only reachable when the loaded bundle
          // exposes the compact export.
          result = renderer.chordDiagramSvgWithDefinesOrientationCompact(
            chord,
            instrument,
            definesArray,
            safeOrientation,
          );
        } else if (renderer.chordDiagramSvgWithDefinesOrientation) {
          // `compact` requested but the loaded bundle predates the
          // compact export: degrade to the regular-size diagram rather
          // than throwing, and warn once so the staleness is auditable
          // (same latch policy as the orientation fallback below).
          if (compact) {
            const staleCompactKey = 'compact-export-missing';
            if (!staleBundleWarnings.has(staleCompactKey)) {
              staleBundleWarnings.add(staleCompactKey);
              // eslint-disable-next-line no-console
              console.warn(
                '[@chordsketch/react] useChordDiagram: the loaded @chordsketch/wasm bundle ' +
                  'does not expose chordDiagramSvgWithDefinesOrientationCompact; rendering the ' +
                  'regular (full-size) diagram. Update @chordsketch/wasm to honour the ' +
                  'compact prop.',
              );
            }
          }
          result = renderer.chordDiagramSvgWithDefinesOrientation(
            chord,
            instrument,
            definesArray,
            safeOrientation,
          );
        } else {
          const staleOrientationKey = 'orientation-export-missing';
          if (
            orientation !== undefined &&
            !staleBundleWarnings.has(staleOrientationKey)
          ) {
            staleBundleWarnings.add(staleOrientationKey);
            // eslint-disable-next-line no-console
            console.warn(
              '[@chordsketch/react] useChordDiagram: the loaded @chordsketch/wasm bundle ' +
                'does not expose chordDiagramSvgWithDefinesOrientation; rendering in the ' +
                'legacy vertical layout. Update @chordsketch/wasm to honour the ' +
                'orientation prop.',
            );
          }
          if (renderer.chordDiagramSvgWithDefines) {
            result = renderer.chordDiagramSvgWithDefines(chord, instrument, definesArray);
          } else {
            result = renderer.chord_diagram_svg(chord, instrument);
          }
        }
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
  }, [chord, instrument, definesKey, orientation, compact]);

  return { svg, loading, error };
}

// Module-level latch for the missing-`diagramPitches`-export warning, so a
// chord grid mounting N `<ChordDiagram>` instances against a stale bundle
// logs the message once across the page rather than once per instance. Shares
// the policy of `staleBundleWarnings` above but is kept separate so a test
// can reset it independently.
const stalePitchesWarnings = new Set<string>();
/** @internal Test-only — reset the missing-`diagramPitches` warning latch. */
export function __resetStalePitchesWarnings(): void {
  stalePitchesWarnings.clear();
}

/**
 * Resolve the MIDI note numbers a chord **diagram** sounds for
 * `(chord, instrument)` via `@chordsketch/wasm`'s `diagramPitches`, so a
 * diagram can be auditioned as exactly the voicing it draws (the per-string
 * fretted pitches, or the keyboard's highlighted keys) rather than the
 * name-derived block voicing `chordPitches` returns.
 *
 * Returns `null` until the lookup resolves, when no diagram is available for
 * the chord, when `enabled` is `false`, or when the loaded `@chordsketch/wasm`
 * bundle predates the `diagramPitches` export (a one-shot dev-mode warning is
 * emitted in that last case). Callers should fall back to the chord-name play
 * path when this is `null` so audio degrades gracefully.
 *
 * `enabled` gates the wasm work: pass `false` (e.g. when chord-audio is off)
 * to skip the lookup entirely. The hook is still called unconditionally per
 * the rules of hooks.
 *
 * ```ts
 * const pitches = useChordDiagramPitches('Am', 'guitar', undefined, defines, audioOn);
 * ```
 */
export function useChordDiagramPitches(
  chord: string,
  instrument: ChordDiagramInstrument,
  loader: ChordDiagramWasmLoader = defaultLoader,
  defines?: ReadonlyArray<readonly [string, string]>,
  enabled = true,
): number[] | null {
  const [pitches, setPitches] = useState<number[] | null>(null);

  const rendererRef = useRef<DiagramRenderer | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const definesKey = defines ? JSON.stringify(defines) : '';

  useEffect(() => {
    if (!enabled) {
      setPitches(null);
      return;
    }
    let cancelled = false;

    const run = async (): Promise<void> => {
      try {
        if (rendererRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          if (cancelled) return;
          rendererRef.current = mod;
        }
        const renderer = rendererRef.current;
        if (typeof renderer.diagramPitches !== 'function') {
          // Stale bundle: no diagram-voicing export. Degrade to "no diagram
          // pitches" so the caller falls back to the name-based block voicing,
          // and warn once so the staleness is auditable (same latch policy as
          // the orientation / compact fallbacks above).
          const key = 'diagram-pitches-export-missing';
          if (!stalePitchesWarnings.has(key)) {
            stalePitchesWarnings.add(key);
            // eslint-disable-next-line no-console
            console.warn(
              '[@chordsketch/react] useChordDiagramPitches: the loaded @chordsketch/wasm ' +
                'bundle does not expose diagramPitches; chord diagrams will fall back to the ' +
                'name-based block voicing when played. Update @chordsketch/wasm to audition ' +
                'the diagram voicing.',
            );
          }
          if (!cancelled) setPitches(null);
          return;
        }
        const definesArray = defines ? defines.map(([n, r]) => [n, r] as [string, string]) : [];
        const raw = renderer.diagramPitches(chord, instrument, definesArray);
        if (cancelled) return;
        setPitches(raw ? Array.from(raw) : null);
      } catch {
        // A bad instrument / wasm init failure leaves audio on the fallback
        // path rather than surfacing here — the SVG hook owns error display.
        if (!cancelled) setPitches(null);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chord, instrument, definesKey, enabled]);

  return pitches;
}
