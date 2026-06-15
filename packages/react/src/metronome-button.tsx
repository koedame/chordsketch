import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';

import { MetronomeGlyph, metronomePeriodCss, tempoMarkingFor } from './music-glyphs';
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
    // Non-interactive fallback: the BPM + marking are carried by the
    // visible `value` text, so the glyph is decorative — hide it from
    // AT to avoid announcing the tempo twice ("Metronome at N BPM"
    // then "N BPM (marking)").
    return (
      <span className={className} data-source-line={dataSourceLine}>
        <MetronomeGlyph bpm={bpm} className="meta-inline__glyph" aria-hidden />
        {value}
      </span>
    );
  }

  // Fold the Italian marking into the label so AT users still hear it
  // — the button's aria-label overrides the inner readout text, which
  // is the only other place the marking is exposed.
  const tempoText = marking != null ? `${bpm} BPM, ${marking}` : `${bpm} BPM`;
  const label = metronome.isPlaying
    ? `Stop metronome (${tempoText})`
    : `Play metronome at ${tempoText}`;
  // The frame-pulse period (shared clamp with the pendulum swing) is
  // published as a CSS custom property the `cs-tempo-frame` keyframes
  // consume. The cast keeps CSSProperties happy (custom props aren't
  // typed).
  const style: CSSProperties = {
    ['--cs-metronome-period' as string]: metronomePeriodCss(bpm),
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
