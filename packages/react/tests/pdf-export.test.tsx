import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PdfExport, usePdfExport } from '../src/index';
import type { WasmLoader } from '../src/use-pdf-export';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" magic bytes

interface StubRenderer {
  default: ReturnType<typeof vi.fn>;
  render_pdf: ReturnType<typeof vi.fn>;
  render_pdf_with_options: ReturnType<typeof vi.fn>;
}

function makeStubRenderer(): StubRenderer {
  return {
    default: vi.fn(async () => undefined),
    render_pdf: vi.fn(() => PDF_BYTES),
    render_pdf_with_options: vi.fn(() => PDF_BYTES),
  };
}

function makeLoader(stub: StubRenderer): WasmLoader {
  // The `usePdfExport` hook accepts any loader returning a
  // structurally compatible renderer; casting here is safe because
  // the stub implements the narrow surface the hook touches.
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<WasmLoader>>);
}

function installBlobUrlStubs(): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  // jsdom does not implement URL.createObjectURL; stub it so
  // triggerDownload's blob flow runs.
  const create = vi.fn(() => 'blob:fake');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
  return { create, revoke };
}

describe('usePdfExport', () => {
  let blobStubs: ReturnType<typeof installBlobUrlStubs>;

  beforeEach(() => {
    blobStubs = installBlobUrlStubs();
  });

  test('exportPdf renders, downloads, and cleans up', async () => {
    const stub = makeStubRenderer();
    const { result } = renderHook(() => usePdfExport(makeLoader(stub)));

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');

    await act(async () => {
      await result.current.exportPdf('{title: Test}\n[C]Hello', 'song.pdf');
    });

    expect(stub.default).toHaveBeenCalledTimes(1);
    expect(stub.render_pdf).toHaveBeenCalledWith('{title: Test}\n[C]Hello');
    expect(stub.render_pdf_with_options).not.toHaveBeenCalled();
    expect(blobStubs.create).toHaveBeenCalledTimes(1);
    expect(blobStubs.revoke).toHaveBeenCalledWith('blob:fake');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Anchor is removed after click — no stray <a> left in the DOM.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test('options are forwarded to render_pdf_with_options when transpose is set', async () => {
    const stub = makeStubRenderer();
    const { result } = renderHook(() => usePdfExport(makeLoader(stub)));

    await act(async () => {
      await result.current.exportPdf('{title: T}', 'song.pdf', { transpose: 2 });
    });

    expect(stub.render_pdf).not.toHaveBeenCalled();
    expect(stub.render_pdf_with_options).toHaveBeenCalledWith('{title: T}', { transpose: 2 });
  });

  test('WASM module is loaded exactly once across repeated calls', async () => {
    const stub = makeStubRenderer();
    const loader = makeLoader(stub);
    const { result } = renderHook(() => usePdfExport(loader));

    await act(async () => {
      await result.current.exportPdf('a', 'a.pdf');
      await result.current.exportPdf('b', 'b.pdf');
      await result.current.exportPdf('c', 'c.pdf');
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(stub.default).toHaveBeenCalledTimes(1);
    expect(stub.render_pdf).toHaveBeenCalledTimes(3);
  });

  test('render failure surfaces through error state and promise rejection', async () => {
    const boom = new Error('parse failed');
    const stub = makeStubRenderer();
    stub.render_pdf.mockImplementation(() => {
      throw boom;
    });
    const { result } = renderHook(() => usePdfExport(makeLoader(stub)));

    // The `exportPdf` rejection is caught here; the state update it
    // schedules still lands on the React tree, but act() completes
    // before the failing promise propagates so we have to assert
    // against the post-commit state via waitFor.
    await act(async () => {
      await result.current.exportPdf('bad', 'bad.pdf').catch((e: unknown) => {
        expect(e).toBe(boom);
      });
    });

    await waitFor(() => expect(result.current.error).toBe(boom));
    expect(result.current.loading).toBe(false);
  });
});

describe('<PdfExport>', () => {
  beforeEach(() => {
    installBlobUrlStubs();
  });

  test('renders a button and downloads on click', async () => {
    const stub = makeStubRenderer();
    const onExported = vi.fn();

    render(
      <PdfExport
        source="{title: Hi}"
        filename="hi.pdf"
        onExported={onExported}
        wasmLoader={makeLoader(stub)}
      >
        Save as PDF
      </PdfExport>,
    );

    const button = screen.getByRole('button', { name: 'Save as PDF' });
    expect(button.hasAttribute('disabled')).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(stub.render_pdf).toHaveBeenCalled());
    await waitFor(() => expect(onExported).toHaveBeenCalledWith('hi.pdf'));
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  test('disables itself and sets aria-busy while rendering', async () => {
    const stub = makeStubRenderer();
    // Hold the render open so the button is observed mid-flight.
    let resolveRender!: () => void;
    stub.render_pdf.mockImplementation(() => {
      // render_pdf is synchronous in the real API; the hold is
      // simulated by having `default()` (init) await a pending
      // promise instead, so the button observes `loading=true`
      // before render_pdf fires.
      return PDF_BYTES;
    });
    let releaseInit!: () => void;
    stub.default.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseInit = resolve;
        }),
    );
    resolveRender = () => releaseInit();

    render(<PdfExport source="x" filename="x.pdf" wasmLoader={makeLoader(stub)} />);
    const button = screen.getByRole('button', { name: 'Export PDF' });

    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    expect(button.getAttribute('aria-busy')).toBe('true');

    resolveRender();
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  test('calls onError when the render rejects', async () => {
    const boom = new Error('render kaboom');
    const stub = makeStubRenderer();
    stub.render_pdf.mockImplementation(() => {
      throw boom;
    });
    const onError = vi.fn();

    render(
      <PdfExport source="x" filename="x.pdf" onError={onError} wasmLoader={makeLoader(stub)} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(boom));
  });
});
