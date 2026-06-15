import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  METRONOME_MAX_BPM,
  METRONOME_MIN_BPM,
  useMetronome,
} from '../src/use-metronome';

// ---- Web Audio API stand-ins -----------------------------------
// jsdom ships no Web Audio API, so the hook is exercised against a
// minimal fake that records the graph operations the scheduler
// performs. `instances` lets a test reach the exact context the
// hook created so it can drive `currentTime` forward.

class FakeOscillator {
  type = '';
  frequency = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  oscillators: FakeOscillator[] = [];
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
  createGain = vi.fn(() => new FakeGain());
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.useFakeTimers();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  vi.useRealTimers();
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

  test('stop halts scheduling and clears isPlaying', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    act(() => result.current.stop());
    expect(result.current.isPlaying).toBe(false);
    const afterStop = ctx.oscillators.length;
    act(() => {
      ctx.currentTime = 5;
      vi.advanceTimersByTime(100);
    });
    // No further ticks once the timer is cleared.
    expect(ctx.oscillators.length).toBe(afterStop);
  });

  test('toggle starts then stops', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.toggle(90));
    expect(result.current.isPlaying).toBe(true);
    act(() => result.current.toggle(90));
    expect(result.current.isPlaying).toBe(false);
  });

  test('restarting reuses the same AudioContext', () => {
    const { result } = renderHook(() => useMetronome());
    act(() => result.current.start(100));
    act(() => result.current.start(140));
    // Only one context is ever created across restarts.
    expect(FakeAudioContext.instances.length).toBe(1);
    expect(result.current.isPlaying).toBe(true);
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

  test('closes the AudioContext on unmount', () => {
    const { result, unmount } = renderHook(() => useMetronome());
    act(() => result.current.start(120));
    const ctx = FakeAudioContext.instances[0]!;
    unmount();
    expect(ctx.close).toHaveBeenCalled();
  });

  test('start is a no-op when Web Audio is unavailable', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { result } = renderHook(() => useMetronome());
    expect(result.current.supported).toBe(false);
    act(() => result.current.start(120));
    expect(result.current.isPlaying).toBe(false);
    expect(FakeAudioContext.instances.length).toBe(0);
  });
});
