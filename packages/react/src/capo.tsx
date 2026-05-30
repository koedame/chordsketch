import type { ChangeEvent, HTMLAttributes } from 'react';
import { useCallback, useId, useMemo } from 'react';

import { computeBestCapoPositions } from './best-capo';
import {
  CAPO_MAX,
  CAPO_MIN,
  readCapo,
  setCapoInSource,
} from './chord-source-edit';
import { clamp as clampValue } from './clamp';
import { useChordproAst } from './use-chordpro-ast';

/**
 * Either of the two `<Capo>` shapes. Mirrors `<Transpose>`'s
 * controlled contract on one side, and on the other side
 * round-trips through the ChordPro `{capo: N}` directive so a
 * host that already owns the source string (the playground, VS
 * Code WebView with a host-side `WorkspaceEdit` bridge) does not
 * need a parallel piece of capo state.
 */
type CapoModeProps =
  | {
      /** Current capo position (controlled mode). */
      value: number;
      /** Fired when the select value changes. */
      onChange: (next: number) => void;
      source?: undefined;
      onSourceChange?: undefined;
    }
  | {
      /** Full ChordPro source — the `{capo: N}` directive is read out. */
      source: string;
      /**
       * Fired when the select value changes.
       * Receives the updated source with the `{capo: N}` directive
       * inserted / updated / removed via {@link setCapoInSource}.
       *
       * Hosts that route document edits through a separate pipeline
       * (e.g. VS Code's `WorkspaceEdit` over a message channel) can
       * pass `onCapoChange` instead of mutating `source` directly.
       */
      onSourceChange: (next: string) => void;
      value?: undefined;
      onChange?: undefined;
    };

/** Props accepted by {@link Capo}. */
export type CapoProps = CapoModeProps &
  Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'children'> & {
    /** Minimum capo position. Defaults to {@link CAPO_MIN} (`0`). */
    min?: number;
    /** Maximum capo position. Defaults to {@link CAPO_MAX} (`12`). */
    max?: number;
    /**
     * Step between adjacent options. Defaults to `1`. A `value` /
     * `{capo:N}` that does not land on the option grid snaps to the
     * nearest rendered option, so a non-dividing `step` never leaves
     * the select showing an unselectable value. A non-positive `step`
     * (or `max < min`) produces an empty, inert select.
     */
    step?: number;
    /**
     * Optional label shown inline before the select. Defaults to
     * `"Capo"`. Pass `null` to omit the visible label; the select
     * still carries an `aria-label`.
     */
    label?: React.ReactNode;
    /**
     * Optional notification fired in source-pair mode in addition
     * to `onSourceChange`. Receives the numeric capo value the
     * source was rewritten with.
     */
    onCapoChange?: (next: number) => void;
    /**
     * Format an option's capo value. Defaults to a bare integer.
     * The result is rendered as the `<option>`'s text content (a
     * ` ★` suffix is appended for best-capo positions), so the
     * return type is `string | number` — elements do not render
     * inside `<option>`.
     */
    formatValue?: (value: number) => string | number;
    /**
     * Capo positions to surface with a ★ marker on the matching
     * option — pass `BestCapoResult.positions` from
     * {@link computeBestCapoPositions} (in `best-capo.ts`). Entries
     * outside `[min, max]` are silently ignored. Pass an empty
     * array (or omit) to suppress the markers. The ★ marker has no
     * behavioural effect; it is purely a visual hint. Declared as
     * `ReadonlyArray<number>` so the caller cannot mutate it in
     * place after handing it to the component.
     */
    bestPositions?: ReadonlyArray<number>;
    /**
     * Active transpose offset, in source-pair mode. When the host
     * also drives a `<Transpose>` select, pass the same value here
     * so the ★ best-capo recommendations reflect the
     * *transposed* chord roots — changing the transpose value
     * shifts which capo positions zero out the accidentals.
     * Defaults to `0` (no transpose). Ignored in controlled mode
     * (the host supplies `bestPositions` directly).
     *
     * Values must fit in an `i8` (`-128..=127`); the wasm parser
     * rejects anything wider at deserialisation time. Hosts that
     * wire this prop to a `<Transpose>` select's value never need
     * to worry — the select clamps to its `min` / `max` (`±6` by
     * default).
     */
    transpose?: number;
  };

