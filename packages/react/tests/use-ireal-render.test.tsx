import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useIrealRender, type IrealRenderLoader } from '../src/use-ireal-render';

interface RendererStub {
  default: ReturnType<typeof vi.fn>;
  renderIrealSvg: ReturnType<typeof vi.fn>;
}

function makeStub(): RendererStub {
  return {
    default: vi.fn(async () => undefined),
    renderIrealSvg: vi.fn((input: string) => `<svg>${input}</svg>`),
  };
}

function makeLoader(stub: RendererStub): IrealRenderLoader {
  return vi.fn(
    async () => stub as unknown as Awaited<ReturnType<IrealRenderLoader>>,
  );
}

describe('useIrealRender', () => {
  test('returns SVG string after wasm + render resolve', async () => {
    const stub = makeStub();
    const { result } = renderHook(() =>
      useIrealRender('irealb://demo', makeLoader(stub)),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.svg).toBe('<svg>irealb://demo</svg>'));
    expect(result.current.error).toBeNull();
  });

  test('empty source skips wasm call and starts with loading=false', async () => {
    const stub = makeStub();
    const { result } = renderHook(() => useIrealRender('', makeLoader(stub)));
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(stub.default).toHaveBeenCalled());
    expect(stub.renderIrealSvg).not.toHaveBeenCalled();
    expect(result.current.svg).toBeNull();
  });

  test('keeps previous SVG visible when a later render fails (UX promise)', async () => {
    const stub = makeStub();
    const { result, rerender } = renderHook(
      ({ source }: { source: string }) =>
        useIrealRender(source, makeLoader(stub)),
      { initialProps: { source: 'irealb://first' } },
    );
    await waitFor(() => expect(result.current.svg).toBe('<svg>irealb://first</svg>'));
    stub.renderIrealSvg.mockImplementation(() => {
      throw new Error('render boom');
    });
    rerender({ source: 'irealb://second' });
    await waitFor(() => expect(result.current.error?.message).toBe('render boom'));
    // Stale SVG still visible.
    expect(result.current.svg).toBe('<svg>irealb://first</svg>');
  });

  test('wasm-init failure surfaces via error state', async () => {
    const stub = makeStub();
    stub.default.mockImplementation(async () => {
      throw new Error('init boom');
    });
    const { result } = renderHook(() =>
      useIrealRender('irealb://x', makeLoader(stub)),
    );
    await waitFor(() => expect(result.current.error?.message).toBe('init boom'));
    expect(stub.renderIrealSvg).not.toHaveBeenCalled();
  });
});
