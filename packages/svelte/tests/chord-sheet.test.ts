import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChordSheet } from '../src/index';
import { __resetInjectedCss } from '../src/renderer-css';
import SheetErrorSuppressed from './harness/SheetErrorSuppressed.svelte';
import SheetSnippets from './harness/SheetSnippets.svelte';
import { makeRenderLoader, makeRenderStub } from './stubs';

const SOURCE = '{title: Test}\n[C]Hello';

afterEach(cleanup);

beforeEach(() => {
  __resetInjectedCss();
  document.head.querySelectorAll('style[data-chordsketch-svelte]').forEach((el) => el.remove());
});

describe('ChordSheet', () => {
  test('renders the renderer body fragment inside the content wrapper', async () => {
    const stub = makeRenderStub();
    const { container } = render(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });

    await waitFor(() => expect(stub.render_html_body).toHaveBeenCalledWith(SOURCE));
    const content = container.querySelector('.chordsketch-sheet__content')!;
    expect(content.innerHTML).toContain('<article class="song">');
    expect(container.querySelector('.chordsketch-sheet')!.getAttribute('aria-busy')).toBeNull();
  });

  test('injects the renderer stylesheet, scoped to the content wrapper', async () => {
    render(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(makeRenderStub()) },
    });

    await waitFor(() => {
      const style = document.head.querySelector('style[data-chordsketch-svelte]');
      expect(style?.textContent).toContain('.chordsketch-sheet__content .chord');
    });
  });

  test('renders plain text inside a <pre> when format is "text"', async () => {
    const stub = makeRenderStub();
    const { container } = render(ChordSheet, {
      props: { source: SOURCE, format: 'text', wasmLoader: makeRenderLoader(stub) },
    });

    await waitFor(() =>
      expect(container.querySelector('pre.chordsketch-sheet__text')?.textContent).toBe(
        `TEXT ${SOURCE}`,
      ),
    );
    expect(stub.render_html_body).not.toHaveBeenCalled();
    // The text branch carries no renderer stylesheet — it is not HTML.
    expect(document.head.querySelector('style[data-chordsketch-svelte]')).toBeNull();
  });

  test('marks itself busy and shows the loading snippet until the first render lands', async () => {
    const { container } = render(SheetSnippets, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(makeRenderStub()) },
    });

    const sheet = container.querySelector('.chordsketch-sheet')!;
    expect(sheet.getAttribute('aria-busy')).toBe('true');
    expect(sheet.textContent).toContain('Rendering…');

    await waitFor(() => expect(sheet.getAttribute('aria-busy')).toBeNull());
    expect(sheet.textContent).not.toContain('Rendering…');
  });

  test('forwards transpose and config through the options-aware export', async () => {
    const stub = makeRenderStub();
    const { rerender } = render(ChordSheet, {
      props: { source: SOURCE, transpose: 2, wasmLoader: makeRenderLoader(stub) },
    });

    await waitFor(() =>
      expect(stub.render_html_body_with_options).toHaveBeenCalledWith(SOURCE, {
        transpose: 2,
        config: undefined,
      }),
    );

    await rerender({ transpose: -3, config: 'ukulele' });
    await waitFor(() =>
      expect(stub.render_html_body_with_options).toHaveBeenLastCalledWith(SOURCE, {
        transpose: -3,
        config: 'ukulele',
      }),
    );
  });

  test('re-renders when the source changes, reusing the initialised module', async () => {
    const stub = makeRenderStub();
    const { container, rerender } = render(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });
    await waitFor(() => expect(stub.render_html_body).toHaveBeenCalled());

    await rerender({ source: '[G]Bye' });
    await waitFor(() => expect(stub.render_html_body).toHaveBeenLastCalledWith('[G]Bye'));
    expect(container.querySelector('.chordsketch-sheet__content')!.innerHTML).toContain('[G]Bye');
    // The module is initialised once and reused across renders.
    expect(stub.default).toHaveBeenCalledTimes(1);
  });

  test('surfaces a render error inline and keeps the previous output visible', async () => {
    const stub = makeRenderStub();
    const { container, rerender } = render(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });
    await waitFor(() => expect(stub.render_html_body).toHaveBeenCalled());

    stub.render_html_body.mockImplementationOnce(() => {
      throw new Error('unbalanced brace');
    });
    await rerender({ source: '{title' });

    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('unbalanced brace'),
    );
    // A half-typed edit must not blank the preview.
    expect(container.querySelector('.chordsketch-sheet__content')!.innerHTML).toContain(
      '[C]Hello',
    );
  });

  test('an empty error snippet suppresses the inline alert', async () => {
    const stub = makeRenderStub({
      render_html_body: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const { container } = render(SheetErrorSuppressed, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });

    await waitFor(() => expect(stub.render_html_body).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('the error snippet receives the error', async () => {
    const stub = makeRenderStub({
      render_html_body: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const { container } = render(SheetSnippets, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });

    await waitFor(() => expect(container.textContent).toContain('failed: boom'));
  });
});