function defaultFormat(value: number): string {
  return String(value);
}

function isSourceMode(
  props: Pick<CapoProps, 'source' | 'onSourceChange' | 'value' | 'onChange'>,
): props is CapoProps & { source: string; onSourceChange: (next: string) => void } {
  return props.source !== undefined;
}

/**
 * Accessible capo control: a native `<select>` listing every fret
 * position between `min` and `max`, styled as the design-system
 * select (white surface, hairline border, inline chevrons-up-down
 * caret) to match the playground's `.chordsketch-app__select`.
 * Best-capo positions are flagged with a ★ on the matching option.
 * Keyboard and screen-reader support come from the native select.
 *
 * Two API shapes are supported and mutually exclusive:
 *
 * 1. **Controlled** — `value` + `onChange`. Acts as a pure
 *    select, identical in shape to `<Transpose>`.
 *
 *    ```tsx
 *    const [capo, setCapo] = useState(0);
 *    <Capo value={capo} onChange={setCapo} />
 *    ```
 *
 * 2. **Source-pair** — `source` + `onSourceChange`. The capo
 *    value is derived from `source` via {@link readCapo}; select
 *    changes write the new source through {@link setCapoInSource}
 *    and emit the result via `onSourceChange`. Use this shape
 *    when the host already owns the ChordPro string — there is no
 *    second piece of capo state to keep in sync.
 *
 *    ```tsx
 *    <Capo source={source} onSourceChange={setSource} />
 *    ```
 *
 * Per ADR-0023, the selected value drives a render-time `-capo`
 * semitone shift applied by the renderer pipeline; this component
 * itself does not transpose chord lines.
 */
