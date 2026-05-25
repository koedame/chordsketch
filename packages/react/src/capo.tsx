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
      /** Fired when the slider's input value changes. */
      onChange: (next: number) => void;
      source?: undefined;
      onSourceChange?: undefined;
    }
  | {
      /** Full ChordPro source — the `{capo: N}` directive is read out. */
      source: string;
      /**
       * Fired when the slider's input value changes.
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
    /** Step size for the slider. Defaults to `1`. */
    step?: number;
    /**
     * Optional label shown inline with the slider. Defaults to
     * `"Capo"`. Pass `null` to omit the visible label; the
     * component still exposes `aria-label` on the wrapper.
     */
    label?: React.ReactNode;
    /**
     * Optional notification fired in source-pair mode in addition
     * to `onSourceChange`. Receives the numeric capo value the
     * source was rewritten with.
     */
    onCapoChange?: (next: number) => void;
    /** Format the capo indicator. Defaults to a bare integer. */
    formatValue?: (value: number) => React.ReactNode;
    /**
     * Capo positions to surface as ★ markers on the slider — pass
     * `BestCapoResult.positions` from {@link computeBestCapoPositions}
     * (in `best-capo.ts`). Entries outside `[min, max]` are
     * silently ignored. Pass an empty array (or omit) to suppress
     * the markers. The ★ marker has no behavioural effect; it is
     * purely a visual hint. Declared as `ReadonlyArray<number>`
     * so the caller cannot mutate it in place after handing it to
     * the component.
     */
    bestPositions?: ReadonlyArray<number>;
    /**
     * Active transpose offset, in source-pair mode. When the host
     * also drives a `<Transpose>` slider, pass the same value here
     * so the ★ best-capo recommendations reflect the
     * *transposed* chord roots — moving the transpose slider
     * shifts which capo positions zero out the accidentals.
     * Defaults to `0` (no transpose). Ignored in controlled mode
     * (the host supplies `bestPositions` directly).
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
 * Accessible capo control: a native `<input type="range">` slider
 * with a current-value readout and optional ★ markers at the
 * "easiest capo position" tied set. Keyboard support comes from
 * the native range input (Arrow keys, Home / End, PageUp /
 * PageDown).
 *
 * Two API shapes are supported and mutually exclusive:
 *
 * 1. **Controlled** — `value` + `onChange`. Acts as a pure
 *    slider, identical in shape to `<Transpose>`.
 *
 *    ```tsx
 *    const [capo, setCapo] = useState(0);
 *    <Capo value={capo} onChange={setCapo} />
 *    ```
 *
 * 2. **Source-pair** — `source` + `onSourceChange`. The capo
 *    value is derived from `source` via {@link readCapo}; slider
 *    changes write the new source through {@link setCapoInSource}
 *    and emit the result via `onSourceChange`. Use this shape
 *    when the host already owns the ChordPro string — there is no
 *    second piece of capo state to keep in sync.
 *
 *    ```tsx
 *    <Capo source={source} onSourceChange={setSource} />
 *    ```
 *
 * Per ADR-0023, the slider's value drives a render-time `-capo`
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
  // chord roots, so moving the `<Transpose>` slider shifts the
  // ★ recommendations alongside the song. `useChordproAst`
  // lazy-loads `@chordsketch/wasm` and caches the result, so
  // this is cheap to call from inside the component. Controlled
  // mode skips parsing (the host has the AST already and passes
  // `bestPositions` explicitly).
  const { ast: sourceAst } = useChordproAst(sourceMode ? source! : '', { transpose });
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
  // The host may pass a `value` outside `[min, max]` (controlled
  // mode) or the source may carry a `{capo: N}` outside the
  // slider's range. Native `<input type="range">` will visually
  // clamp the thumb to the bound but the `<output>` readout would
  // surface the raw value, producing a "thumb at +6 / readout +10"
  // disagreement. Clamp at render time so both surfaces agree.
  const displayValue = clamp(rawValue);

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

  const handleSliderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      // The native range input clamps on its own, but parse +
      // re-clamp anyway so a programmatic `event.target.value`
      // outside `min..=max` (e.g. driven by automation in tests)
      // still lands inside the contract.
      const parsed = Number.parseInt(event.target.value, 10);
      if (Number.isNaN(parsed)) return;
      emit(parsed);
    },
    [emit],
  );

  // Build the ★ marker positions. We keep only entries that fall
  // inside `min..=max` so a host that narrowed the range does not
  // see stranded markers outside the slider track. Empty list →
  // no markers rendered.
  const markers = useMemo(() => {
    if (!effectiveBestPositions || effectiveBestPositions.length === 0) return [] as number[];
    const seen = new Set<number>();
    const result: number[] = [];
    for (const pos of effectiveBestPositions) {
      // Reject non-finite or non-integer entries before the range
      // check: NaN slips past `pos < min || pos > max` (every NaN
      // comparison evaluates to false in JS) and would otherwise
      // produce a `left: NaN%` CSS rule and a `data-best-capo="NaN"`
      // attribute on the marker span. Infinity is rejected for the
      // same reason. Integer-only matches the contract of capo
      // positions (`computeBestCapoPositions` always emits integers).
      if (!Number.isInteger(pos)) continue;
      if (pos < min || pos > max) continue;
      if (seen.has(pos)) continue;
      seen.add(pos);
      result.push(pos);
    }
    return result.sort((a, b) => a - b);
  }, [effectiveBestPositions, min, max]);

  // Use React 18's `useId` so the generated id is stable across
  // server-render and client-hydration. The previous `Math.random()`
  // path produced a fresh value on every call and broke SSR
  // hydration whenever a host server-rendered `<Capo>`.
  const baseId = useId();
  const markerDescriptionId = markers.length > 0 ? `${baseId}-capo-best` : undefined;

  const range = max - min;
  const ariaLabel =
    typeof divProps['aria-label'] === 'string'
      ? divProps['aria-label']
      : typeof label === 'string'
        ? label
        : 'Capo';

  // Tick marks AND numeric labels at every step — every grid
  // line is annotated so the user does not have to interpolate.
  const ticks = useMemo(() => {
    if (range <= 0 || step <= 0) return [] as Array<{ pos: number; major: boolean }>;
    const out: Array<{ pos: number; major: boolean }> = [];
    for (let p = min; p <= max; p += step) {
      out.push({ pos: p, major: true });
    }
    return out;
  }, [min, max, step, range]);

  const handleDecrement = useCallback(() => emit(displayValue - step), [emit, displayValue, step]);
  const handleIncrement = useCallback(() => emit(displayValue + step), [emit, displayValue, step]);
  const decrementDisabled = displayValue <= min;
  const incrementDisabled = displayValue >= max;

  return (
    <div
      {...divProps}
      role="group"
      aria-label={ariaLabel}
      className={['chordsketch-capo', className].filter(Boolean).join(' ')}
    >
      <div className="chordsketch-capo__header">
        {label !== null ? (
          <span className="chordsketch-capo__label" aria-hidden="true">
            {label}
          </span>
        ) : (
          <span />
        )}
        <output
          className="chordsketch-capo__value"
          aria-live="polite"
          aria-atomic="true"
        >
          {formatValue(displayValue)}
        </output>
      </div>
      <div className="chordsketch-capo__controls">
        <button
          type="button"
          className="chordsketch-capo__btn chordsketch-capo__btn--decrement"
          onClick={handleDecrement}
          disabled={decrementDisabled}
          aria-label={step === 1 ? 'Capo down one fret' : `Capo down ${step} frets`}
        >
          −
        </button>
        <div className="chordsketch-capo__slider-wrap">
          <input
            type="range"
            className="chordsketch-capo__slider"
            min={min}
            max={max}
            step={step}
            value={displayValue}
            onChange={handleSliderChange}
            aria-label={ariaLabel}
            aria-describedby={markerDescriptionId}
          />
          {range > 0 ? (
            <>
              <div className="chordsketch-capo__ticks" aria-hidden="true">
                {ticks.map(({ pos, major }) => (
                  <span
                    key={pos}
                    className={
                      major
                        ? 'chordsketch-capo__tick chordsketch-capo__tick--major'
                        : 'chordsketch-capo__tick'
                    }
                    style={{ left: `${((pos - min) / range) * 100}%` }}
                  />
                ))}
              </div>
              <div className="chordsketch-capo__tick-labels" aria-hidden="true">
                {ticks
                  .filter(({ major }) => major)
                  .map(({ pos }) => (
                    <span
                      key={pos}
                      className="chordsketch-capo__tick-label"
                      style={{ left: `${((pos - min) / range) * 100}%` }}
                    >
                      {pos}
                    </span>
                  ))}
              </div>
              {markers.length > 0 ? (
                <div className="chordsketch-capo__markers" aria-hidden="true">
                  {markers.map((pos) => (
                    <span
                      key={pos}
                      className="chordsketch-capo__marker"
                      style={{ left: `${((pos - min) / range) * 100}%` }}
                      data-best-capo={pos}
                    >
                      ★
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <button
          type="button"
          className="chordsketch-capo__btn chordsketch-capo__btn--increment"
          onClick={handleIncrement}
          disabled={incrementDisabled}
          aria-label={step === 1 ? 'Capo up one fret' : `Capo up ${step} frets`}
        >
          +
        </button>
      </div>
      {markerDescriptionId ? (
        <span id={markerDescriptionId} className="chordsketch-capo__sr-only">
          ★ marks the easiest capo position{markers.length === 1 ? '' : 's'} —
          chord roots use the fewest accidentals there.
        </span>
      ) : null}
    </div>
  );
}
