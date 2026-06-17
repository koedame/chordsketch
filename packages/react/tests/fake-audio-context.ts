import { vi } from 'vitest';

// ---- Shared Web Audio API stand-ins ----------------------------
// jsdom ships no Web Audio API, so the audio hooks (`useChordAudio`,
// `useKeyAudio`, `useMetronome`) and the components that mount them are
// exercised against a minimal fake that records the graph operations the
// schedulers perform. This module is the single source of truth for that
// fake so the suites do not each maintain a drifting copy — when the
// audio layer grows a new node type (the #2668 piano `PeriodicWave` and
// woodblock noise source added `createPeriodicWave` / `createBuffer` /
// `createBufferSource` / `createBiquadFilter`), it is added here once and
// every suite picks it up.
//
// Fidelity is deliberately shallow: the fakes only need the methods the
// production code calls, and they record calls via `vi.fn()` so tests can
// assert on the scheduled graph. Audio timing / pitch correctness is
// asserted from the recorded arguments, not from real sound.

/** Records the calls the schedulers make against an oscillator voice. */
export class FakeOscillator {
  type = '';
  onended: (() => void) | null = null;
  frequency = { setValueAtTime: vi.fn() };
  setPeriodicWave = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

/** Records the calls against a gain node's gain `AudioParam`. */
export class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

/** Records the calls against the woodblock click's noise source. */
export class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

/** Records the calls against the woodblock click's band-pass filter. */
export class FakeBiquadFilter {
  type = '';
  frequency = { setValueAtTime: vi.fn() };
  Q = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

/** Marker returned by `createPeriodicWave` (the shared piano timbre). */
export class FakePeriodicWave {}

/** A one-channel buffer whose single channel is a reusable Float32Array. */
export class FakeAudioBuffer {
  private readonly channel: Float32Array;
  constructor(length: number) {
    this.channel = new Float32Array(length);
  }
  getChannelData(_channelNumber: number): Float32Array {
    return this.channel;
  }
}

/**
 * Minimal `AudioContext` stand-in. `instances` lets a test reach the
 * exact context a hook created so it can drive `currentTime` forward and
 * inspect the scheduled graph; `oscillators` / `bufferSources` /
 * `periodicWaves` record what the schedulers built.
 */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  sampleRate = 44_100;
  destination = {};
  oscillators: FakeOscillator[] = [];
  bufferSources: FakeBufferSource[] = [];
  biquadFilters: FakeBiquadFilter[] = [];
  gains: FakeGain[] = [];
  periodicWaves: FakePeriodicWave[] = [];
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
  createOscillator = vi.fn(() => {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  });
  createGain = vi.fn(() => {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  });
  createBufferSource = vi.fn(() => {
    const src = new FakeBufferSource();
    this.bufferSources.push(src);
    return src;
  });
  createBiquadFilter = vi.fn(() => {
    const filter = new FakeBiquadFilter();
    this.biquadFilters.push(filter);
    return filter;
  });
  createBuffer = vi.fn((_channels: number, length: number, _sampleRate: number) => new FakeAudioBuffer(length));
  createPeriodicWave = vi.fn(() => {
    const wave = new FakePeriodicWave();
    this.periodicWaves.push(wave);
    return wave;
  });
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

/** Combined source-node view (oscillators + buffer sources) of a context. */
export function scheduledSources(
  ctx: FakeAudioContext,
): Array<FakeOscillator | FakeBufferSource> {
  return [...ctx.oscillators, ...ctx.bufferSources];
}