export function Capo(props: CapoProps): JSX.Element {
  const {
    min = CAPO_MIN,
    max = CAPO_MAX,
    step = 1,
    label = 'Capo',
    formatValue = defaultFormat,
    onCapoChange,
    className,
    bestPositions,
    transpose = 0,
    // Extract the mode-specific fields so they do not leak into
    // the spread onto the wrapper div.
    value: controlledValue,
    onChange,
    source,
    onSourceChange,
    ...divProps
  } = props;

  const sourceMode = isSourceMode(props);
  const rawValue = sourceMode ? readCapo(source!) : controlledValue!;

  // Source-pair mode: parse the source so the ★ best-capo hint
  // appears automatically without the host having to pre-compute
  // it. Threading `transpose` through here lets the AST come back
  // with chord roots already shifted by `transpose - capo` — pair
  // that with `parseSongCapo`'s capo-undo in `computeBestCapoPositions`
  // and the best-capo enumeration runs against the *transposed*
  // chord roots, so changing the `<Transpose>` value shifts the
  // ★ recommendations alongside the song.
  //
  // Controlled mode passes `skip: true` so the wasm module is
  // not fetched for a parse whose result we would immediately
  // discard (the host already owns the AST and supplies
  // `bestPositions` directly).
  const {
    ast: sourceAst,
    error: sourceAstError,
    loading: sourceAstLoading,
  } = useChordproAst(sourceMode ? source! : '', {
    transpose,
    skip: !sourceMode,
  });
  const derivedBestPositions = useMemo(() => {
    if (!sourceMode || !sourceAst) return undefined;
    const result = computeBestCapoPositions(sourceAst);
    return result?.positions;
  }, [sourceMode, sourceAst]);
  const effectiveBestPositions = bestPositions ?? derivedBestPositions;
  const clamp = useCallback(
    (next: number): number => clampValue(next, min, max),
    [min, max],
  );
  // Highest fret first so the dropdown reads top-down as
  // `12 … 0` (capo position increases toward the top, matching
  // the ↕ caret and the `<Transpose>` ordering).
  const options = useMemo(() => {
    if (step <= 0 || max < min) return [] as number[];
    const out: number[] = [];
    for (let p = max; p >= min; p -= step) out.push(p);
    return out;
  }, [min, max, step]);

  // Resolve the host value (controlled `value`, or `{capo: N}` from
  // the source) to the nearest rendered option. A native <select>
  // cannot display a value with no matching <option>, so an
  // out-of-range value (clamped here) or an off-grid value (when
  // `step` does not divide the range) would otherwise leave the
  // control showing the wrong fret. Snapping keeps it in sync.
  const displayValue = useMemo(() => {
    const bounded = clamp(rawValue);
    if (options.length === 0) return bounded;
    return options.reduce(
      (best, opt) =>
        Math.abs(opt - bounded) < Math.abs(best - bounded) ? opt : best,
      options[0],
    );
  }, [rawValue, options, clamp]);

  const emit = useCallback(
    (next: number): void => {
      const clamped = clamp(next);
      if (sourceMode) {
        const nextSource = setCapoInSource(source!, clamped);
        onSourceChange!(nextSource);
        onCapoChange?.(clamped);
      } else {
        onChange!(clamped);
      }
    },
    [clamp, sourceMode, source, onSourceChange, onCapoChange, onChange],
  );

  const handleSelectChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      const parsed = Number.parseInt(event.target.value, 10);
      if (Number.isNaN(parsed)) return;
      emit(parsed);
    },
    [emit],
  );

  // Build the ★ marker set. We keep only entries that fall inside
  // `min..=max` so a host that narrowed the range does not flag
  // options it cannot reach. Empty list → no markers.
  const markers = useMemo(() => {
    if (!effectiveBestPositions || effectiveBestPositions.length === 0) return [] as number[];
    const seen = new Set<number>();
    const result: number[] = [];
    for (const pos of effectiveBestPositions) {
      // Reject non-finite or non-integer entries before the range
      // check: NaN slips past `pos < min || pos > max` (every NaN
      // comparison evaluates to false in JS). Integer-only matches
      // the contract of capo positions (`computeBestCapoPositions`
      // always emits integers).
      if (!Number.isInteger(pos)) continue;
      if (pos < min || pos > max) continue;
      if (seen.has(pos)) continue;
      seen.add(pos);
      result.push(pos);
    }
    return result.sort((a, b) => a - b);
  }, [effectiveBestPositions, min, max]);
  const markerSet = useMemo(() => new Set(markers), [markers]);

  // Use React 18's `useId` so the generated id is stable across
  // server-render and client-hydration. The previous `Math.random()`
  // path produced a fresh value on every call and broke SSR
  // hydration whenever a host server-rendered `<Capo>`.
  const baseId = useId();
  const markerDescriptionId = markers.length > 0 ? `${baseId}-capo-best` : undefined;

  const ariaLabel =
    typeof divProps['aria-label'] === 'string'
      ? divProps['aria-label']
      : typeof label === 'string'
        ? label
        : 'Capo';

  return (
    <div
      {...divProps}
      role="group"
      aria-label={ariaLabel}
      className={['chordsketch-capo', className].filter(Boolean).join(' ')}
    >
      {label !== null ? (
        <span className="chordsketch-capo__label" aria-hidden="true">
          {label}
        </span>
      ) : null}
      <select
        className="chordsketch-capo__select"
        value={displayValue}
        onChange={handleSelectChange}
        aria-label={ariaLabel}
        aria-describedby={markerDescriptionId}
      >
        {options.map((pos) => (
          <option key={pos} value={pos} data-best-capo={markerSet.has(pos) ? pos : undefined}>
            {formatValue(pos)}
            {markerSet.has(pos) ? ' ★' : ''}
          </option>
        ))}
      </select>
      {markerDescriptionId ? (
        <span id={markerDescriptionId} className="chordsketch-capo__sr-only">
          ★ marks the easiest capo position{markers.length === 1 ? '' : 's'} —
          chord roots use the fewest accidentals there.
        </span>
      ) : null}
      {/* Source-pair-mode-only: surface a wasm-load / parse
          failure so the user sees that the ★ markers are
          unavailable instead of a silent absence. `role="status"`
          + `aria-live="polite"` so screen readers announce it
          without interrupting the user. The error is not rendered
          in controlled mode (the host owns AST parsing and supplies
          `bestPositions` directly), nor while the parse is in
          flight (loading spinners belong to the host). */}
      {sourceMode && sourceAstError && !sourceAstLoading ? (
        <span
          className="chordsketch-capo__hint chordsketch-capo__hint--error"
          role="status"
          aria-live="polite"
        >
          Capo recommendations unavailable
        </span>
      ) : null}
    </div>
  );
}
