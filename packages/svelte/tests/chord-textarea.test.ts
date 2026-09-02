import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChordTextarea } from '../src/index';
import { __resetInjectedCss } from '../src/renderer-css';
import TextareaBinding from './harness/TextareaBinding.svelte';
import TextareaSnippets from './harness/TextareaSnippets.svelte';
import { makeRenderLoader, makeRenderStub } from './stubs';

beforeEach(() => {
  __resetInjectedCss();
  document.head.querySelectorAll('style[data-chordsketch-svelte]').forEach((el) => el.remove());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Render the editor with a text-format preview (so the preview pane's
 * text content is the stub's render output verbatim) and no debounce
 * window unless the case is about debouncing.
 */
function renderTextarea(props: Record<string, unknown> = {}) {
  return render(ChordTextarea, {
    props: {
      debounceMs: 0,
      previewFormat: 'text',
      wasmLoader: makeRenderLoader(makeRenderStub()),
      ...props,
    },
  });
}

function preview(container: HTMLElement): HTMLElement {
  return container.querySelector('.chordsketch-textarea__preview') as HTMLElement;
}

/**
 * The preview pane's rendered text. Trimmed because Svelte keeps the
 * template's own whitespace text nodes around the `<pre>`.
 */
function previewText(container: HTMLElement): string {
  return preview(container).textContent?.trim() ?? '';
}

describe('ChordTextarea', () => {
  test('renders the editor and the preview pane', async () => {
    const { container } = renderTextarea({ value: '[C]Hello' });

    expect(container.querySelector('textarea')!.value).toBe('[C]Hello');
    await waitFor(() => expect(previewText(container)).toBe('TEXT+0 [C]Hello'));
  });

  test('writes every keystroke back through bind:value', async () => {
    const { container, getByTestId } = render(TextareaBinding, {
      props: { value: '', wasmLoader: makeRenderLoader(makeRenderStub()) },
    });

    await fireEvent.input(container.querySelector('textarea')!, { target: { value: '[G]' } });
    expect(getByTestId('bound-value').textContent).toBe('[G]');
    await waitFor(() => expect(previewText(container)).toBe('TEXT+0 [G]'));
  });

  test('follows the value when the host changes it', async () => {
    const { container, rerender } = renderTextarea({ value: 'parent' });
    await waitFor(() => expect(previewText(container)).toBe('TEXT+0 parent'));

    await rerender({ value: 'from parent' });
    expect(container.querySelector('textarea')!.value).toBe('from parent');
    await waitFor(() => expect(previewText(container)).toBe('TEXT+0 from parent'));
  });

  test('debounces the preview behind the editor', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderTextarea({ value: 'a', debounceMs: 250 });
      await vi.advanceTimersByTimeAsync(0);
      expect(previewText(container)).toBe('TEXT+0 a');

      await fireEvent.input(container.querySelector('textarea')!, { target: { value: 'ab' } });
      await vi.advanceTimersByTimeAsync(0);
      // Still showing the pre-edit render.
      expect(previewText(container)).toBe('TEXT+0 a');

      await vi.advanceTimersByTimeAsync(250);
      expect(previewText(container)).toBe('TEXT+0 ab');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Ctrl/Cmd + Arrow moves the transpose offset one semitone', async () => {
    const { container, getByTestId } = render(TextareaBinding, {
      props: { value: '', wasmLoader: makeRenderLoader(makeRenderStub()) },
    });
    const textarea = container.querySelector('textarea')!;

    await fireEvent.keyDown(textarea, { key: 'ArrowUp', ctrlKey: true });
    expect(getByTestId('bound-transpose').textContent).toBe('1');

    await fireEvent.keyDown(textarea, { key: 'ArrowDown', metaKey: true });
    await fireEvent.keyDown(textarea, { key: 'ArrowDown', metaKey: true });
    expect(getByTestId('bound-transpose').textContent).toBe('-1');
  });

  test('the shortcut stops at the bounds', async () => {
    const { container, getByTestId } = render(TextareaBinding, {
      props: {
        value: '',
        transpose: 1,
        transposeMin: -1,
        transposeMax: 1,
        wasmLoader: makeRenderLoader(makeRenderStub()),
      },
    });
    const textarea = container.querySelector('textarea')!;

    await fireEvent.keyDown(textarea, { key: 'ArrowUp', ctrlKey: true });
    expect(getByTestId('bound-transpose').textContent).toBe('1');

    await fireEvent.keyDown(textarea, { key: 'ArrowDown', ctrlKey: true });
    await fireEvent.keyDown(textarea, { key: 'ArrowDown', ctrlKey: true });
    await fireEvent.keyDown(textarea, { key: 'ArrowDown', ctrlKey: true });
    expect(getByTestId('bound-transpose').textContent).toBe('-1');
  });

  test('a plain Arrow key is left to the browser', async () => {
    const { container, getByTestId } = render(TextareaBinding, {
      props: { value: '', wasmLoader: makeRenderLoader(makeRenderStub()) },
    });

    const handled = await fireEvent.keyDown(container.querySelector('textarea')!, {
      key: 'ArrowUp',
    });
    // `fireEvent` returns false when a listener called preventDefault.
    expect(handled).toBe(true);
    expect(getByTestId('bound-transpose').textContent).toBe('0');
  });

  test('inverted bounds are swapped, with a dev warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container, getByTestId } = render(TextareaBinding, {
      props: {
        value: '',
        transposeMin: 3,
        transposeMax: -3,
        wasmLoader: makeRenderLoader(makeRenderStub()),
      },
    });

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(error.mock.calls[0][0]).toContain('transposeMin');

    await fireEvent.keyDown(container.querySelector('textarea')!, {
      key: 'ArrowUp',
      ctrlKey: true,
    });
    // Swapped to [-3, 3], so the shortcut still works.
    expect(getByTestId('bound-transpose').textContent).toBe('1');
  });

  test('forwards transpose and config to the preview, clamped into the bounds', async () => {
    const stub = makeRenderStub();
    const { container } = renderTextarea({
      value: '[C]',
      transpose: 99,
      transposeMax: 5,
      config: 'ukulele',
      wasmLoader: makeRenderLoader(stub),
    });

    await waitFor(() =>
      expect(stub.render_text_with_options).toHaveBeenCalledWith('[C]', {
        transpose: 5,
        config: 'ukulele',
      }),
    );
    expect(previewText(container)).toBe('TEXT+5 [C]');
  });

  test('readOnly marks the textarea read-only', () => {
    const { container } = renderTextarea({ value: '', readOnly: true });
    expect(container.querySelector('textarea')!.readOnly).toBe(true);
  });

  test('labels the textarea and disables the browser form assists', () => {
    const { container } = renderTextarea({ value: '' });
    const textarea = container.querySelector('textarea')!;

    expect(textarea.getAttribute('aria-label')).toBe('ChordPro editor');
    expect(textarea.getAttribute('placeholder')).toBe('Enter ChordPro source here…');
    expect(textarea.getAttribute('spellcheck')).toBe('false');
    expect(textarea.getAttribute('autocorrect')).toBe('off');
    expect(textarea.getAttribute('autocapitalize')).toBe('off');
    expect(textarea.getAttribute('autocomplete')).toBe('off');
  });

  test('forwards the loading and error snippets to the preview', async () => {
    const stub = makeRenderStub({
      render_html_body_with_options: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const { container } = render(TextareaSnippets, {
      props: { value: '[C]', wasmLoader: makeRenderLoader(stub) },
    });

    expect(previewText(container)).toContain('Rendering…');
    await waitFor(() => expect(previewText(container)).toContain('failed: boom'));
  });
});
