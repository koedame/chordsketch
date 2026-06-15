import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';

import { MetronomeGlyph, tempoMarkingFor } from './music-glyphs';
import { useMetronome } from './use-metronome';

/** Props for {@link MetronomeButton}. */
export interface MetronomeButtonProps {
  /** Beats per minute, parsed from the `{tempo}` directive. */
  bpm: number;
  /**
   * Raw BPM string as written in the directive, shown as the chip's
   * readout (e.g. `"80"` → `80 BPM`). Falls back to `bpm` when absent.
   */
  bpmRaw?: string;
  /**
   * Class(es) for the chip root. The AST walker passes
   * `"meta-inline meta-inline--tempo"`; `pushElement` may append
   * `line--active`.
   */
  className?: string;
  /**
   * Forwarded to the chip root so the editor↔preview caret sync can
   * map the chip back to its source line (set by the walker's
   * `pushElement`).
   */
  'data-source-line'?: number;
}

/**
 * Interactive `{tempo}` chip.
 *
 * The whole chip is the click target (not just the icon): clicking
 * anywhere on it toggles an audible metronome (via {@link useMetronome})
 * ticking at the directive's BPM, and the cursor turns into a speaker
 * on hover. While playing, the chip's frame colour pulses once per
 * beat (driven by the `--cs-metronome-period` custom property the
 * component sets from the BPM) so it is obvious the metronome is
 * running.
 *
 * When the Web Audio API is unavailable — SSR, or a browser without
 * `AudioContext` — it degrades to a plain, non-interactive `<span>`
 * chip so no dead control is rendered. The interactive upgrade is
 * deferred to a post-mount effect so the server-rendered markup
 * matches the client's first render and React does not report a
 * hydration mismatch.
 */
export function MetronomeButton({
  bpm,
  bpmRaw,
  className,
  'data-source-line': dataSourceLine,
}: MetronomeButtonProps): JSX.Element {
  const metronome = useMetronome();
  const [interactive, setInteractive] = useState(false);
  const prevBpmRef = useRef(bpm);

  useEffect(() => {
    setInteractive(metronome.supported);
  }, [metronome.supported]);

  // Keep the audible beat in sync with live edits to the `{tempo}`
  // directive: if the BPM prop changes while the metronome is
  // running, re-arm at the new tempo. The guard runs every render
  // (no dep array) but only re-arms on an actual change, so play /
  // stop toggles — which do not change `bpm` — are left untouched.
  // Gate on the synchronous `isRunning()` (not the async `isPlaying`
  // state): if the page-level coordinator stopped this instance in
  // the same pass that the tempo edit re-rendered it, `isPlaying`
  // could still read stale `true` and resurrect a metronome the user
  // just silenced.
  useEffect(() => {
    if (prevBpmRef.current !== bpm) {
      prevBpmRef.current = bpm;
      if (metronome.isRunning()) {
        metronome.start(bpm);
      }
    }
  });

  const marking = tempoMarkingFor(bpm);
  const readout = bpmRaw ?? String(bpm);
  const value = (
    <span className="meta-inline__value">
      {readout} BPM
      {marking != null ? <span className="meta-inline__marking">{` (${marking})`}</span> : null}
    </span>
  );

  if (!interactive) {
    // Non-interactive fallback: the glyph keeps its own `role="img"`
    // + label since there is no surrounding button to name it.
    return (
      <span className={className} data-source-line={dataSourceLine}>
        <MetronomeGlyph bpm={bpm} className="meta-inline__glyph" />
        {value}
      </span>
    );
  }

  const label = metronome.isPlaying
    ? `Stop metronome (${bpm} BPM)`
    : `Play metronome at ${bpm} BPM`;
  // Beat duration in seconds, clamped to a sane range so a typo'd
  // `{tempo: 99999}` doesn't strobe the frame and `{tempo: 0.001}`
  // doesn't freeze it. Mirrors `MetronomeGlyph`'s pendulum clamp so
  // the frame pulse and the pendulum swing share one tempo.
  const period = Math.max(0.05, Math.min(5, 60 / (bpm > 0 ? bpm : 60)));
  const style: CSSProperties = {
    // CSS custom property consumed by the `cs-tempo-frame` keyframes.
    // The cast keeps CSSProperties happy (custom props aren't typed).
    ['--cs-metronome-period' as string]: `${period.toFixed(3)}s`,
  };

  return (
    <button
      type="button"
      className={[className, 'meta-inline--interactive', metronome.isPlaying ? 'is-playing' : '']
        .filter(Boolean)
        .join(' ')}
      style={style}
      aria-pressed={metronome.isPlaying}
      aria-label={label}
      title={label}
      data-source-line={dataSourceLine}
      onClick={() => metronome.toggle(bpm)}
    >
      {/* The button already supplies a complete accessible label via
          aria-label; hide the SVG from AT so screen readers do not
          announce "image: Metronome at N BPM" separately. */}
      <MetronomeGlyph bpm={bpm} className="meta-inline__glyph" aria-hidden />
      {value}
    </button>
  );
}
