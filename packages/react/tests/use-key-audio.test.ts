import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetSharedAudioContextForTests } from '../src/audio-context';
import { type KeyAudioWasmLoader, useKeyAudio } from '../src/use-key-audio';
import { FakeAudioContext } from './fake-audio-context';

// jsdom ships no Web Audio API, so the hook is exercised against the
// shared minimal fake (`./fake-audio-context`) that records the graph
// operations `play` performs.

// Scale / triad lookups mirroring `key_scale_pitches` / `key_tonic_triad`:
// C major scale + triad, A natural-minor scale + triad.
const fakeScale = vi.fn((key: string): Uint8Array | undefined => {
  switch (key) {
    case 'C':
      return new Uint8Array([48, 50, 52, 53, 55, 57, 59, 60]);
    case 'Am':
      return new Uint8Array([57, 59, 60, 62, 64, 65, 67, 69]);
    default:
      return undefined;
  }
});
const fakeTriad = vi.fn((key: string): Uint8Array | undefined => {
  switch (key) {
    case 'C':
      return new Uint8Array([48, 52, 55]);
    case 'Am':
      return new Uint8Array([57, 60, 64]);
    default:
      return undefined;
  }
});

const defaultFn = vi.fn(() => Promise.resolve());
const makeLoader = (): KeyAudioWasmLoader => () =>
  Promise.resolve({
    default: defaultFn,
    keyScalePitches: fakeScale,
    keyTonicTriad: fakeTriad,
  });

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  FakeAudioContext.instances = [];
  resetSharedAudioContextForTests();
  fakeScale.mockClear();
  fakeTriad.mockClear();
  defaultFn.mockClear();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  resetSharedAudioContextForTests();
  if (originalAudioContext === undefined) {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  } else {
    (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
  }
});

/** Render the hook and wait for its on-mount wasm preload to resolve. */
async function renderLoaded(loader = makeLoader()) {
  const rendered = renderHook(() => useKeyAudio(loader));
  await waitFor(() => expect(defaultFn).toHaveBeenCalled());
  // One extra microtask flush so `moduleRef` is assigned after the
  // second await inside the preload effect.
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

describe('useKeyAudio', () => {
  test('reports support when AudioContext is present', () => {
    const { result } = renderHook(() => useKeyAudio(makeLoader()));
    expect(result.current.supported).toBe(true);
  });

  test('reports no support and play is a no-op without AudioContext', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { result } = renderHook(() => useKeyAudio(makeLoader()));
    expect(result.current.supported).toBe(false);
    act(() => result.current.play('C'));
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('play schedules the eight scale notes then the three-note triad', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));

    const ctx = FakeAudioContext.instances[0]!;
    // 8 scale degrees + 3 triad tones = 11 oscillators.
    expect(ctx.oscillators).toHaveLength(11);
    // Every voice sounds with the shared piano `PeriodicWave` (#2668),
    // created once for the context and reused across scale + triad.
    expect(ctx.periodicWaves).toHaveLength(1);
    for (const osc of ctx.oscillators) {
      expect(osc.setPeriodicWave).toHaveBeenCalledWith(ctx.periodicWaves[0]);
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    }
    // First scale note is the tonic C3 = MIDI 48 ⇒ ~130.81 Hz; the
    // scale's octave (8th note) is C4 = MIDI 60 ⇒ ~261.63 Hz.
    const freqs = ctx.oscillators.map(
      (o) => (o.frequency.setValueAtTime.mock.calls[0]?.[0] as number) ?? 0,
    );
    expect(freqs[0]).toBeCloseTo(130.81, 1);
    expect(freqs[7]).toBeCloseTo(261.63, 1);
  });

  test('the scale notes are scheduled sequentially in time', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));
    const ctx = FakeAudioContext.instances[0]!;
    // Each scale note is `osc.start(startTime)`; the onsets must be
    // strictly increasing so the scale plays one note at a time rather
    // than as a cluster.
    const starts = ctx.oscillators
      .slice(0, 8)
      .map((o) => (o.start.mock.calls[0]?.[0] as number) ?? 0);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    }
    // The triad strum is scheduled after the whole scale.
    const triadStart = (ctx.oscillators[8]!.start.mock.calls[0]?.[0] as number) ?? 0;
    expect(triadStart).toBeGreaterThan(starts[7]!);
  });

  test('a minor key auditions the natural-minor scale + minor triad', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('Am'));
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(11);
    expect(fakeScale).toHaveBeenCalledWith('Am');
    expect(fakeTriad).toHaveBeenCalledWith('Am');
    // First note is the tonic A3 = MIDI 57 ⇒ ~220 Hz.
    const first = ctx.oscillators[0]!.frequency.setValueAtTime.mock.calls[0]?.[0] as number;
    expect(first).toBeCloseTo(220.0, 1);
  });

  test('play on an unparseable key schedules nothing', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('not-a-key'));
    const ctx = FakeAudioContext.instances[0];
    expect(ctx?.oscillators ?? []).toHaveLength(0);
  });

  test('repeated auditions of the same key look it up once (cache)', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));
    act(() => result.current.play('C'));
    expect(fakeScale).toHaveBeenCalledTimes(1);
    expect(fakeTriad).toHaveBeenCalledTimes(1);
  });

  test('a new audition cuts the previously ringing one', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));
    const ctx = FakeAudioContext.instances[0]!;
    const firstVoices = [...ctx.oscillators];
    act(() => result.current.play('Am'));
    for (const osc of firstVoices) {
      expect(osc.stop).toHaveBeenCalled();
    }
    // 11 (C) + 11 (Am) oscillators created in total.
    expect(ctx.oscillators).toHaveLength(22);
  });

  test('stop silences all ringing voices', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));
    const ctx = FakeAudioContext.instances[0]!;
    const voices = [...ctx.oscillators];
    act(() => result.current.stop());
    for (const osc of voices) {
      expect(osc.stop).toHaveBeenCalled();
    }
  });
});
