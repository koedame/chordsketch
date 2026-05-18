import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealPreview } from '../src/ireal-preview';
import type { IrealRenderLoader } from '../src/use-ireal-render';

interface RenderStub {
  default: ReturnType<typeof vi.fn>;
  renderIrealSvg: ReturnType<typeof vi.fn>;
}

function makeStub(): RenderStub {
  return {
    default: vi.fn(async () => undefined),
    renderIrealSvg: vi.fn(
      (input: string) => `<svg data-testid="ireal-svg">${input}</svg>`,
    ),
  };
}

function makeLoader(stub: RenderStub): IrealRenderLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<IrealRenderLoader>>);
}

describe('<IrealPreview>', () => {
  test('renders SVG returned by renderIrealSvg', async () => {
    const stub = makeStub();
    render(<IrealPreview source="irealb://demo" loader={makeLoader(stub)} />);
    await waitFor(() =>
      expect(stub.renderIrealSvg).toHaveBeenCalledWith('irealb://demo'),
    );
    await waitFor(() => {
      expect(screen.getByTestId('ireal-svg').textContent).toBe('irealb://demo');
    });
  });

  test('empty source skips wasm call and renders nothing', async () => {
    const stub = makeStub();
    const { container } = render(
      <IrealPreview source="" loader={makeLoader(stub)} />,
    );
    // Wait for the loader to settle so we know the effect has run.
    await waitFor(() => expect(stub.default).toHaveBeenCalled());
    expect(stub.renderIrealSvg).not.toHaveBeenCalled();
    expect(container.querySelector('.chordsketch-ireal-preview__svg')).toBeNull();
  });

  test('renderer errors surface via the default alert', async () => {
    const stub = makeStub();
    stub.renderIrealSvg.mockImplementation(() => {
      throw new Error('render boom');
    });
    render(<IrealPreview source="irealb://x" loader={makeLoader(stub)} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('render boom');
    });
  });

  test('errorFallback=null suppresses the inline alert', async () => {
    const stub = makeStub();
    stub.renderIrealSvg.mockImplementation(() => {
      throw new Error('hidden');
    });
    const { container } = render(
      <IrealPreview source="irealb://x" loader={makeLoader(stub)} errorFallback={null} />,
    );
    await waitFor(() => expect(stub.renderIrealSvg).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('errorFallback function receives the error', async () => {
    const stub = makeStub();
    stub.renderIrealSvg.mockImplementation(() => {
      throw new Error('boom');
    });
    render(
      <IrealPreview
        source="irealb://x"
        loader={makeLoader(stub)}
        errorFallback={(err) => <p data-testid="custom">Got: {err.message}</p>}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('custom').textContent).toBe('Got: boom');
    });
  });
});
