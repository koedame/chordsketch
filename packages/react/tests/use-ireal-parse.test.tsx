import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import {
  useIrealParse,
  type IrealWasmLoader,
} from '../src/use-ireal-parse';
import type { IrealSong } from '../src/ireal-ast';

interface ParserStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
}

function makeStub(): ParserStub {
  return {
    default: vi.fn(async () => undefined),
    parseIrealb: vi.fn(
      () =>
        JSON.stringify({
          title: 'Test',
          composer: null,
          style: null,
          key_signature: {
            root: { note: 'C', accidental: 'natural' },
            mode: 'major',
          },
          time_signature: { numerator: 4, denominator: 4 },
          tempo: null,
          transpose: 0,
          sections: [],
        } satisfies IrealSong),
    ),
  };
}

function makeLoader(stub: ParserStub): IrealWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<IrealWasmLoader>>);
}

describe('useIrealParse', () => {
  test('returns song after wasm + parse resolve', async () => {
    const stub = makeStub();
    const { result } = renderHook(() =>
      useIrealParse('irealb://demo', makeLoader(stub)),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.song).not.toBeNull());
    expect(result.current.song?.title).toBe('Test');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test('empty source skips wasm call and starts with loading=false', async () => {
    const stub = makeStub();
    const { result } = renderHook(() => useIrealParse('', makeLoader(stub)));
    expect(result.current.loading).toBe(false);
    expect(result.current.song).toBeNull();
    // Allow effect to settle — it still runs but takes the empty path.
    await waitFor(() => expect(stub.default).toHaveBeenCalled());
    expect(stub.parseIrealb).not.toHaveBeenCalled();
    expect(result.current.song).toBeNull();
  });

  test('parseIrealb failure surfaces via error state', async () => {
    const stub = makeStub();
    stub.parseIrealb.mockImplementation(() => {
      throw new Error('bad URL');
    });
    const { result } = renderHook(() =>
      useIrealParse('irealb://broken', makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('bad URL');
    expect(result.current.song).toBeNull();
  });

  test('JSON.parse failure surfaces with an "Invalid AST JSON" prefix', async () => {
    // Regression for the silent-failure audit: a wasm-contract bug
    // (parseIrealb returns malformed JSON) must be distinguishable
    // from an ordinary user-input parse error.
    const stub = makeStub();
    stub.parseIrealb.mockReturnValue('{this is not json}');
    const { result } = renderHook(() =>
      useIrealParse('irealb://x', makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toMatch(
      /^Invalid AST JSON from @chordsketch\/wasm\.parseIrealb:/,
    );
  });

  test('keeps previous song visible when a later parse fails (UX promise)', async () => {
    // The hook's load-bearing UX claim: a transient invalid edit
    // does not blank the preview.
    const stub = makeStub();
    const { result, rerender } = renderHook(
      ({ source }: { source: string }) =>
        useIrealParse(source, makeLoader(stub)),
      { initialProps: { source: 'irealb://first' } },
    );
    await waitFor(() => expect(result.current.song?.title).toBe('Test'));
    stub.parseIrealb.mockImplementation(() => {
      throw new Error('boom');
    });
    rerender({ source: 'irealb://broken' });
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    // Stale song still visible.
    expect(result.current.song?.title).toBe('Test');
  });

  test('wasm-init failure surfaces via error state', async () => {
    const stub = makeStub();
    stub.default.mockImplementation(async () => {
      throw new Error('init failed');
    });
    const { result } = renderHook(() =>
      useIrealParse('irealb://x', makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.error?.message).toBe('init failed'));
    expect(stub.parseIrealb).not.toHaveBeenCalled();
  });

  test('loading does not get stuck when source clears while wasm is initialising', async () => {
    // Regression: if source changes from non-empty to '' before wasm
    // finishes loading, the setLoading(true) from the first run must
    // still resolve to false. Without the setLoading(false) call in the
    // empty-source path, the loading flag is permanently stuck at true.
    const stub = makeStub();
    let resolveLoader!: (value: unknown) => void;
    const blockedLoader: IrealWasmLoader = vi.fn(
      () =>
        new Promise((r) => {
          resolveLoader = r;
        }) as ReturnType<IrealWasmLoader>,
    );
    const { result, rerender } = renderHook(
      ({ source }: { source: string }) => useIrealParse(source, blockedLoader),
      { initialProps: { source: 'irealb://x' } },
    );
    // Wasm is loading; loading must be true.
    expect(result.current.loading).toBe(true);
    // Clear source before the loader resolves.
    rerender({ source: '' });
    // Unblock the loader — run 1 is cancelled; run 2 also awaits the loader.
    resolveLoader(stub);
    // loading must settle to false (not stuck).
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.song).toBeNull();
  });
});
