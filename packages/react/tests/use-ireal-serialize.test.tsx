import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import {
  useIrealSerialize,
  type IrealSerializeLoader,
} from '../src/use-ireal-serialize';
import type { IrealSong } from '../src/ireal-ast';

interface SerializerStub {
  default: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
}

function songFixture(): IrealSong {
  return {
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
  };
}

function makeStub(): SerializerStub {
  return {
    default: vi.fn(async () => undefined),
    serializeIrealb: vi.fn((json: string) => {
      const parsed = JSON.parse(json) as IrealSong;
      return `irealb://t/${encodeURIComponent(parsed.title)}`;
    }),
  };
}

function makeLoader(stub: SerializerStub): IrealSerializeLoader {
  return vi.fn(
    async () => stub as unknown as Awaited<ReturnType<IrealSerializeLoader>>,
  );
}

describe('useIrealSerialize', () => {
  test('returns URL when song serialises successfully', async () => {
    const stub = makeStub();
    const { result } = renderHook(() =>
      useIrealSerialize(songFixture(), makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current.url).toBe('irealb://t/Test');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test('null song short-circuits to loading=false / url=null', async () => {
    const stub = makeStub();
    const { result } = renderHook(() =>
      useIrealSerialize(null, makeLoader(stub)),
    );
    // Synchronous initial state: nothing to serialise.
    expect(result.current.url).toBeNull();
    expect(result.current.error).toBeNull();
    // After the effect runs the state stays at the null short-circuit.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });

  test('serializeIrealb failure surfaces via error state', async () => {
    const stub = makeStub();
    stub.serializeIrealb.mockImplementation(() => {
      throw new Error('cannot serialise');
    });
    const { result } = renderHook(() =>
      useIrealSerialize(songFixture(), makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.error?.message).toBe('cannot serialise'));
    expect(result.current.url).toBeNull();
  });

  test('wasm-init failure surfaces via error state', async () => {
    const stub = makeStub();
    stub.default.mockImplementation(async () => {
      throw new Error('init failed');
    });
    const { result } = renderHook(() =>
      useIrealSerialize(songFixture(), makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.error?.message).toBe('init failed'));
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });

  test('song change re-serialises (memoised against song identity)', async () => {
    const stub = makeStub();
    const a = songFixture();
    const b = { ...songFixture(), title: 'Updated' };
    const { result, rerender } = renderHook(
      ({ song }: { song: IrealSong }) =>
        useIrealSerialize(song, makeLoader(stub)),
      { initialProps: { song: a } },
    );
    await waitFor(() => expect(result.current.url).toBe('irealb://t/Test'));
    rerender({ song: b });
    await waitFor(() => expect(result.current.url).toBe('irealb://t/Updated'));
    expect(stub.serializeIrealb).toHaveBeenCalledTimes(2);
  });
});
