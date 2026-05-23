import type { HTMLAttributes, KeyboardEvent } from 'react';
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
      /** Fired when the user clicks a button or presses a shortcut. */
      onChange: (next: number) => void;
      source?: undefined;
      onSourceChange?: undefined;
    }
  | {
      /** Full ChordPro source — the `{capo: N}` directive is read out. */
      source: string;
      /**
       * Fired when the user clicks a button or presses a shortcut.
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
    /** Minimum capo position the buttons will emit. Defaults to {@link CAPO_MIN} (`0`). */
    min?: number;
    /** Maximum capo position the buttons will emit. Defaults to {@link CAPO_MAX} (`12`). */
    max?: number;
    /** Step size for `+` / `−` buttons. Defaults to `1`. */
    step?: number;
    /**
     * Value the reset button (and the `0` keyboard shortcut)
     * emit. Defaults to `0` so the reset returns to "no capo".
     * The reset button only renders when the current value
     * differs from `resetValue`.
     */
    resetValue?: number;
    /**
     * Optional label shown inline with the buttons. Defaults to
     * `"Capo"`. Pass `null` to omit the visible label; the
     * component still exposes `aria-label` on the wrapper.
     */
    label?: React.ReactNode;
    /**
     * Optional notification fired in source-pair mode in addition
     * to `onSourceChange`. Receives the numeric capo value the
     * source was rewritten with. Lets hosts that need both —
     * for example to update a status bar or trigger a host-side
     * edit — observe the capo value without re-parsing the
     * directive on every change.
     */
    onCapoChange?: (next: number) => void;
    /** Format the capo indicator. Defaults to a bare integer. */
    formatValue?: (value: number) => React.ReactNode;
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
 * Accessible capo control: a − button, a current-value readout,
 * a + button, and a reset button (only rendered when the position
 * differs from `resetValue`). Keyboard support on the wrapper:
 * `+` / `=` step up, `-` / `_` step down, `0` resets.
 *
 * Two API shapes are supported and mutually exclusive:
 *
 * 1. **Controlled** — `value` + `onChange`. Acts as a pure
 *    stepper, identical in shape to `<Transpose>`.
 *
 *    ```tsx
 *    const [capo, setCapo] = useState(0);
 *    <Capo value={capo} onChange={setCapo} />
 *    ```
 *
 * 2. **Source-pair** — `source` + `onSourceChange`. The capo
 *    value is derived from `source` via {@link readCapo}; clicks
 *    write the new source through {@link setCapoInSource} and
 *    emit the result via `onSourceChange`. Use this shape when
 *    the host already owns the ChordPro string — there is no
 *    second piece of capo state to keep in sync.
 *
 *    ```tsx
 *    <Capo source={source} onSourceChange={setSource} />
 *    ```
 */
export function Capo(props: CapoProps): JSX.Element {
  const {
    min = CAPO_MIN,
    max = CAPO_MAX,
    step = 1,
    resetValue = 0,
    label = 'Capo',
    formatValue = defaultFormat,
    onCapoChange,
    className,
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

  const handleDecrement = useCallback(() => emit(rawValue - step), [emit, rawValue, step]);
  const handleIncrement = useCallback(() => emit(rawValue + step), [emit, rawValue, step]);

  const clampedResetValue = useMemo(
    () => clampValue(resetValue, min, max),
    [resetValue, min, max],
  );

  const handleReset = useCallback(() => {
    // Reset routes through `emit` so source-pair mode rewrites
    // the directive (typically removing it when reset==0) and
    // controlled mode just fires `onChange` with the bounded
    // reset value.
    emit(clampedResetValue);
  }, [emit, clampedResetValue]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault();
          handleIncrement();
          break;
        case '-':
        case '_':
          event.preventDefault();
          handleDecrement();
          break;
        case '0':
          if (rawValue !== clampedResetValue) {
            event.preventDefault();
            handleReset();
          }
          break;
        default:
          break;
      }
    },
    [handleIncrement, handleDecrement, handleReset, rawValue, clampedResetValue],
  );

  const decrementDisabled = rawValue <= min;
  const incrementDisabled = rawValue >= max;

  return (
    <div
      {...divProps}
      role="group"
      aria-label={
        typeof divProps['aria-label'] === 'string'
          ? divProps['aria-label']
          : typeof label === 'string'
            ? label
            : 'Capo'
      }
      className={['chordsketch-capo', className].filter(Boolean).join(' ')}
      onKeyDown={handleKeyDown}
    >
      {label !== null ? (
        <span className="chordsketch-capo__label" aria-hidden="true">
          {label}
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleDecrement}
        disabled={decrementDisabled}
        aria-label={step === 1 ? 'Capo down one fret' : `Capo down ${step} frets`}
        className="chordsketch-capo__button chordsketch-capo__button--decrement"
      >
        −
      </button>
      <output
        className="chordsketch-capo__value"
        aria-live="polite"
        aria-atomic="true"
      >
        {formatValue(rawValue)}
      </output>
      <button
        type="button"
        onClick={handleIncrement}
        disabled={incrementDisabled}
        aria-label={step === 1 ? 'Capo up one fret' : `Capo up ${step} frets`}
        className="chordsketch-capo__button chordsketch-capo__button--increment"
      >
        +
      </button>
      {rawValue !== clampedResetValue ? (
        <button
          type="button"
          onClick={handleReset}
          aria-label={
            clampedResetValue === 0
              ? 'Reset capo to zero'
              : `Reset capo to ${clampedResetValue}`
          }
          className="chordsketch-capo__button chordsketch-capo__button--reset"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}
