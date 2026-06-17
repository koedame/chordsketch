import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  getPianoWave,
  midiToFreq,
  resetSharedAudioContextForTests,
  scheduleVoice,
  scheduleWoodblockTick,
  stopVoices,
} from '../src/audio-context';
import { FakeAudioContext } from './fake-audio-context';

// Direct unit tests for the synthesis module that backs all three audio
// hooks. The hook suites exercise these helpers transitively; this suite
// pins the module's own contracts — the per-context wave / noise caches,
// the woodblock's band-pass routing, the `PeriodicWave` vs `OscillatorType`
// branch, and the stop / cleanup path — so a regression in one of them
// fails here rather than slipping through the hooks' coarser assertions.

// `scheduleVoice` / `scheduleWoodblockTick` accept the `BaseAudioContext`
// surface; the fake stands in for a real `AudioContext`.
function makeCtx(): { fake: FakeAudioContext; ctx: BaseAudioContext } {
  const fake = new FakeAudioContext();
  return { fake, ctx: fake as unknown as BaseAudioContext };
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  resetSharedAudioContextForTests();
});

afterEach(() => {
  resetSharedAudioContextForTests();
});

describe('midiToFreq', () => {
  test('maps MIDI note numbers to equal-tempered frequencies (A4 = 440)', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 5); // A4
    expect(midiToFreq(60)).toBeCloseTo(261.63, 2); // C4
    expect(midiToFreq(57)).toBeCloseTo(220, 2); // A3
    expect(midiToFreq(81)).toBeCloseTo(880, 2); // A5
  });
});

