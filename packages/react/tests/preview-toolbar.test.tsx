import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { PDF_EXPORT_DEFAULT_LABEL, PreviewToolbar } from '../src/index';

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

  test('Export group exposes the shared PDF export button label', () => {
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
