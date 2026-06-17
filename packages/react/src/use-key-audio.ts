import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  getAudioContextCtor,
  getPianoWave,
  getSharedAudioContext,
  midiToFreq,
  scheduleVoice,
  stopVoices,
} from './audio-context';
import { usePitchModule } from './use-pitch-module';

// ---- Voicing / envelope tuning ---------------------------------
// A key audition is two phases: the scale played one note at a time
// (do re mi fa sol la ti do), then the tonic triad strummed as a
// block "jara-n". Both phases sound with the shared piano `PeriodicWave`
// (#2668): the scale notes are short, struck blips; the final triad
// rings on a long, no-sustain decay.
const NOTE_STEP_S = 0.16; // time between consecutive scale-note onsets
const NOTE_ATTACK_S = 0.006;
const NOTE_RELEASE_S = 0.34; // each scale note decays past the next onset
const NOTE_PEAK_GAIN = 0.2;
const NOTE_TAIL_S = 0.05;
// Pause between the last scale note's onset and the triad strum.
// Doubled from 0.12 to give a clearer breath before the "jara-n"
// lands (#2660).
const SCALE_TO_CHORD_GAP_S = 0.24;
// Per-note delay across the triad so it reads as a strum, not a stab.
const STRUM_OFFSET_S = 0.035;
const CHORD_ATTACK_S = 0.006;
const CHORD_RELEASE_S = 2.6;
const CHORD_PEAK_GAIN = 0.22;
const CHORD_TAIL_S = 0.05;

/**
 * Minimal structural view of the `@chordsketch/wasm` surface this hook
 * touches. Kept structural (not an import of the wasm glue types) so the
 * React package does not drag the wasm module into its type graph — the
 * module is dynamically imported at runtime. Mirrors the `keyScalePitches`
 * / `keyTonicTriad` exports added in #2658.
 */
interface KeyAudioModule {
  default: () => Promise<unknown>;
  /**
   * MIDI note numbers for the ascending one-octave scale of `key`
   * (do re mi fa sol la ti do), or `undefined` when the string is not
   * parseable as a key. Sister to `chordsketch_chordpro::key_scale_pitches`.
   */
  keyScalePitches: (key: string) => Uint8Array | null | undefined;
  /**
   * MIDI note numbers for the tonic triad of `key` (do mi sol), or
   * `undefined` when the string is not parseable as a key. Sister to
   * `chordsketch_chordpro::key_tonic_triad`.
   */
  keyTonicTriad: (key: string) => Uint8Array | null | undefined;
}

/**
 * WASM loader injected by tests. Production callers take the default,
 * which lazy-loads `@chordsketch/wasm`.
 *
 * @internal
 */
export type KeyAudioWasmLoader = () => Promise<KeyAudioModule>;

// Two-step cast through `unknown` — the wasm module's generated types,
// resolved against the JS bundle host bundlers see, do not formally
// include `keyScalePitches` / `keyTonicTriad`'s typed signatures even
// though the exports are present at runtime. The `KeyAudioModule` shape
// models the runtime contract; the runtime test against a stubbed loader
// is what guards it.
const defaultLoader: KeyAudioWasmLoader = () =>
  import('@chordsketch/wasm') as unknown as Promise<KeyAudioModule>;

/** A key's auditioned pitches: its scale then its tonic triad. */
interface KeyPitches {
  scale: number[];
  triad: number[];
}

/** Result of {@link useKeyAudio}. */
export interface UseKeyAudioResult {
  /**
   * Whether the Web Audio API is available in the current environment.
   * `false` under SSR or in a browser without `AudioContext`; callers
   * should fall back to a non-interactive presentation rather than
   * rendering a dead control.
   */
  readonly supported: boolean;
  /**
   * Audition the named key (e.g. `"C"`, `"Am"`, `"Bb"`, `"F#m"`): play
   * its scale ascending one note at a time, then strum its tonic triad.
   * A no-op when Web Audio is unavailable, the wasm module has not
   * finished loading, or the name is not a parseable key. Playing a new
   * audition cuts any audition still ringing so rapid taps retrigger
   * cleanly.
   */
  play: (keyName: string) => void;
  /** Silence any currently-ringing audition. Safe to call when silent. */
  stop: () => void;
}

