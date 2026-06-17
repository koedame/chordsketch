import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  METRONOME_MAX_BPM,
  METRONOME_MIN_BPM,
  resetMetronomeSharedStateForTests,
  useMetronome,
} from '../src/use-metronome';
import { FakeAudioContext } from './fake-audio-context';

// jsdom ships no Web Audio API, so the hook is exercised against the
// shared minimal fake (`./fake-audio-context`) that records the graph
// operations the scheduler performs. `instances` lets a test reach the
// exact context the hook created so it can drive `currentTime` forward.
// Each woodblock tick (#2668) schedules a pitched body oscillator AND a
// noise buffer source, so the per-tick source count is two.

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  FakeAudioContext.instances = [];
  resetMetronomeSharedStateForTests();
  vi.useFakeTimers();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  vi.useRealTimers();
  resetMetronomeSharedStateForTests();
  if (originalAudioContext === undefined) {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  } else {
    (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
  }
});

describe('useMetronome', () => {
  test('reports support when AudioContext is present', () => {
    const { result } = renderHook(() => useMetronome());
    expect(result.current.supported).toBe(true);
    expect(result.current.isPlaying).toBe(false);
  });

  test('start schedules at least one tick and flips isPlaying', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    expect(result.current.isPlaying).toBe(true);
    const ctx = FakeAudioContext.instances[0]!;
    // The first scheduler pass runs synchronously inside start().
    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(1);
    const osc = ctx.oscillators[0]!;
    expect(osc.frequency.setValueAtTime).toHaveBeenCalled();
    expect(osc.start).toHaveBeenCalled();
    expect(osc.stop).toHaveBeenCalled();
  });

  test('each tick is a woodblock: a noise transient plus a pitched body', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    // Every tick contributes exactly one pitched-body oscillator and one
    // band-pass-filtered noise source (#2668), so the two counts match.
    expect(ctx.bufferSources.length).toBeGreaterThanOrEqual(1);
    expect(ctx.oscillators.length).toBe(ctx.bufferSources.length);
    // The noise source plays the shared per-context noise buffer, routed
    // through a band-pass filter (the wooden "attack").
    for (const noise of ctx.bufferSources) {
      expect(noise.buffer).not.toBeNull();
      expect(noise.start).toHaveBeenCalled();
      expect(noise.stop).toHaveBeenCalled();
    }
    // No downbeat accent: every tick's pitched body uses the same
    // frequency, so the clicks are identical regardless of beat position.
    const bodyFreqs = ctx.oscillators.map(
      (o) => o.frequency.setValueAtTime.mock.calls[0]?.[0] as number,
    );
    for (const f of bodyFreqs) {
      expect(f).toBe(bodyFreqs[0]);
    }
  });

  test('continues scheduling ticks as the audio clock advances', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    const initial = ctx.oscillators.length;
    // Advance the audio clock past several beats, then let the
    // lookahead timer fire — the scheduler should top up the queue.
    act(() => {
      ctx.currentTime = 2;
      vi.advanceTimersByTime(25);
    });
    expect(ctx.oscillators.length).toBeGreaterThan(initial);
  });

  test('stop halts scheduling, cancels queued ticks, and clears isPlaying', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    const queuedOscillators = [...ctx.oscillators];
    const queuedNoise = [...ctx.bufferSources];
    act(() => result.current.stop());
    expect(result.current.isPlaying).toBe(false);
    // Every queued source — both the pitched body and the noise
    // transient — is cancelled by stop(): once with the scheduled
    // stop-time in scheduleWoodblockTick, once with no arg in stop().
    for (const source of [...queuedOscillators, ...queuedNoise]) {
      expect(source.stop.mock.calls.length).toBeGreaterThanOrEqual(2);
    }
    const afterStopOscillators = ctx.oscillators.length;
    const afterStopNoise = ctx.bufferSources.length;
    act(() => {
      ctx.currentTime = 5;
      vi.advanceTimersByTime(100);
    });
    // No further ticks once the timer is cleared.
    expect(ctx.oscillators.length).toBe(afterStopOscillators);
    expect(ctx.bufferSources.length).toBe(afterStopNoise);
  });

  test('isRunning reflects the synchronous timer state', () => {
    const { result } = renderHook(() => useMetronome());
    expect(result.current.isRunning()).toBe(false);
    act(() => result.current.start(120));
    expect(result.current.isRunning()).toBe(true);
    act(() => result.current.stop());
    expect(result.current.isRunning()).toBe(false);
  });

  test('isRunning goes false on the instance the coordinator stops', () => {
    const first = renderHook(() => useMetronome());
    const second = renderHook(() => useMetronome());
    act(() => first.result.current.start(120));
    act(() => second.result.current.start(90));
    // The coordinator stopped `first`; its synchronous timer state
    // must agree even before any re-render flushes.
    expect(first.result.current.isRunning()).toBe(false);
    expect(second.result.current.isRunning()).toBe(true);
  });

  test('toggle starts then stops', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.toggle(90));
    expect(result.current.isPlaying).toBe(true);
    act(() => result.current.toggle(90));
    expect(result.current.isPlaying).toBe(false);
  });

  test('restarting reuses the same shared AudioContext', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(100));
    act(() => result.current.start(140));
    // Only one context is ever created across restarts.
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(result.current.isPlaying).toBe(true);
  });

  test('only one metronome plays at a time across instances', () => {
    const first = renderHook(() => useMetronome());
    const second = renderHook(() => useMetronome());
    act(() => first.result.current.start(120));
    expect(first.result.current.isPlaying).toBe(true);
    // Starting the second instance stops the first.
    act(() => second.result.current.start(90));
    expect(second.result.current.isPlaying).toBe(true);
    expect(first.result.current.isPlaying).toBe(false);
    // Both instances share the single page-level context.
    expect(FakeAudioContext.instances.length).toBe(1);
  });

  test('resumes a suspended context on start', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    // The fake starts 'running'; force the suspended path and verify
    // a fresh start resumes it.
    ctx.state = 'suspended';
    act(() => {
      result.current.stop();
      result.current.start(120);
    });
    expect(ctx.resume).toHaveBeenCalled();
  });

  test('clamps out-of-range and non-finite BPM without throwing', () => {
    const { result } = renderHook(() => useMetronome());
    expect(() => {
      act(() => result.current.start(Number.NaN));
      act(() => result.current.stop());
      act(() => result.current.start(0));
      act(() => result.current.stop());
      act(() => result.current.start(METRONOME_MAX_BPM * 1000));
    }).not.toThrow();
    expect(result.current.isPlaying).toBe(true);
    expect(METRONOME_MIN_BPM).toBeLessThan(METRONOME_MAX_BPM);
  });

  test('stops scheduling on unmount without closing the shared context', () => {
    const { result, unmount } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    unmount();
    // The shared context lives for the page lifetime — unmount must
    // not close it (other instances reuse it).
    expect(ctx.close).not.toHaveBeenCalled();
    const afterUnmount = ctx.oscillators.length;
    act(() => {
      ctx.currentTime = 5;
      vi.advanceTimersByTime(100);
    });
    // The scheduler is torn down, so no further ticks are queued.
    expect(ctx.oscillators.length).toBe(afterUnmount);
  });

  test('start is a no-op when Web Audio is unavailable', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    resetMetronomeSharedStateForTests();
    const { result } = renderHook(() => useMetronome());
    expect(result.current.supported).toBe(false);
    act(() => result.current.start(120));
    expect(result.current.isPlaying).toBe(false);
    expect(FakeAudioContext.instances.length).toBe(0);
  });
});
