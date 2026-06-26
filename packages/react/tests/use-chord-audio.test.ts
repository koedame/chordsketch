import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetSharedAudioContextForTests } from '../src/audio-context';
import {
  type ChordAudioWasmLoader,
  useChordAudio,
} from '../src/use-chord-audio';
import { FakeAudioContext } from './fake-audio-context';

// jsdom ships no Web Audio API, so the hook is exercised against the
// shared minimal fake (`./fake-audio-context`) that records the graph
// operations `play` performs.

// A C major triad / Am7 chord lookup, mirroring `chord_pitches`.
const fakePitches = vi.fn((chord: string): Uint8Array | undefined => {
  switch (chord) {
    case 'C':
      return new Uint8Array([48, 52, 55]);
    case 'Am7':
      return new Uint8Array([57, 60, 64, 67]);
    case 'xyz':
      return undefined;
    default:
      return undefined;
  }
});

const defaultFn = vi.fn(() => Promise.resolve());
const makeLoader = (): ChordAudioWasmLoader => () =>
  Promise.resolve({ default: defaultFn, chordPitches: fakePitches });

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  FakeAudioContext.instances = [];
  resetSharedAudioContextForTests();
  fakePitches.mockClear();
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
  const rendered = renderHook(() => useChordAudio(loader));
  await waitFor(() => expect(defaultFn).toHaveBeenCalled());
  // One extra microtask flush so `moduleRef` is assigned after the
  // second await inside the preload effect.
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

describe('useChordAudio', () => {
  test('reports support when AudioContext is present', () => {
    const { result } = renderHook(() => useChordAudio(makeLoader()));
    expect(result.current.supported).toBe(true);
  });

  test('reports no support and play is a no-op without AudioContext', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { result } = renderHook(() => useChordAudio(makeLoader()));
    expect(result.current.supported).toBe(false);
    // Must not throw even though no module / context exists.
    act(() => result.current.play('C'));
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('play schedules one oscillator per pitch with correct frequencies', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(3);
    // Every voice sounds with the shared piano `PeriodicWave` (#2668),
    // created once for the context and reused across the chord's voices.
    expect(ctx.periodicWaves).toHaveLength(1);
    for (const osc of ctx.oscillators) {
      expect(osc.setPeriodicWave).toHaveBeenCalledWith(ctx.periodicWaves[0]);
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    }
    // C3 = MIDI 48 ⇒ ~130.81 Hz; the highest tone G3 = MIDI 55.
    const freqs = ctx.oscillators.map(
      (o) => (o.frequency.setValueAtTime.mock.calls[0]?.[0] as number) ?? 0,
    );
    expect(freqs[0]).toBeCloseTo(130.81, 1);
    expect(freqs[2]).toBeCloseTo(196.0, 1);
  });

  test('the chord is strummed: voice onsets stagger, not simultaneous', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('Am7'));

    const ctx = FakeAudioContext.instances[0]!;
    // Four voices, each scheduled via `osc.start(startTime)`. A strum rolls
    // the chord, so the onsets must strictly increase low → high; a block
    // stab (the pre-#2728 behaviour) would start every voice at the same
    // instant, which this assertion rejects.
    const starts = ctx.oscillators.map(
      (o) => (o.start.mock.calls[0]?.[0] as number) ?? 0,
    );
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    }
  });

  test('play on an unparseable chord schedules nothing', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('xyz'));
    // The shared context may have been created, but no voice sounds.
    const ctx = FakeAudioContext.instances[0];
    expect(ctx?.oscillators ?? []).toHaveLength(0);
  });

  test('repeated plays of the same chord look it up once (cache)', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('Am7'));
    act(() => result.current.play('Am7'));
    expect(fakePitches).toHaveBeenCalledTimes(1);
  });

  test('a new play cuts the previously ringing chord', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('C'));
    const ctx = FakeAudioContext.instances[0]!;
    const firstVoices = [...ctx.oscillators];
    act(() => result.current.play('Am7'));
    // The first chord's oscillators were stopped before the new chord.
    for (const osc of firstVoices) {
      expect(osc.stop).toHaveBeenCalled();
    }
    // 3 (C) + 4 (Am7) oscillators created in total.
    expect(ctx.oscillators).toHaveLength(7);
  });

  test('stop silences all ringing voices', async () => {
    const { result } = await renderLoaded();
    act(() => result.current.play('Am7'));
    const ctx = FakeAudioContext.instances[0]!;
    const voices = [...ctx.oscillators];
    act(() => result.current.stop());
    for (const osc of voices) {
      expect(osc.stop).toHaveBeenCalled();
    }
  });
});
