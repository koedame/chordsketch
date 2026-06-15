import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Lowest / highest BPM the metronome will tick at. Values outside
 * this range are clamped rather than rejected so a typo'd
 * `{tempo: 99999}` directive does not produce an inaudible strobe
 * (or, at the low end, a tick so sparse the page feels frozen).
 * The range brackets the conventional metronome dial (Maelzel
 * metronomes run ~40–208 BPM); we widen it slightly so unusual but
 * legitimate tempos still play.
 */
export const METRONOME_MIN_BPM = 20;
/** See {@link METRONOME_MIN_BPM}. */
export const METRONOME_MAX_BPM = 400;

// Audio tick shape. A short percussive square-wave blip reads as a
// metronome "click" without shipping an audio sample asset.
const TICK_FREQUENCY_HZ = 1000;
const TICK_DURATION_S = 0.04;
const TICK_PEAK_GAIN = 0.3;

// Lookahead scheduler tuning (after Chris Wilson's "A Tale of Two
// Clocks"). `setInterval` only needs to wake often enough to keep
// the Web Audio clock fed `SCHEDULE_AHEAD_S` into the future; the
// precise tick timing comes from `AudioContext.currentTime`, not
// from the timer, so timer jitter does not smear the beat.
const SCHEDULER_LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.12;

/** Result of {@link useMetronome}. */
export interface UseMetronomeResult {
  /** Whether the metronome is currently ticking. */
  readonly isPlaying: boolean;
  /**
   * Whether the Web Audio API is available in the current
   * environment. `false` under SSR or in a browser without
   * `AudioContext`; callers should fall back to a non-interactive
   * presentation rather than rendering a dead control.
   */
  readonly supported: boolean;
  /** Start ticking at `bpm` beats per minute. No-op if unsupported. */
  start: (bpm: number) => void;
  /** Stop ticking. Safe to call when already stopped. */
  stop: () => void;
  /** Stop if currently playing, otherwise start at `bpm`. */
  toggle: (bpm: number) => void;
}

type AudioContextCtor = new () => AudioContext;

/**
 * Resolve the platform `AudioContext` constructor, tolerating the
 * legacy `webkitAudioContext` prefix. Returns `null` under SSR or
 * when neither is present so callers can branch on support.
 */
function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & {
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 60;
  return Math.min(METRONOME_MAX_BPM, Math.max(METRONOME_MIN_BPM, bpm));
}

/**
 * Drive an audible metronome via the Web Audio API.
 *
 * The hook owns a single lazily-created `AudioContext` and a
 * lookahead scheduler. Ticks are scheduled directly on the audio
 * clock so the beat stays steady regardless of `setInterval`
 * jitter. The context is created on the first {@link UseMetronomeResult.start}
 * call (a user gesture) to satisfy browser autoplay policies, and
 * is closed when the host component unmounts.
 *
 * @example
 * ```tsx
 * const metronome = useMetronome();
 * return (
 *   <button onClick={() => metronome.toggle(120)} aria-pressed={metronome.isPlaying}>
 *     {metronome.isPlaying ? 'Stop' : 'Play'}
 *   </button>
 * );
 * ```
 */
export function useMetronome(): UseMetronomeResult {
  const [isPlaying, setIsPlaying] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextTickRef = useRef(0);
  const bpmRef = useRef(60);

  const supported = useMemo(() => getAudioContextCtor() !== null, []);

  const scheduleTick = useCallback((ctx: AudioContext, time: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(TICK_FREQUENCY_HZ, time);
    // Percussive envelope: jump to peak at the tick onset, then
    // decay exponentially toward (but never to) zero — Web Audio's
    // `exponentialRampToValueAtTime` rejects a 0 target.
    gain.gain.setValueAtTime(TICK_PEAK_GAIN, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + TICK_DURATION_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + TICK_DURATION_S);
  }, []);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const start = useCallback(
    (bpm: number) => {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return;
      let ctx = ctxRef.current;
      if (!ctx) {
        ctx = new Ctor();
        ctxRef.current = ctx;
      }
      // A context created (or left) in the `suspended` state by the
      // browser's autoplay policy stays silent until resumed; the
      // `start` call is the user gesture that authorises playback.
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      bpmRef.current = clampBpm(bpm);

      // Restarting at a new tempo while already running: drop the
      // old timer so we do not stack two schedulers feeding the
      // same context.
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
      nextTickRef.current = ctx.currentTime;
      const scheduler = () => {
        const c = ctxRef.current;
        if (!c) return;
        const period = 60 / bpmRef.current;
        while (nextTickRef.current < c.currentTime + SCHEDULE_AHEAD_S) {
          scheduleTick(c, nextTickRef.current);
          nextTickRef.current += period;
        }
      };
      // Schedule the first window synchronously so the click is
      // heard immediately on the gesture, then keep it fed.
      scheduler();
      timerRef.current = setInterval(scheduler, SCHEDULER_LOOKAHEAD_MS);
      setIsPlaying(true);
    },
    [scheduleTick],
  );

  const toggle = useCallback(
    (bpm: number) => {
      // `timerRef` is the single source of truth for "running" — it
      // is set synchronously inside `start`/`stop`, so a rapid
      // double-click toggles correctly even before the `isPlaying`
      // state update has flushed.
      if (timerRef.current !== null) {
        stop();
      } else {
        start(bpm);
      }
    },
    [start, stop],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== 'closed') {
        void ctx.close();
      }
      ctxRef.current = null;
    };
  }, []);

  return { isPlaying, supported, start, stop, toggle };
}
