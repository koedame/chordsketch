import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  getAudioContextCtor,
  getSharedAudioContext,
  scheduleVoice,
} from './audio-context';

// ---- Voicing / envelope tuning ---------------------------------
// A block chord is several oscillators started at once. The total
// peak gain is divided across the voices so a six-note chord does not
// clip; a short attack avoids the click a hard onset would make, and a
// long exponential release lets the chord ring and decay naturally.
const ATTACK_S = 0.008;
const RELEASE_S = 1.4;
const PEAK_GAIN = 0.22;

/**
 * Minimal structural view of the `@chordsketch/wasm` surface this hook
 * touches. Kept structural (not an import of the wasm glue types) so the
 * React package does not drag the wasm module into its type graph — the
 * module is dynamically imported at runtime. Mirrors the
 * `chordPitches` export added in #2650.
 */
interface ChordPitchesModule {
  default: () => Promise<unknown>;
  /**
   * MIDI note numbers for a block voicing of `chord`, or `undefined`
   * when the string is not parseable as a chord. Sister to
   * `chordsketch_chordpro::chord_pitches`.
   */
  chordPitches: (chord: string) => Uint8Array | null | undefined;
}

/**
 * WASM loader injected by tests. Production callers take the default,
 * which lazy-loads `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordAudioWasmLoader = () => Promise<ChordPitchesModule>;

// Two-step cast through `unknown` — the wasm module's generated types,
// resolved against the JS bundle host bundlers see, do not formally
// include `chordPitches`'s typed signature even though the export is
// present at runtime. The `ChordPitchesModule` shape models the runtime
// contract; the runtime test against a stubbed loader is what guards it.
const defaultLoader: ChordAudioWasmLoader = () =>
  import('@chordsketch/wasm') as unknown as Promise<ChordPitchesModule>;

/** MIDI note number → frequency in Hz (A4 = MIDI 69 = 440 Hz). */
function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Result of {@link useChordAudio}. */
export interface UseChordAudioResult {
  /**
   * Whether the Web Audio API is available in the current environment.
   * `false` under SSR or in a browser without `AudioContext`; callers
   * should fall back to a non-interactive presentation rather than
   * rendering a dead control.
   */
  readonly supported: boolean;
  /**
   * Play the named chord (e.g. `"Am7"`, `"C/G"`) as a block chord. A
   * no-op when Web Audio is unavailable, the wasm module has not
   * finished loading, or the name is not a parseable chord. Playing a
   * new chord cuts any chord still ringing so rapid taps retrigger
   * cleanly.
   */
  play: (chordName: string) => void;
  /** Silence any currently-ringing chord. Safe to call when silent. */
  stop: () => void;
}

/**
 * Audition a single chord through the Web Audio API.
 *
 * The chord's constituent pitches are computed by
 * `@chordsketch/wasm`'s `chordPitches` export (sister to
 * `chordsketch_chordpro::chord_pitches`) — the musical-theory source of
 * truth lives in the core library, not here (see
 * `.claude/rules/playground-is-a-sample.md`). This hook only turns those
 * MIDI note numbers into sound, sharing the page-level `AudioContext`
 * with {@link useMetronome} via `audio-context.ts`.
 *
 * The wasm module is preloaded so {@link UseChordAudioResult.play} can run
 * synchronously inside the click / keydown gesture that browser autoplay
 * policies require. Pass `enabled = false` to defer that import until the
 * consumer actually turns chord audio on (the hook is still called
 * unconditionally, per the rules of hooks).
 *
 * @example
 * ```tsx
 * const audio = useChordAudio();
 * return (
 *   <button onClick={() => audio.play('Am7')} disabled={!audio.supported}>
 *     Play Am7
 *   </button>
 * );
 * ```
 */
export function useChordAudio(
  loader: ChordAudioWasmLoader = defaultLoader,
  enabled = true,
): UseChordAudioResult {
  const supported = useMemo(() => getAudioContextCtor() !== null, []);

  const moduleRef = useRef<ChordPitchesModule | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // Per-name pitch cache: `chordPitches` is deterministic, so a chord
  // tapped repeatedly is computed once.
  const pitchCacheRef = useRef<Map<string, number[]>>(new Map());

  // Oscillators currently scheduled / sounding, tracked so `stop` (and
  // unmount) can silence them and a retrigger does not stack voices.
  const voicesRef = useRef<Set<OscillatorNode>>(new Set());

  // Preload the wasm module so `play` can resolve pitches synchronously
  // inside the user gesture. Gated on `enabled` so a `<ChordSheet>` that
  // never turns chord audio on does not pay the import; the load fires
  // the first time a consumer enables the feature. If the load fails,
  // `moduleRef` stays null and `play` is a no-op rather than throwing.
  useEffect(() => {
    if (!supported || !enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await loaderRef.current();
        await mod.default();
        if (!cancelled) moduleRef.current = mod;
      } catch {
        // Leave moduleRef null; play() degrades to a no-op.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, enabled]);

  const stop = useCallback(() => {
    for (const osc of voicesRef.current) {
      try {
        osc.stop();
      } catch {
        // Already stopped / ended.
      }
    }
    voicesRef.current.clear();
  }, []);

  const play = useCallback(
    (chordName: string) => {
      const mod = moduleRef.current;
      const ctx = getSharedAudioContext();
      if (!ctx || !mod) return;
      // A context left 'suspended' by the autoplay policy stays silent
      // until resumed; this play() call is the authorising user gesture.
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      let pitches = pitchCacheRef.current.get(chordName);
      if (!pitches) {
        const raw = mod.chordPitches(chordName);
        pitches = raw ? Array.from(raw) : [];
        pitchCacheRef.current.set(chordName, pitches);
      }
      if (pitches.length === 0) return;

      // Cut any chord still ringing so a fresh tap retriggers cleanly.
      stop();

      const now = ctx.currentTime;
      // Divide the peak across the voices so a six-note chord does not
      // clip; a soft attack avoids a click and the long release lets the
      // chord ring. The shared `scheduleVoice` owns the node graph +
      // cleanup (sister to the metronome's tick scheduling).
      const perVoice = PEAK_GAIN / pitches.length;
      for (const midi of pitches) {
        scheduleVoice(ctx, voicesRef.current, {
          type: 'triangle',
          frequency: midiToFreq(midi),
          startTime: now,
          attack: ATTACK_S,
          release: RELEASE_S,
          peak: perVoice,
          tail: 0.05,
        });
      }
    },
    [stop],
  );

  // Silence on unmount; the shared context is intentionally NOT closed
  // (other live hooks reuse it for the page lifetime).
  useEffect(() => () => stop(), [stop]);

  return { supported, play, stop };
}
