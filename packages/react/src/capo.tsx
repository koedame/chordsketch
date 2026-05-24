import type { ChangeEvent, HTMLAttributes } from 'react';
import { useCallback, useMemo } from 'react';

import {
  CAPO_MAX,
  CAPO_MIN,
  readCapo,
  setCapoInSource,
} from './chord-source-edit';
import { clamp as clampValue } from './clamp';

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
     * Capo positions to surface as ★ markers on the slider — see
     * `computeBestCapoPositions` in `best-capo.ts`. Pass an empty
     * array (or omit) to suppress the markers. The ★ marker has
     * no behavioural effect; it is purely a visual hint.
     */
    bestPositions?: number[];
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
  const clamp = useCallback(
    (next: number): number => clampValue(next, min, max),
    [min, max],
  );

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
    if (!bestPositions || bestPositions.length === 0) return [] as number[];
    const seen = new Set<number>();
    const result: number[] = [];
    for (const pos of bestPositions) {
      if (pos < min || pos > max) continue;
      if (seen.has(pos)) continue;
      seen.add(pos);
      result.push(pos);
    }
    return result.sort((a, b) => a - b);
  }, [bestPositions, min, max]);

  const markerDescriptionId = useMemo(
    () => (markers.length > 0 ? `chordsketch-capo-best-${Math.random().toString(36).slice(2, 9)}` : undefined),
    [markers.length],
  );

  const range = max - min;
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
      <div className="chordsketch-capo__slider-wrap">
        <input
          type="range"
          className="chordsketch-capo__slider"
          min={min}
          max={max}
          step={step}
          value={rawValue}
          onChange={handleSliderChange}
          aria-label={ariaLabel}
          aria-describedby={markerDescriptionId}
        />
        {markers.length > 0 && range > 0 ? (
          <div className="chordsketch-capo__markers" aria-hidden="true">
            {markers.map((pos) => {
              // Position the ★ proportionally over the slider
              // track. `left: 0%` aligns with `min`, `100%`
              // aligns with `max`.
              const percent = ((pos - min) / range) * 100;
              return (
                <span
                  key={pos}
                  className="chordsketch-capo__marker"
                  style={{ left: `${percent}%` }}
                  data-best-capo={pos}
                >
                  ★
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      <output
        className="chordsketch-capo__value"
        aria-live="polite"
        aria-atomic="true"
      >
        {formatValue(rawValue)}
      </output>
      {markerDescriptionId ? (
        <span id={markerDescriptionId} className="chordsketch-capo__sr-only">
          ★ marks the easiest capo position{markers.length === 1 ? '' : 's'} —
          chord roots use the fewest accidentals there.
        </span>
      ) : null}
    </div>
  );
}
