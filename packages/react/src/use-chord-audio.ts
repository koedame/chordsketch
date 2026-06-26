import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  getAudioContextCtor,
  getPianoWave,
  getSharedAudioContext,
  scheduleStrummedChord,
  stopVoices,
} from './audio-context';
import { usePitchModule } from './use-pitch-module';

// A tapped chord sounds as a quick strum — a "jara-n" roll rather than a
// simultaneous "ja-n" stab — so it reads like an instrument being strummed
// (#2728). The roll spread and the per-voice piano envelope are the shared
// strum voicing owned by `scheduleStrummedChord` in `audio-context.ts`, so
// this surface and the key audition's tonic-triad strum roll identically;
// this hook supplies only the chord's pitches, the timbre, and the onset.

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

/**
 * Chord-audio (#2650) wiring threaded to the chord surfaces (chord-name
 * spans in the JSX walker, and chord diagrams via {@link ChordDiagram}).
 * When {@link ChordAudioConfig.enabled} is `true`, activating a rendered
 * chord (click / Enter / Space) sounds the chord via
 * {@link ChordAudioConfig.play}.
 *
 * Audio is additive, not a separate mode: it layers playback on top of
 * whatever interaction is already wired. With a selection consumer
 * present, clicking a chord both sounds it AND selects it for editing —
 * the editing panel stays usable while audio is on. With no selection
 * consumer (e.g. a preview-only host), the chord is a pure play button.
 *
 * Defined in this leaf module (not `chordpro-jsx`) so `<ChordDiagram>`
 * can depend on the type without importing the walker, which would form
 * an import cycle (the walker imports `<ChordDiagram>`). Re-exported from
 * `chordpro-jsx` so existing import paths keep resolving.
 */
export interface ChordAudioConfig {
  /** Whether chord-audio mode is active. */
  enabled: boolean;
  /** Sound the given raw chord name (e.g. `"Am7"`, `"C/G"`). */
  play: (chordName: string) => void;
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
   * Play the named chord (e.g. `"Am7"`, `"C/G"`) as a strummed chord — a
   * quick low-to-high roll, not a simultaneous stab. A no-op when Web
   * Audio is unavailable, the wasm module has not finished loading, or
   * the name is not a parseable chord. Playing a new chord cuts any chord
   * still ringing so rapid taps retrigger cleanly.
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

  // Preload the wasm module so `play` can resolve pitches synchronously
  // inside the user gesture (shared loader — see `usePitchModule`).
  const moduleRef = usePitchModule(loader, enabled, supported);

  // Per-name pitch cache: `chordPitches` is deterministic, so a chord
  // tapped repeatedly is computed once.
  const pitchCacheRef = useRef<Map<string, number[]>>(new Map());

  // Voices currently scheduled / sounding, tracked so `stop` (and
  // unmount) can silence them and a retrigger does not stack voices.
  const voicesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());

  const stop = useCallback(() => {
    stopVoices(voicesRef.current);
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

      // Strum the chord through the shared `scheduleStrummedChord`: it
      // staggers the voice onsets so the chord rolls ("jara-n") instead of
      // stabbing all at once, divides the peak across the voices, and owns
      // the per-voice envelope + node graph + cleanup (sister to the key
      // audition's tonic-triad strum). This hook supplies only the pitches,
      // the shared piano timbre, and the onset.
      scheduleStrummedChord(ctx, voicesRef.current, {
        pitches,
        wave: getPianoWave(ctx),
        startTime: ctx.currentTime,
      });
    },
    [stop],
  );

  // Silence on unmount; the shared context is intentionally NOT closed
  // (other live hooks reuse it for the page lifetime).
  useEffect(() => () => stop(), [stop]);

  return { supported, play, stop };
}