/**
 * Audition a musical key through the Web Audio API: the movable-do scale
 * "do re mi fa sol la ti do" followed by the tonic triad "do mi sol"
 * strummed. Major and minor keys are both supported — the
 * `@chordsketch/wasm` core picks the major or natural-minor scale and the
 * major or minor triad from the `{key}` value.
 *
 * The pitches are computed by `@chordsketch/wasm`'s `keyScalePitches` /
 * `keyTonicTriad` exports (sisters to `chordsketch_chordpro::key_scale_pitches`
 * / `key_tonic_triad`) — the musical-theory source of truth lives in the
 * core library, not here (see `.claude/rules/playground-is-a-sample.md`).
 * This hook only turns those MIDI note numbers into sound and owns the
 * audition's *sequencing* (scale, pause, strum), sharing the page-level
 * `AudioContext` with {@link useMetronome} / {@link useChordAudio} via
 * `audio-context.ts`.
 *
 * The wasm module is preloaded so {@link UseKeyAudioResult.play} can run
 * synchronously inside the click / keydown gesture that browser autoplay
 * policies require. Pass `enabled = false` to defer that import.
 *
 * @example
 * ```tsx
 * const audio = useKeyAudio();
 * return (
 *   <button onClick={() => audio.play('Am')} disabled={!audio.supported}>
 *     Play A minor
 *   </button>
 * );
 * ```
 */
export function useKeyAudio(
  loader: KeyAudioWasmLoader = defaultLoader,
  enabled = true,
): UseKeyAudioResult {
  const supported = useMemo(() => getAudioContextCtor() !== null, []);

  // Preload the wasm module so `play` can resolve pitches synchronously
  // inside the user gesture (shared loader — see `usePitchModule`).
  const moduleRef = usePitchModule(loader, enabled, supported);

  // Per-key pitch cache: the lookups are deterministic, so a key
  // auditioned repeatedly is computed once.
  const pitchCacheRef = useRef<Map<string, KeyPitches>>(new Map());

  // Voices currently scheduled / sounding, tracked so `stop` (and
  // unmount) can silence them and a retrigger does not stack voices.
  const voicesRef = useRef<Set<AudioScheduledSourceNode>>(new Set());

  const stop = useCallback(() => {
    stopVoices(voicesRef.current);
  }, []);

  const play = useCallback(
    (keyName: string) => {
      const mod = moduleRef.current;
      const ctx = getSharedAudioContext();
      if (!ctx || !mod) return;
      // A context left 'suspended' by the autoplay policy stays silent
      // until resumed; this play() call is the authorising user gesture.
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      let pitches = pitchCacheRef.current.get(keyName);
      if (!pitches) {
        const scaleRaw = mod.keyScalePitches(keyName);
        const triadRaw = mod.keyTonicTriad(keyName);
        pitches = {
          scale: scaleRaw ? Array.from(scaleRaw) : [],
          triad: triadRaw ? Array.from(triadRaw) : [],
        };
        pitchCacheRef.current.set(keyName, pitches);
      }
      // Both lookups derive from the same parse, so they succeed or fail
      // together; bail if the key was not parseable. The triad check is
      // also what guards the `CHORD_PEAK_GAIN / triad.length` division
      // below from a zero divisor (sister to `useChordAudio`'s own
      // empty-pitch guard), should a future core change ever let the two
      // lookups diverge.
      if (pitches.scale.length === 0 || pitches.triad.length === 0) return;

      // Cut any audition still ringing so a fresh tap retriggers cleanly.
      stop();

      const now = ctx.currentTime;
      const wave = getPianoWave(ctx);
      // Scale: one note per `NOTE_STEP_S`, each a short struck piano blip.
      pitches.scale.forEach((midi, i) => {
        scheduleVoice(ctx, voicesRef.current, {
          type: wave,
          frequency: midiToFreq(midi),
          startTime: now + i * NOTE_STEP_S,
          attack: NOTE_ATTACK_S,
          release: NOTE_RELEASE_S,
          peak: NOTE_PEAK_GAIN,
          tail: NOTE_TAIL_S,
        });
      });

      // Triad strum after the scale: divide the peak across the voices so
      // the block does not clip, and stagger the onsets for a "jara-n".
      const chordStart =
        now + pitches.scale.length * NOTE_STEP_S + SCALE_TO_CHORD_GAP_S;
      const perVoice = CHORD_PEAK_GAIN / pitches.triad.length;
      pitches.triad.forEach((midi, j) => {
        scheduleVoice(ctx, voicesRef.current, {
          type: wave,
          frequency: midiToFreq(midi),
          startTime: chordStart + j * STRUM_OFFSET_S,
          attack: CHORD_ATTACK_S,
          release: CHORD_RELEASE_S,
          peak: perVoice,
          tail: CHORD_TAIL_S,
        });
      });
    },
    // `moduleRef` / `pitchCacheRef` / `voicesRef` are stable refs; `stop`
    // is the only reactive dependency (parity with `useChordAudio`).
    [stop],
  );

  // Silence on unmount; the shared context is intentionally NOT closed
  // (other live hooks reuse it for the page lifetime).
  useEffect(() => () => stop(), [stop]);

  return { supported, play, stop };
}
