// Page-level shared Web Audio resources.
//
// Browsers cap the number of concurrent `AudioContext`s, and creating
// one per hook instance (a metronome chip plus a chord-audio surface,
// say) would race that cap. This module owns a single lazily-created
// `AudioContext` that every audio hook in the package reuses for the
// page lifetime. The context is created on the first user gesture (to
// satisfy autoplay policies) and is suspended — not closed — when idle,
// the recommended Web Audio pattern, so it stays cheap to keep around.
//
// Extracted from `use-metronome.ts` (#2650) so `useMetronome` and
// `useChordAudio` share one context instead of spawning two.

type AudioContextCtor = new () => AudioContext;

let sharedContext: AudioContext | null = null;

/**
 * Resolve the platform `AudioContext` constructor, tolerating the legacy
 * `webkitAudioContext` prefix. Returns `null` under SSR or when neither is
 * present, so callers can branch on Web Audio support.
 */
export function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & {
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Lazily create (or reuse) the page-level shared `AudioContext`. Returns
 * `null` when Web Audio is unavailable.
 */
export function getSharedAudioContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  sharedContext = new Ctor();
  return sharedContext;
}

/**
 * Reset the module-level shared `AudioContext`.
 *
 * **Test-only** — not re-exported from the package index. Lets each test
 * start from a clean singleton after swapping the `window.AudioContext`
 * stub.
 *
 * @internal
 */
export function resetSharedAudioContextForTests(): void {
  sharedContext = null;
}

/** Parameters describing a single scheduled oscillator voice. */
export interface VoiceSpec {
  /** Oscillator waveform. */
  type: OscillatorType;
  /** Frequency in Hz. */
  frequency: number;
  /** Audio-clock time (seconds) at which the voice starts. */
  startTime: number;
  /**
   * Attack time in seconds. `0` jumps straight to {@link VoiceSpec.peak}
   * at onset (a percussive click); a positive value ramps up to the peak,
   * avoiding the click a hard onset would make.
   */
  attack: number;
  /** Seconds from {@link VoiceSpec.startTime} to the decay-to-silence end. */
  release: number;
  /** Peak gain for this voice. */
  peak: number;
  /**
   * Extra seconds held after {@link VoiceSpec.release} before the
   * oscillator is stopped. `0` stops exactly at the release end (the
   * metronome's tight click); a small tail lets a sustained voice's
   * exponential tail finish inaudibly.
   */
  tail: number;
}

/**
 * Schedule a single oscillator + gain voice on `ctx` per `spec`, register
 * it in `tracked`, and wire `onended` cleanup (remove from `tracked`,
 * disconnect the nodes). Shared by `useMetronome` and `useChordAudio` so
 * the envelope shape, node graph, and cleanup race-handling live in one
 * place rather than being duplicated across both hooks.
 *
 * The gain envelope uses `exponentialRampToValueAtTime` toward a tiny
 * non-zero floor (Web Audio rejects a `0` target).
 */
export function scheduleVoice(
  ctx: AudioContext,
  tracked: Set<OscillatorNode>,
  spec: VoiceSpec,
): void {
  const { type, frequency, startTime, attack, release, peak, tail } = spec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);
  if (attack > 0) {
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peak, startTime + attack);
  } else {
    // Percussive onset: jump to the peak immediately.
    gain.gain.setValueAtTime(peak, startTime);
  }
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + release);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + release + tail);
  tracked.add(osc);
  osc.onended = () => {
    tracked.delete(osc);
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      // Nodes may already be disconnected if a stop() raced ahead.
    }
  };
}

/**
 * Stop every oscillator tracked in `tracked` and clear the set. A no-arg
 * `osc.stop()` cancels a not-yet-started voice outright and cuts a sounding
 * one immediately; the per-voice `onended` cleanup (wired by
 * {@link scheduleVoice}) removes each node from the set, but this also
 * clears eagerly so a caller can reuse the set immediately.
 *
 * Shared by `useChordAudio`, `useKeyAudio`, and `useMetronome` so the
 * stop-and-clear race handling lives in one place.
 */
export function stopVoices(tracked: Set<OscillatorNode>): void {
  for (const osc of tracked) {
    try {
      osc.stop();
    } catch {
      // Already stopped / ended — nothing to cancel.
    }
  }
  tracked.clear();
}
