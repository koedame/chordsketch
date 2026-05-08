// Verifies the format-toggle blank-preview defence introduced in
// #2421: every iframe `srcdoc` write must produce a byte-different
// string from the previous write, so Chromium's same-value
// skip-navigation quirk cannot leave the iframe blank when the user
// toggles HTML → Text → HTML on unchanged input. The previous defence
// (empty-then-set in #2321 / PR #2322) relied on two synchronous
// writes that the browser could coalesce; this test pins the
// stronger contract that the FINAL value differs every time.

import { describe, expect, test, vi } from 'vitest';
import { mountChordSketchUi, type Renderers } from '../src/index';

const HTML_BODY = '<style>body{}</style><div class="song">SAMPLE</div>';

function makeRenderers(): Renderers {
  return {
    init: vi.fn(() => Promise.resolve()),
    // Returning a constant here is the point: even when the rendered
    // body is byte-equal across renders, the host wrapper MUST emit a
    // different `srcdoc` string every time.
    renderHtml: vi.fn(() => HTML_BODY),
    renderText: vi.fn(() => 'SAMPLE_TEXT'),
    renderPdf: vi.fn(() => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  };
}

function getPreviewIframe(root: HTMLElement): HTMLIFrameElement {
  const iframe = root.querySelector('iframe');
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error('preview iframe not mounted');
  }
  return iframe;
}

function getFormatSelect(root: HTMLElement): HTMLSelectElement {
  const select = root.querySelector<HTMLSelectElement>('select#format');
  if (select === null) {
    throw new Error('format select not mounted');
  }
  return select;
}

describe('srcdoc cache-bust (#2421)', () => {
  test('html → text → html toggle produces a byte-different srcdoc', async () => {
    const renderers = makeRenderers();
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '{title: Sample}\n[C]hello',
    });

    const iframe = getPreviewIframe(root);
    const select = getFormatSelect(root);

    // Mount-time render is HTML by default.
    const initialSrcdoc = iframe.srcdoc;
    expect(initialSrcdoc).toContain(HTML_BODY);

    // Toggle to text — iframe is hidden, srcdoc retains its value.
    select.value = 'text';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(iframe.srcdoc).toBe(initialSrcdoc);

    // Toggle back to html. Even though `renderHtml` returns a
    // byte-equal body, the iframe srcdoc MUST differ from the
    // previous write so Chromium cannot elide the navigation.
    select.value = 'html';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(iframe.srcdoc).not.toBe(initialSrcdoc);
    // Body is still embedded — the change is a marker, not a payload
    // shape change.
    expect(iframe.srcdoc).toContain(HTML_BODY);

    handle.destroy();
    root.remove();
  });

  test('every render with constant input still increments the marker', async () => {
    const renderers = makeRenderers();
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '{title: Sample}\n[C]hello',
    });

    const iframe = getPreviewIframe(root);
    const select = getFormatSelect(root);

    const seen = new Set<string>();
    seen.add(iframe.srcdoc);
    for (let i = 0; i < 5; i++) {
      select.value = 'text';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.value = 'html';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      seen.add(iframe.srcdoc);
    }
    // 1 mount-time + 5 toggle-back-to-html writes = 6 distinct
    // srcdoc strings. A regression that drops the cache-bust would
    // collapse this set down to 1.
    expect(seen.size).toBe(6);

    handle.destroy();
    root.remove();
  });
});
