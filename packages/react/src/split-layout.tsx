import type { HTMLAttributes, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { clamp } from './clamp';

const DEFAULT_RATIO = 0.5;
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;
const KEYBOARD_STEP = 0.02;

/** Props accepted by {@link SplitLayout}. */
export interface SplitLayoutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Content rendered in the left (or top, on narrow viewports) pane. */
  start: ReactNode;
  /** Content rendered in the right (or bottom) pane. */
  end: ReactNode;
  /**
   * Initial split ratio (0 = `start` collapsed, 1 = `end`
   * collapsed). Clamped to `[0.2, 0.8]` to keep both panes
   * usable. Defaults to `0.5`.
   */
  defaultRatio?: number;
  /**
   * Controlled ratio. When set, the component does not manage its
   * own internal state — update `ratio` from the parent on every
   * `onRatioChange` firing.
   */
  ratio?: number;
  /**
   * Fired whenever the user drags the splitter or presses
   * ArrowLeft / ArrowRight on the focused separator.
   */
  onRatioChange?: (next: number) => void;
  /**
   * Accessible label applied to the separator handle. Defaults
   * to `"Resize panes"`.
   */
  splitterLabel?: string;
  /**
   * Below this viewport width the layout collapses to a vertical
   * stack and the splitter is hidden. Defaults to `768`px.
   */
  stackBelow?: number;
}

/**
 * Two-pane layout with a draggable hairline splitter. Follows the
 * W3C APG Window Splitter pattern (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/):
 * the splitter is a `role="separator"` keyboard-focusable element
 * with `aria-valuenow` / `aria-valuemin` / `aria-valuemax`
 * reflecting the current ratio percentage. ArrowLeft / ArrowRight
 * resize when focused.
 *
 * The splitter visual is a 1 px hairline (uses `--cs-border` and
 * `--cs-crimson-500` from `styles.css`) with a widened invisible
 * hit-target so pointer drags engage reliably without thickening
 * the visible rule.
 *
 * ```tsx
 * <SplitLayout start={<SourceEditor … />} end={<ChordSheet … />} />
 * ```
 */
export function SplitLayout({
  start,
  end,
  defaultRatio,
  ratio,
  onRatioChange,
  splitterLabel = 'Resize panes',
  stackBelow = 768,
  className,
  style,
  ...divProps
}: SplitLayoutProps): JSX.Element {
  const isControlled = ratio !== undefined;
  const [internalRatio, setInternalRatio] = useState<number>(
    () => clamp(defaultRatio ?? DEFAULT_RATIO, RATIO_MIN, RATIO_MAX),
  );
  const currentRatio = isControlled
    ? clamp(ratio, RATIO_MIN, RATIO_MAX)
    : internalRatio;

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const startId = useId();

  // Single source of truth for ratio updates. Notifies the parent
  // and (in uncontrolled mode) updates the internal state. Pulled
  // out so the keyboard, pointer, and external paths share one
  // entry point.
  const commitRatio = useCallback(
    (next: number) => {
      const clamped = clamp(next, RATIO_MIN, RATIO_MAX);
      if (!isControlled) setInternalRatio(clamped);
      onRatioChange?.(clamped);
    },
    [isControlled, onRatioChange],
  );

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      const next = (event.clientX - rect.left) / rect.width;
      commitRatio(next);
    },
    [commitRatio],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        commitRatio(currentRatio - KEYBOARD_STEP);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        commitRatio(currentRatio + KEYBOARD_STEP);
      } else if (event.key === 'Home') {
        event.preventDefault();
        commitRatio(RATIO_MIN);
      } else if (event.key === 'End') {
        event.preventDefault();
        commitRatio(RATIO_MAX);
      }
    },
    [commitRatio, currentRatio],
  );

  // The stacked-vs-side-by-side decision lives in CSS so that a
  // window resize updates the layout without React re-rendering.
  // The custom property exposes the current ratio to the
  // wrapper's `flex-basis` rules in styles.css.
  const containerStyle = {
    ...style,
    '--cs-split-ratio': currentRatio,
    '--cs-split-stack-below': `${stackBelow}px`,
  } as React.CSSProperties;

  const wrapperClass = ['chordsketch-split-layout', className]
    .filter(Boolean)
    .join(' ');

  // Round the percentage so screen-reader announcements do not
  // narrate twelve decimal places on every keystroke.
  const ariaValue = Math.round(currentRatio * 100);

  // Hide the splitter when stacked on narrow viewports (CSS does
  // the same job visually, but assistive tech still picks up
  // hidden elements unless we add `aria-hidden`). The matchMedia
  // check is wrapped in an effect so SSR remains side-effect free.
  const [isStacked, setIsStacked] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(`(max-width: ${stackBelow}px)`);
    const sync = () => setIsStacked(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, [stackBelow]);

  return (
    <div
      {...divProps}
      ref={containerRef}
      className={wrapperClass}
      style={containerStyle}
    >
      <div
        className="chordsketch-split-layout__pane chordsketch-split-layout__pane--start"
        id={startId}
      >
        {start}
      </div>
      <div
        className="chordsketch-split-layout__splitter"
        role="separator"
        aria-orientation="vertical"
        aria-controls={startId}
        aria-label={splitterLabel}
        aria-valuenow={ariaValue}
        aria-valuemin={Math.round(RATIO_MIN * 100)}
        aria-valuemax={Math.round(RATIO_MAX * 100)}
        aria-hidden={isStacked || undefined}
        tabIndex={isStacked ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="chordsketch-split-layout__pane chordsketch-split-layout__pane--end">
        {end}
      </div>
    </div>
  );
}
