import { describe, expect, test, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import packageJson from '../package.json' with { type: 'json' };
import * as pkg from '../src/index';
import { useDebounced } from '../src/index';

describe('package surface', () => {
  test('version() reports the manifest version', () => {
    expect(pkg.version()).toBe(packageJson.version);
  });

  test('exports the five components and their composables', () => {
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
  test('passes the value through synchronously when the delay is 0', async () => {
    const source = ref('a');
    const debounced = useDebounced(source, 0);
    expect(debounced.value).toBe('a');

    source.value = 'b';
    expect(debounced.value).toBe('b');
  });

  test('delays the update by the debounce window', async () => {
    vi.useFakeTimers();
    try {
      const source = ref('a');
      const debounced = useDebounced(source, 200);

      source.value = 'b';
      await nextTick();
      expect(debounced.value).toBe('a');

      vi.advanceTimersByTime(200);
      expect(debounced.value).toBe('b');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a change inside the window restarts it, so only the last value lands', () => {
    vi.useFakeTimers();
    try {
      const source = ref('a');
      const debounced = useDebounced(source, 200);

      source.value = 'b';
      vi.advanceTimersByTime(150);
      source.value = 'c';
      vi.advanceTimersByTime(150);
      expect(debounced.value).toBe('a');

      vi.advanceTimersByTime(50);
      expect(debounced.value).toBe('c');
    } finally {
      vi.useRealTimers();
    }
  });

  test('disposing the scope cancels a pending update', () => {
    vi.useFakeTimers();
    try {
      const source = ref('a');
      const scope = effectScope();
      const debounced = scope.run(() => useDebounced(source, 200))!;

      source.value = 'b';
      scope.stop();
      vi.advanceTimersByTime(500);
      expect(debounced.value).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });
});
