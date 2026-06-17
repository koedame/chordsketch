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
// `useChordAudio` share one context instead of spawning two. The piano
// timbre + woodblock click synthesis (#2668) also lives here so all
// three audio hooks share one waveform / noise table and one
// node-graph cleanup path.

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
 * stub. The per-context piano-wave / noise caches are keyed on the
 * `AudioContext` instance (see {@link getPianoWave}), so a fresh context
 * regenerates them without any extra reset wiring here.
 *
 * @internal
 */
export function resetSharedAudioContextForTests(): void {
  sharedContext = null;
}

/**
 * MIDI note number → frequency in Hz (A4 = MIDI 69 = 440 Hz). Shared by
 * the pitch-driven audio hooks (`useChordAudio`, `useKeyAudio`) that feed
 * {@link scheduleVoice} a frequency.
 */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// ---- Piano timbre ----------------------------------------------
// A piano tone is a near-harmonic spectrum with energy concentrated in
// the fundamental and the first few partials, falling off quickly. These
// cosine (real-part) amplitudes — index 0 is the DC term (always 0), then
// the fundamental and partials 2..7 — approximate that roll-off so the
// synthesized voice reads as a struck-string keyboard rather than the
// hollow `triangle` it replaced (#2668). With a percussive, no-sustain
// gain envelope (fast attack, long exponential decay; supplied by the
// calling hook) the result is recognisably piano-like without shipping a
// sampled instrument.
const PIANO_PARTIAL_AMPLITUDES = [0, 1, 0.55, 0.32, 0.18, 0.1, 0.06, 0.03];

// One `PeriodicWave` / noise `AudioBuffer` per context. `createPeriodicWave`
// and `createBuffer` allocate, and both tables are deterministic, so they
// are computed once and reused for the context's lifetime. A `WeakMap`
// keyed on the context means a fresh context (e.g. after a test reset)
// regenerates them and a discarded context's tables are collected with it.
const pianoWaveCache = new WeakMap<BaseAudioContext, PeriodicWave>();
const noiseBufferCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/**
 * The shared piano-timbre {@link PeriodicWave} for `ctx`, created on first
 * use and cached per context. Both `useChordAudio` and `useKeyAudio` pass
 * the returned wave as {@link VoiceSpec.type} so every pitch-driven voice
 * sounds with the same instrument.
 */
export function getPianoWave(ctx: BaseAudioContext): PeriodicWave {
  const cached = pianoWaveCache.get(ctx);
  if (cached) return cached;
  const real = new Float32Array(PIANO_PARTIAL_AMPLITUDES);
  // No sine (imaginary) components: a cosine-only spectrum is enough for
  // the timbre, and the phase of the partials is inaudible here.
  const imag = new Float32Array(real.length);
  const wave = ctx.createPeriodicWave(real, imag, {
    disableNormalization: false,
  });
  pianoWaveCache.set(ctx, wave);
  return wave;
}

// ---- Woodblock click (metronome) -------------------------------
// A mechanical-metronome / woodblock click is a short noise transient
// (the wooden "attack") plus a brief pitched body (the resonant "tock").
// Synthesizing it from filtered noise + a sine body avoids shipping an
// audio sample while reading as an acoustic click rather than the
// electronic `square`-wave beep it replaced (#2668). The click is uniform
// on every tick — the metronome does not track beats, so there is no
// downbeat accent (not every song is in 4/4).
const NOISE_BUFFER_S = 0.1;
const WOODBLOCK_NOISE_BANDPASS_HZ = 2000;
const WOODBLOCK_NOISE_Q = 6;
const WOODBLOCK_NOISE_PEAK_GAIN = 0.5;
const WOODBLOCK_NOISE_DECAY_S = 0.03;
const WOODBLOCK_NOISE_TAIL_S = 0.02;
const WOODBLOCK_BODY_HZ = 1300;
const WOODBLOCK_BODY_PEAK_GAIN = 0.28;
const WOODBLOCK_BODY_DECAY_S = 0.045;

/**
 * The shared white-noise {@link AudioBuffer} for `ctx`, created on first
 * use and cached per context. Drives the woodblock click's noise
 * transient (see {@link scheduleWoodblockTick}).
 */
function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBufferCache.get(ctx);
  if (cached) return cached;
  const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_S));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  noiseBufferCache.set(ctx, buffer);
  return buffer;
}