describe('getPianoWave', () => {
  test('builds one PeriodicWave per context and reuses it', () => {
    const { fake, ctx } = makeCtx();
    const first = getPianoWave(ctx);
    const second = getPianoWave(ctx);
    // Same instance returned, and the (allocating) factory ran once.
    expect(second).toBe(first);
    expect(fake.createPeriodicWave).toHaveBeenCalledTimes(1);
    expect(fake.periodicWaves).toHaveLength(1);
  });

  test('a fresh context regenerates its own wave', () => {
    const a = makeCtx();
    const b = makeCtx();
    const waveA = getPianoWave(a.ctx);
    const waveB = getPianoWave(b.ctx);
    // Each context caches independently (the cache is keyed on the
    // context instance), so the two waves are distinct objects.
    expect(waveB).not.toBe(waveA);
    expect(a.fake.createPeriodicWave).toHaveBeenCalledTimes(1);
    expect(b.fake.createPeriodicWave).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleVoice', () => {
  test('voices a PeriodicWave via setPeriodicWave (not osc.type)', () => {
    const { fake, ctx } = makeCtx();
    const tracked = new Set<AudioScheduledSourceNode>();
    const wave = getPianoWave(ctx);
    scheduleVoice(ctx, tracked, {
      type: wave,
      frequency: 440,
      startTime: 0,
      attack: 0.006,
      release: 2,
      peak: 0.2,
      tail: 0.05,
    });
    const osc = fake.oscillators[0]!;
    expect(osc.setPeriodicWave).toHaveBeenCalledWith(wave);
    expect(osc.type).toBe(''); // never set to a built-in type
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, 0);
    // Soft attack ramps to the peak, then decays to the floor; the
    // oscillator is stopped at release + tail.
    expect(fake.gains[0]!.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.2, 0.006);
    expect(osc.start).toHaveBeenCalledWith(0);
    expect(osc.stop).toHaveBeenCalledWith(2.05);
    expect(tracked.has(osc as unknown as AudioScheduledSourceNode)).toBe(true);
  });

  test('voices a built-in OscillatorType via osc.type', () => {
    const { fake, ctx } = makeCtx();
    const tracked = new Set<AudioScheduledSourceNode>();
    scheduleVoice(ctx, tracked, {
      type: 'sine',
      frequency: 100,
      startTime: 0,
      attack: 0, // percussive onset
      release: 0.05,
      peak: 0.3,
      tail: 0,
    });
    const osc = fake.oscillators[0]!;
    expect(osc.type).toBe('sine');
    expect(osc.setPeriodicWave).not.toHaveBeenCalled();
    // Percussive onset jumps straight to the peak (no attack ramp).
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(100, 0);
    expect(fake.gains[0]!.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0);
  });

  test('onended cleanup removes the voice from the set and disconnects it', () => {
    const { fake, ctx } = makeCtx();
    const tracked = new Set<AudioScheduledSourceNode>();
    scheduleVoice(ctx, tracked, {
      type: 'sine',
      frequency: 100,
      startTime: 0,
      attack: 0,
      release: 0.05,
      peak: 0.3,
      tail: 0,
    });
    const osc = fake.oscillators[0]!;
    expect(tracked.size).toBe(1);
    // Simulate the node finishing: onended must untrack + disconnect.
    osc.onended?.();
    expect(tracked.size).toBe(0);
    expect(osc.disconnect).toHaveBeenCalled();
    expect(fake.gains[0]!.disconnect).toHaveBeenCalled();
  });
});

describe('scheduleWoodblockTick', () => {
  test('layers a noise transient routed through a band-pass filter with a pitched body', () => {
    const { fake, ctx } = makeCtx();
    const tracked = new Set<AudioScheduledSourceNode>();
    scheduleWoodblockTick(ctx, tracked, 0);

    // One pitched body oscillator + one noise buffer source.
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.bufferSources).toHaveLength(1);
    expect(fake.oscillators[0]!.type).toBe('sine');

    // The noise is band-pass filtered — this is what gives the click its
    // wooden character; assert the filter exists and the noise routes
    // THROUGH it (noise -> bandpass -> gain -> destination).
    expect(fake.biquadFilters).toHaveLength(1);
    const bandpass = fake.biquadFilters[0]!;
    expect(bandpass.type).toBe('bandpass');
    expect(bandpass.frequency.setValueAtTime).toHaveBeenCalled();
    expect(bandpass.Q.setValueAtTime).toHaveBeenCalled();
    const noise = fake.bufferSources[0]!;
    expect(noise.buffer).not.toBeNull();
    expect(noise.connect).toHaveBeenCalledWith(bandpass);
    expect(bandpass.connect).toHaveBeenCalled();
    expect(noise.start).toHaveBeenCalledWith(0);
    expect(noise.stop).toHaveBeenCalled();

    // Both source nodes are tracked so stop() can cancel a queued tick.
    expect(tracked.size).toBe(2);
  });

  test('reuses one noise buffer across ticks', () => {
    const { fake, ctx } = makeCtx();
    const tracked = new Set<AudioScheduledSourceNode>();
    scheduleWoodblockTick(ctx, tracked, 0);
    scheduleWoodblockTick(ctx, tracked, 0.5);
    scheduleWoodblockTick(ctx, tracked, 1);
    // The noise buffer is generated once and shared by every tick.
    expect(fake.createBuffer).toHaveBeenCalledTimes(1);
    const buffers = fake.bufferSources.map((s) => s.buffer);
    expect(buffers[0]).toBe(buffers[1]);
    expect(buffers[1]).toBe(buffers[2]);
  });
});

describe('stopVoices', () => {
  test('stops every tracked source and clears the set', () => {
    const { fake, ctx } = makeCtx();
    const tracked = new Set<AudioScheduledSourceNode>();
    scheduleVoice(ctx, tracked, {
      type: 'sine',
      frequency: 100,
      startTime: 0,
      attack: 0,
      release: 0.05,
      peak: 0.3,
      tail: 0,
    });
    scheduleWoodblockTick(ctx, tracked, 0);
    // 1 voice + (1 body + 1 noise) = 3 tracked sources.
    expect(tracked.size).toBe(3);

    stopVoices(tracked);
    expect(tracked.size).toBe(0);
    for (const osc of fake.oscillators) {
      expect(osc.stop).toHaveBeenCalledWith();
    }
    for (const noise of fake.bufferSources) {
      expect(noise.stop).toHaveBeenCalledWith();
    }
  });
});
