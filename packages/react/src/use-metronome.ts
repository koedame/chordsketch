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

/**
 * Tempo used when a caller passes a non-finite / non-positive BPM.
 * Shared with `MetronomeGlyph`'s visual fallback so the audible and
 * visual defaults agree on "unparseable tempo → 60 BPM".
 */
const DEFAULT_BPM = 60;

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
  /**
   * Start ticking at `bpm` beats per minute. No-op if unsupported.
   * Calling `start` while already running re-arms at the new tempo,
   * so a host can keep the audible beat in sync with a live-edited
   * `{tempo}` directive.
   */
  start: (bpm: number) => void;
  /** Stop ticking. Safe to call when already stopped. */
  stop: () => void;
  /** Stop if currently playing, otherwise start at `bpm`. */
  toggle: (bpm: number) => void;
  /**
   * Synchronous "is the scheduler running?" read, backed by the
   * internal timer rather than the async `isPlaying` state. Use this
   * (not `isPlaying`) when deciding inside an effect/callback whether
   * to re-arm, so the decision is not made against a stale render's
   * state after the page-level coordinator stopped this instance.
   */
  isRunning: () => boolean;
}

type AudioContextCtor = new () => AudioContext;

/** Per-instance handle the module-level coordinator can stop. */
interface MetronomeController {
  stop: () => void;
}

// ---- Page-level shared audio resources -------------------------
// A page should use a single AudioContext: browsers cap concurrent
// contexts, and a song with several `{tempo}` chips would otherwise
// spawn one context per chip. A module-level coordinator also
// guarantees that starting one metronome stops any other so two
// chips never tick over each other. The context is created lazily
// on the first user gesture and lives for the page lifetime (the
// recommended Web Audio pattern — it is suspended, not closed, when
// idle, so it is cheap to keep around).

let sharedContext: AudioContext | null = null;
let activeController: MetronomeController | null = null;

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

/**
 * Lazily create (or reuse) the shared `AudioContext`. Returns `null`
 * when Web Audio is unavailable.
 */
function getSharedContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  sharedContext = new Ctor();
  return sharedContext;
}

/**
 * Reset the module-level shared audio state. **Test-only** — not
 * re-exported from the package index. Lets each test start from a
 * clean singleton after swapping the `window.AudioContext` stub.
 */
export function resetMetronomeSharedStateForTests(): void {
  sharedContext = null;
  activeController = null;
}

function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return DEFAULT_BPM;
  return Math.min(METRONOME_MAX_BPM, Math.max(METRONOME_MIN_BPM, bpm));
}

/**
 * Drive an audible metronome via the Web Audio API.
 *
 * The hook plays through a page-level shared `AudioContext` and a
 * lookahead scheduler. Ticks are scheduled directly on the audio
 * clock so the beat stays steady regardless of `setInterval`
 * jitter. The context is created on the first {@link UseMetronomeResult.start}
 * call (a user gesture) to satisfy browser autoplay policies. Only
 * one metronome plays at a time across the whole page; starting one
 * stops any other.
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextTickRef = useRef(0);
  const bpmRef = useRef(DEFAULT_BPM);
  // Oscillators already scheduled on the audio clock but not yet
  // played. Tracked so `stop` can silence ticks queued up to
  // `SCHEDULE_AHEAD_S` into the future instead of leaving trailing
  // clicks after the user stops.
  const oscillatorsRef = useRef<Set<OscillatorNode>>(new Set());
  const controllerRef = useRef<MetronomeController | null>(null);

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
    const tracked = oscillatorsRef.current;
    tracked.add(osc);
    osc.onended = () => {
      tracked.delete(osc);
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // Nodes may already be disconnected if `stop` raced ahead.
      }
    };
  }, []);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // Cancel ticks already queued on the audio clock so no trailing
    // click sounds after the user stops. A no-arg `stop()` cancels a
    // not-yet-started oscillator outright and cuts a sounding one
    // immediately.
    for (const osc of oscillatorsRef.current) {
      try {
        osc.stop();
      } catch {
        // Already stopped/ended — nothing to cancel.
      }
    }
    oscillatorsRef.current.clear();
    if (activeController === controllerRef.current) {
      activeController = null;
    }
    setIsPlaying(false);
  }, []);

  const start = useCallback(
    (bpm: number) => {
      const ctx = getSharedContext();
      if (!ctx) return;
      // A context left 'suspended' by the autoplay policy stays
      // silent until resumed; the `start` call is the authorising
      // user gesture.
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      bpmRef.current = clampBpm(bpm);

      // Single-active coordination: stop whatever other metronome is
      // running before this one takes over.
      if (activeController !== null && activeController !== controllerRef.current) {
        activeController.stop();
      }

      // Restarting (new tempo or fresh start): drop the old timer
      // and silence our own queued ticks so the re-arm does not
      // stack two schedulers or double-trigger the in-flight tick.
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
      for (const osc of oscillatorsRef.current) {
        try {
          osc.stop();
        } catch {
          // Already stopped/ended.
        }
      }
      oscillatorsRef.current.clear();

      nextTickRef.current = ctx.currentTime;
      const scheduler = () => {
        const period = 60 / bpmRef.current;
        while (nextTickRef.current < ctx.currentTime + SCHEDULE_AHEAD_S) {
          scheduleTick(ctx, nextTickRef.current);
          nextTickRef.current += period;
        }
      };
      // Schedule the first window synchronously so the click is
      // heard immediately on the gesture, then keep it fed.
      scheduler();
      timerRef.current = setInterval(scheduler, SCHEDULER_LOOKAHEAD_MS);
      activeController = controllerRef.current;
      setIsPlaying(true);
    },
    [scheduleTick],
  );

  const isRunning = useCallback(() => timerRef.current !== null, []);

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

  // Register this instance's stop handle for the module-level
  // coordinator. `stop` is stable (empty-dep `useCallback`), so the
  // controller object is created once.
  if (controllerRef.current === null) {
    controllerRef.current = { stop };
  }

  useEffect(() => {
    return () => {
      // Stop self on unmount. The shared context is intentionally
      // NOT closed — other live instances (and future mounts) reuse
      // it for the page lifetime.
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      for (const osc of oscillatorsRef.current) {
        try {
          osc.stop();
        } catch {
          // Already stopped/ended.
        }
      }
      oscillatorsRef.current.clear();
      if (activeController === controllerRef.current) {
        activeController = null;
      }
    };
  }, []);

  return { isPlaying, supported, start, stop, toggle, isRunning };
}