/** Parameters describing a single scheduled oscillator voice. */
export interface VoiceSpec {
  /**
   * Oscillator waveform: a built-in {@link OscillatorType} (e.g.
   * `'sine'`) or a custom {@link PeriodicWave} (e.g. the shared piano
   * timbre from {@link getPianoWave}).
   */
  type: OscillatorType | PeriodicWave;
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
 * Distinguish a custom {@link PeriodicWave} from a built-in
 * {@link OscillatorType} in {@link VoiceSpec.type}. A `typeof` check (not
 * `instanceof PeriodicWave`) keeps this working under jsdom / SSR where the
 * `PeriodicWave` constructor may be absent; the type predicate lets the
 * caller's `else` branch narrow to `OscillatorType` without a cast.
 */
function isPeriodicWave(
  type: OscillatorType | PeriodicWave,
): type is PeriodicWave {
  return typeof type !== 'string';
}

/**
 * Register `source` in `tracked` and wire `onended` cleanup: remove it
 * from the set and disconnect both the source and every node in
 * `cleanupNodes` (the gain / filter chain it feeds). Shared by
 * {@link scheduleVoice} and {@link scheduleWoodblockTick} so the
 * tracking + teardown race-handling lives in one place regardless of
 * whether the source is an `OscillatorNode` or an `AudioBufferSourceNode`.
 */
function finalizeSource(
  source: AudioScheduledSourceNode,
  cleanupNodes: AudioNode[],
  tracked: Set<AudioScheduledSourceNode>,
): void {
  tracked.add(source);
  source.onended = () => {
    tracked.delete(source);
    try {
      source.disconnect();
      for (const node of cleanupNodes) node.disconnect();
    } catch {
      // Nodes may already be disconnected if a stop() raced ahead.
    }
  };
}

/**
 * Schedule a single oscillator + gain voice on `ctx` per `spec`, register
 * it in `tracked`, and wire `onended` cleanup. Shared by `useMetronome`,
 * `useChordAudio`, and `useKeyAudio` so the envelope shape, node graph,
 * and cleanup race-handling live in one place rather than being
 * duplicated across the hooks.
 *
 * The gain envelope uses `exponentialRampToValueAtTime` toward a tiny
 * non-zero floor (Web Audio rejects a `0` target).
 */
export function scheduleVoice(
  ctx: BaseAudioContext,
  tracked: Set<AudioScheduledSourceNode>,
  spec: VoiceSpec,
): void {
  const { type, frequency, startTime, attack, release, peak, tail } = spec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  if (isPeriodicWave(type)) {
    osc.setPeriodicWave(type);
  } else {
    osc.type = type;
  }
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
  finalizeSource(osc, [gain], tracked);
}

/**
 * Schedule one woodblock metronome click on `ctx` at `startTime`,
 * registering its source nodes in `tracked`. The click is a band-pass-
 * filtered white-noise transient (the wooden attack) layered with a short
 * pitched sine body (the resonant "tock"), so it reads as an acoustic
 * click rather than an electronic beep. Every tick is identical — there
 * is no downbeat accent (#2668).
 *
 * The pitched body is scheduled through {@link scheduleVoice} so it shares
 * the same envelope + cleanup path; the noise transient is built here
 * because it needs an `AudioBufferSourceNode` + `BiquadFilterNode` rather
 * than an oscillator.
 */
export function scheduleWoodblockTick(
  ctx: BaseAudioContext,
  tracked: Set<AudioScheduledSourceNode>,
  startTime: number,
): void {
  // Pitched body: a short percussive sine, via the shared voice path.
  scheduleVoice(ctx, tracked, {
    type: 'sine',
    frequency: WOODBLOCK_BODY_HZ,
    startTime,
    attack: 0,
    release: WOODBLOCK_BODY_DECAY_S,
    peak: WOODBLOCK_BODY_PEAK_GAIN,
    tail: 0,
  });

  // Noise transient: white noise → band-pass → fast-decaying gain. This is
  // what gives the click its wooden character.
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.setValueAtTime(WOODBLOCK_NOISE_BANDPASS_HZ, startTime);
  bandpass.Q.setValueAtTime(WOODBLOCK_NOISE_Q, startTime);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(WOODBLOCK_NOISE_PEAK_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startTime + WOODBLOCK_NOISE_DECAY_S,
  );
  noise.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(ctx.destination);
  noise.start(startTime);
  noise.stop(startTime + WOODBLOCK_NOISE_DECAY_S + WOODBLOCK_NOISE_TAIL_S);
  finalizeSource(noise, [bandpass, gain], tracked);
}

/**
 * Stop every source tracked in `tracked` and clear the set. A no-arg
 * `source.stop()` cancels a not-yet-started voice outright and cuts a
 * sounding one immediately; the per-source `onended` cleanup (wired by
 * {@link finalizeSource}) removes each node from the set, but this also
 * clears eagerly so a caller can reuse the set immediately.
 *
 * Shared by `useChordAudio`, `useKeyAudio`, and `useMetronome` so the
 * stop-and-clear race handling lives in one place. The set holds both
 * `OscillatorNode`s (pitch voices, woodblock body) and
 * `AudioBufferSourceNode`s (the woodblock noise transient); both satisfy
 * `AudioScheduledSourceNode`, so one helper silences either kind.
 *
 * The eager `clear()` and the later-firing per-source `onended`
 * (`tracked.delete(source)`, wired by {@link finalizeSource}) cannot
 * cross-delete: `delete` keys on the node's own identity, so a stopped
 * voice's late `onended` only ever removes itself, never a voice a fresh
 * `play()` added to the reused set afterwards.
 */
export function stopVoices(tracked: Set<AudioScheduledSourceNode>): void {
  for (const source of tracked) {
    try {
      source.stop();
    } catch {
      // Already stopped / ended — nothing to cancel.
    }
  }
  tracked.clear();
}
