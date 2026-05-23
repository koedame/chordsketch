import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { PDF_EXPORT_DEFAULT_LABEL, PreviewToolbar } from '../src/index';
import type { WasmLoader } from '../src/use-pdf-export';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function makePdfStub(): {
  default: ReturnType<typeof vi.fn>;
  render_pdf: ReturnType<typeof vi.fn>;
  render_pdf_with_options: ReturnType<typeof vi.fn>;
} {
  return {
    default: vi.fn(async () => undefined),
    render_pdf: vi.fn(() => PDF_BYTES),
    render_pdf_with_options: vi.fn(() => PDF_BYTES),
  };
}

function makePdfLoader(stub: ReturnType<typeof makePdfStub>): WasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<WasmLoader>>);
}

const SAMPLE = '{title: Demo}\n{key: G}\n[C]Hello';

describe('<PreviewToolbar>', () => {
  test('renders all three groups by default when onSourceChange is provided', () => {
    render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={0}
        onTransposeChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('toolbar', { name: 'Preview performance controls' }),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Capo' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Export' })).toBeTruthy();
  });

  test('forwards exportFilename to the inner <PdfExport> download anchor', async () => {
    // The toolbar wraps <PdfExport> and is responsible for plumbing
    // `exportFilename` through to `<PdfExport filename={...}>`. If a
    // future refactor drops or renames the prop, the underlying anchor
    // falls back to the <PdfExport> default (`chordsketch-output.pdf`),
    // and the user receives the wrong filename on click with zero
    // build- or render-time signal. Assert via the anchor's `download`
    // attribute captured at click time — that is the surface the
    // browser actually consumes, so a regression at any layer between
    // the prop and the anchor surfaces here.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:fake'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
    let capturedFilename: string | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function clickSpy(this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });

    const stub = makePdfStub();
    render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={0}
        onTransposeChange={vi.fn()}
        exportFilename="my-song.pdf"
        wasmLoader={makePdfLoader(stub)}
      />,
    );
    const exportGroup = screen.getByRole('group', { name: 'Export' });
    const button = within(exportGroup).getByRole('button', {
      name: PDF_EXPORT_DEFAULT_LABEL,
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(capturedFilename).toBe('my-song.pdf');
    // Sanity check the source / options round-trip while we have the
    // stub wired: a regression that dropped `source` would also
    // surface here, not silently in production. The toolbar always
    // passes `options={{ transpose }}` with the current value (here
    // `0`), so `usePdfExport` routes through `render_pdf_with_options`
    // rather than `render_pdf` per the branch at
    // `packages/react/src/use-pdf-export.ts:187-189`.
    expect(stub.render_pdf_with_options).toHaveBeenCalledWith(SAMPLE, {
      transpose: 0,
    });
    expect(stub.render_pdf).not.toHaveBeenCalled();
    // Restore the anchor-click prototype mock so subsequent tests in
    // this file (or in tests sharing the jsdom environment) do not
    // inherit our captured-filename behaviour.
    clickSpy.mockRestore();
  });

  test('exposes the shared PDF export button label inside the Export group', () => {
    // The Export group composes <PdfExport> with an explicit children
    // node (icon + label). If a future refactor drops the literal or
    // overrides it inconsistently with the shared default, the rendered
    // accessible name diverges from `PdfExport`'s default and from the
    // other call sites that inherit it. Scope the assertion to the
    // Export group so an unrelated <PdfExport> mounted elsewhere in
    // the toolbar by a future refactor cannot mask a regression here.
    render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={0}
        onTransposeChange={vi.fn()}
      />,
    );
    const exportGroup = screen.getByRole('group', { name: 'Export' });
    expect(
      within(exportGroup).getByRole('button', {
        name: PDF_EXPORT_DEFAULT_LABEL,
      }),
    ).toBeTruthy();
  });

  test('hides Capo when onSourceChange is omitted', () => {
    render(
      <PreviewToolbar
        source={SAMPLE}
        transpose={0}
        onTransposeChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('group', { name: 'Capo' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
  });

  test('per-group opt-out: showTranspose/showExport=false', () => {
    render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={0}
        onTransposeChange={vi.fn()}
        showTranspose={false}
        showExport={false}
      />,
    );
    expect(screen.queryByRole('group', { name: 'Transpose' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Export' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Capo' })).toBeTruthy();
  });

  test('Transpose button disables at min/max boundaries', () => {
    const onTranspose = vi.fn();
    const { rerender } = render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={-11}
        onTransposeChange={onTranspose}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Transpose down one semitone' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    rerender(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={11}
        onTransposeChange={onTranspose}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Transpose up one semitone' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test('Capo group writes {capo} into source via onSourceChange', () => {
    const onSourceChange = vi.fn();
    render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={onSourceChange}
        transpose={0}
        onTransposeChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Capo up one fret' }));
    expect(onSourceChange).toHaveBeenCalledWith(
      '{title: Demo}\n{key: G}\n{capo: 1}\n[C]Hello',
    );
  });

  test('trailing slot renders as a fourth group', () => {
    render(
      <PreviewToolbar
        source={SAMPLE}
        onSourceChange={vi.fn()}
        transpose={0}
        onTransposeChange={vi.fn()}
        trailing={<button type="button">Send</button>}
      />,
    );
    expect(screen.getByRole('group', { name: 'Additional actions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});
