import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { MetronomeGlyph } from './music-glyphs';
import { useMetronome } from './use-metronome';

/** Props for {@link MetronomeButton}. */
export interface MetronomeButtonProps {
  /** Beats per minute, parsed from the `{tempo}` directive. */
  bpm: number;
  /** Extra class applied to the rendered control / glyph slot. */
  className?: string;
}

/**
 * Interactive metronome icon for the inline `{tempo}` chip.
 *
 * Clicking the icon toggles an audible metronome (via
 * {@link useMetronome}) ticking at the directive's BPM; the cursor
 * turns into a speaker on hover so the affordance is discoverable.
 * When the Web Audio API is unavailable — SSR, or a browser without
 * `AudioContext` — it degrades to the plain decorative
 * {@link MetronomeGlyph} so no dead control is rendered.
 *
 * The interactive upgrade is deferred to a post-mount effect so the
 * server-rendered markup (static glyph) matches the client's first
 * render and React does not report a hydration mismatch.
 */
export function MetronomeButton({ bpm, className }: MetronomeButtonProps): JSX.Element {
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

  const glyphClass = ['meta-inline__glyph', className].filter(Boolean).join(' ');

  if (!interactive) {
    return <MetronomeGlyph bpm={bpm} className={glyphClass} />;
  }

  const label = metronome.isPlaying
    ? `Stop metronome (${bpm} BPM)`
    : `Play metronome at ${bpm} BPM`;

  return (
    <button
      type="button"
      className={[
        'meta-inline__metronome-button',
        metronome.isPlaying ? 'is-playing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={metronome.isPlaying}
      aria-label={label}
      title={label}
      onClick={() => metronome.toggle(bpm)}
    >
      <MetronomeGlyph bpm={bpm} className={glyphClass} />
    </button>
  );
}
