import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { h } from 'vue';

import { PDF_EXPORT_DEFAULT_LABEL, PdfExport, usePdfExport } from '../src/index';
import { triggerDownload, type WasmLoader } from '../src/use-pdf-export';

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
  vi.restoreAllMocks();
});

describe('usePdfExport', () => {
  test('renders, downloads, and cleans up', async () => {
    const stub = makePdfStub();
    const { exportPdf, loading, error } = usePdfExport(makePdfLoader(stub));

    await exportPdf(SOURCE, 'song.pdf');

    expect(stub.default).toHaveBeenCalledTimes(1);
    expect(stub.render_pdf).toHaveBeenCalledWith(SOURCE);
    expect(stub.render_pdf_with_options).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    // The anchor is removed after the click — no stray node is left.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(loading.value).toBe(false);
    expect(error.value).toBeNull();
  });

  test('forwards options through the options-aware export', async () => {
    const stub = makePdfStub();
    const { exportPdf } = usePdfExport(makePdfLoader(stub));

    await exportPdf(SOURCE, 'song.pdf', { transpose: 2 });
    expect(stub.render_pdf_with_options).toHaveBeenCalledWith(SOURCE, { transpose: 2 });
    expect(stub.render_pdf).not.toHaveBeenCalled();
  });

  test('an empty options object still takes the plain export', async () => {
    const stub = makePdfStub();
    const { exportPdf } = usePdfExport(makePdfLoader(stub));

    await exportPdf(SOURCE, 'song.pdf', {});
    expect(stub.render_pdf).toHaveBeenCalledTimes(1);
  });

  test('a render failure sets the error ref and rejects', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const { exportPdf, error, loading } = usePdfExport(makePdfLoader(stub));

    await expect(exportPdf(SOURCE, 'song.pdf')).rejects.toThrow('render failed');
    expect(error.value?.message).toBe('render failed');
    expect(loading.value).toBe(false);
  });

  test('a failed module load is retried on the next call', async () => {
    const stub = makePdfStub();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(stub) as unknown as WasmLoader;
    const { exportPdf } = usePdfExport(loader);

    await expect(exportPdf(SOURCE, 'song.pdf')).rejects.toThrow('offline');
    await expect(exportPdf(SOURCE, 'song.pdf')).resolves.toBeUndefined();
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
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, filename: 'song.pdf', wasmLoader: makePdfLoader(stub) },
    });

    expect(wrapper.text()).toBe(PDF_EXPORT_DEFAULT_LABEL);
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(stub.render_pdf).toHaveBeenCalledWith(SOURCE);
    expect(wrapper.emitted('exported')).toEqual([['song.pdf']]);
  });

  test('the default slot replaces the label', () => {
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(makePdfStub()) },
      slots: { default: () => h('span', 'Save as PDF') },
    });
    expect(wrapper.text()).toBe('Save as PDF');
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
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(stub) },
    });

    await wrapper.get('button').trigger('click');
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true');

    release();
    await flushPromises();
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('button').attributes('aria-busy')).toBeUndefined();
  });

  test('the disabled prop holds independently of the loading state', () => {
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, disabled: true, wasmLoader: makePdfLoader(makePdfStub()) },
    });
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  });

  test('renders an inline alert and emits error when the render rejects', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(stub) },
    });

    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe('render failed');
    expect(wrapper.emitted('error')?.[0][0]).toBeInstanceOf(Error);
    // A failed export re-enables the button so the user can retry.
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined();
  });

  test('an empty error slot suppresses the inline alert', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(stub) },
      slots: { error: () => [] },
    });

    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  test('fallthrough attributes land on the button in both branches', async () => {
    const stub = makePdfStub({
      render_pdf: vi.fn(() => {
        throw new Error('render failed');
      }),
    });
    const wrapper = mount(PdfExport, {
      props: { source: SOURCE, wasmLoader: makePdfLoader(stub) },
      attrs: { class: 'toolbar__export', 'data-testid': 'export' },
    });
    expect(wrapper.get('button').classes()).toContain('toolbar__export');

    await wrapper.get('button').trigger('click');
    await flushPromises();
    // The error branch renders a fragment; the attributes must not be
    // dropped when the alert appears next to the button.
    expect(wrapper.get('button').classes()).toContain('toolbar__export');
    expect(wrapper.get('button').attributes('data-testid')).toBe('export');
  });
});
