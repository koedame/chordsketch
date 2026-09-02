import { flushSync } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import * as pkg from '../src/index';
import { useDebounced } from '../src/index';
import { inEffectRoot, reactiveBox } from './runes.svelte';

const roots: Array<() => void> = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  vi.useRealTimers();
});

function debounced<T>(source: { value: T }, delay: number) {
  const root = inEffectRoot(() => useDebounced(() => source.value, delay));
  roots.push(root.destroy);
  return root.value;
}

describe('package surface', () => {
  test('version() reports the manifest version', () => {
    expect(pkg.version()).toBe(packageJson.version);
  });

  test('exports the five components and the helpers behind them', () => {
    for (const name of [
      'ChordSheet',
      'ChordTextarea',
      'ChordDiagram',
      'Transpose',
      'PdfExport',
      'useChordRender',
      'useChordDiagram',
      'usePdfExport',
      'useTranspose',
      'useDebounced',
    ]) {
      expect(pkg, name).toHaveProperty(name);
    }
  });
});

describe('useDebounced', () => {
  test('starts at the current value, before any effect has run', () => {
    const source = reactiveBox('a');
    expect(debounced(source, 200).current).toBe('a');
  });

  test('schedules no timer when the delay is 0', () => {
    vi.useFakeTimers();
    const source = reactiveBox('a');
    const value = debounced(source, 0);

    source.value = 'b';
    flushSync();
    expect(value.current).toBe('b');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('delays the update by the debounce window', () => {
    vi.useFakeTimers();
    const source = reactiveBox('a');
    const value = debounced(source, 200);

    source.value = 'b';
    flushSync();
    expect(value.current).toBe('a');

    vi.advanceTimersByTime(200);
    expect(value.current).toBe('b');
  });

  test('a change inside the window restarts it, so only the last value lands', () => {
    vi.useFakeTimers();
    const source = reactiveBox('a');
    const value = debounced(source, 200);

    source.value = 'b';
    flushSync();
    vi.advanceTimersByTime(150);
    source.value = 'c';
    flushSync();
    vi.advanceTimersByTime(150);
    expect(value.current).toBe('a');

    vi.advanceTimersByTime(50);
    expect(value.current).toBe('c');
  });

  test('destroying the owner cancels a pending update', () => {
    vi.useFakeTimers();
    const source = reactiveBox('a');
    const root = inEffectRoot(() => useDebounced(() => source.value, 200));

    source.value = 'b';
    flushSync();
    root.destroy();
    vi.advanceTimersByTime(500);
    expect(root.value.current).toBe('a');
  });
});
