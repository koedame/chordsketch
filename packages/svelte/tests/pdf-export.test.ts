import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PDF_EXPORT_DEFAULT_LABEL, PdfExport, usePdfExport } from '../src/index';
import { triggerDownload, type WasmLoader } from '../src/use-pdf-export.svelte';
import PdfExportSnippets from './harness/PdfExportSnippets.svelte';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" magic bytes
const SOURCE = '{title: Test}\n[C]Hello';

interface PdfStub {
  default: ReturnType<typeof vi.fn>;
  render_pdf: ReturnType<typeof vi.fn>;
  render_pdf_with_options: ReturnType<typeof vi.fn>;
}

function makePdfStub(overrides: Partial<PdfStub> = {}): PdfStub {
  return {
    default: vi.fn(async () => undefined),
    render_pdf: vi.fn(() => PDF_BYTES),
    render_pdf_with_options: vi.fn(() => PDF_BYTES),
    ...overrides,
  };
}

function makePdfLoader(stub: PdfStub): WasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<WasmLoader>>);
}

// jsdom does not implement URL.createObjectURL; stub it so
// `triggerDownload`'s blob flow runs.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let click: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:fake');
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  // Stub the anchor click as well: jsdom answers a real one with an
  // unimplemented-navigation error on the timer queue, which would
  // bury the test output in stack traces.
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('usePdfExport', () => {
  test('renders, downloads, and cleans up', async () => {
    const stub = makePdfStub();
    const pdf = usePdfExport(makePdfLoader(stub));

    await pdf.exportPdf(SOURCE, 'song.pdf');

    expect(stub.default).toHaveBeenCalledTimes(1);
    expect(stub.render_pdf).toHaveBeenCalledWith(SOURCE);
    expect(stub.render_pdf_with_options).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    // The anchor is removed after the click — no stray node is left.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(pdf.loading).toBe(false);
    expect(pdf.error).toBeNull();
  });

  test('forwards options through the options-aware export', async () => {
    const stub = makePdfStub();
    const pdf = usePdfExport(makePdfLoader(stub));

    await pdf.exportPdf(SOURCE, 'song.pdf', { transpose: 2 });
    expect(stub.render_pdf_with_options).toHaveBeenCalledWith(SOURCE, { transpose: 2 });
    expect(stub.render_pdf).not.toHaveBeenCalled();
  });

  test('an empty options object still takes the plain export', async () => {
    const stub = makePdfStub();
    const pdf = usePdfExport(makePdfLoader(stub));

    await pdf.exportPdf(SOURCE, 'song.pdf', {});
    expect(stub.render_pdf).toHaveBeenCalledTimes(1);
  });

  test('a render failure sets the error state and rejects', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const pdf = usePdfExport(makePdfLoader(stub));

    await expect(pdf.exportPdf(SOURCE, 'song.pdf')).rejects.toThrow('render failed');
    expect(pdf.error?.message).toBe('render failed');
    expect(pdf.loading).toBe(false);
  });

  test('a failed module load is retried on the next call', async () => {
    const stub = makePdfStub();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(stub) as unknown as WasmLoader;
    const pdf = usePdfExport(loader);

    await expect(pdf.exportPdf(SOURCE, 'song.pdf')).rejects.toThrow('offline');
    await expect(pdf.exportPdf(SOURCE, 'song.pdf')).resolves.toBeUndefined();
    expect(stub.render_pdf).toHaveBeenCalledTimes(1);
  });
});

describe('triggerDownload', () => {
  test('names the download and revokes the object URL', () => {
    triggerDownload(PDF_BYTES, 'my song.pdf');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});

describe('PdfExport', () => {
  test('renders the default label and exports on click', async () => {
    const stub = makePdfStub();
    const exported: string[] = [];
    const { container } = render(PdfExport, {
      props: {
        source: SOURCE,
        filename: 'song.pdf',
        wasmLoader: makePdfLoader(stub),
        onExported: (name: string) => exported.push(name),
      },
    });

    const button = container.querySelector('button')!;
    expect(button.textContent?.trim()).toBe(PDF_EXPORT_DEFAULT_LABEL);

    await fireEvent.click(button);
    await waitFor(() => expect(exported).toEqual(['song.pdf']));
    expect(stub.render_pdf).toHaveBeenCalledWith(SOURCE);
  });

  test('the children snippet replaces the label', () => {
    const { container } = render(PdfExportSnippets, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(makePdfStub()) },
    });
    expect(container.querySelector('button')!.textContent?.trim()).toBe('Save as PDF');
  });

  test('disables the button and marks it busy while the render is in flight', async () => {
    let release: () => void = () => undefined;
    const stub = makePdfStub({
      default: vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
          }),
      ),
    });
    const { container } = render(PdfExport, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(stub) },
    });
    const button = container.querySelector('button')!;

    await fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
    expect(button.disabled).toBe(true);

    release();
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
    expect(button.disabled).toBe(false);
  });

  test('the disabled prop holds independently of the loading state', () => {
    const { container } = render(PdfExport, {
      props: { source: SOURCE, disabled: true, wasmLoader: makePdfLoader(makePdfStub()) },
    });
    expect(container.querySelector('button')!.disabled).toBe(true);
  });

  test('renders an inline alert and reports the error when the render rejects', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const failures: Error[] = [];
    const { container } = render(PdfExport, {
      props: {
        source: SOURCE,
        wasmLoader: makePdfLoader(stub),
        onError: (err: Error) => failures.push(err),
      },
    });

    await fireEvent.click(container.querySelector('button')!);
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('render failed'),
    );
    expect(failures[0]).toBeInstanceOf(Error);
    // A failed export re-enables the button so the user can retry.
    expect(container.querySelector('button')!.disabled).toBe(false);
  });

  test('an empty error snippet suppresses the inline alert', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const { container } = render(PdfExportSnippets, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(stub), suppressError: true },
    });

    await fireEvent.click(container.querySelector('button')!);
    await waitFor(() => expect(stub.render_pdf).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('host attributes land on the button, alert branch included', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const { container } = render(PdfExport, {
      props: {
        source: SOURCE,
        wasmLoader: makePdfLoader(stub),
        class: 'toolbar__export',
        'data-testid': 'export',
      },
    });
    const button = container.querySelector('button')!;
    expect(button.classList.contains('toolbar__export')).toBe(true);

    await fireEvent.click(button);
    // The error branch renders the alert as a sibling; the attributes
    // must not be dropped when it appears.
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(button.classList.contains('toolbar__export')).toBe(true);
    expect(button.getAttribute('data-testid')).toBe('export');
  });
});
