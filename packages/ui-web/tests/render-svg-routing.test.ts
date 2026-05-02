// Tests the iReal Pro SVG preview-routing path added in #2362.
//
// The contract under test: when the editor body starts with
// `irealb://` / `irealbook://` AND `renderers.renderSvg` is
// supplied, the preview iframe receives the SVG wrapped in
// `HTML_FRAME_TEMPLATE` instead of the ChordPro HTML output.
// When `renderSvg` is absent, the existing ChordPro path runs
// unchanged.

import { describe, expect, test, vi } from 'vitest';
import { mountChordSketchUi, type Renderers } from '../src/index';
import { SAMPLE_IREALB } from '../src/sample';

const SVG_BODY = '<?xml version="1.0" encoding="UTF-8"?>\n<svg width="1"></svg>';
const HTML_BODY = '<style>body{}</style><div class="song">CHORDPRO_HTML</div>';

function makeRenderers(overrides: Partial<Renderers> = {}): Renderers {
  return {
    init: vi.fn(() => Promise.resolve()),
    renderHtml: vi.fn(() => HTML_BODY),
    renderText: vi.fn(() => 'CHORDPRO_TEXT'),
    renderPdf: vi.fn(() => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    ...overrides,
  };
}

function getPreviewIframe(root: HTMLElement): HTMLIFrameElement {
  const iframe = root.querySelector('iframe');
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error('preview iframe not mounted');
  }
  return iframe;
}

describe('iReal Pro SVG routing', () => {
  test('routes irealb:// input to renderSvg and writes srcdoc', async () => {
    const renderSvg = vi.fn(() => SVG_BODY);
    const renderers = makeRenderers({ renderSvg });
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      // Empty initial content prevents the mount-time render from
      // calling renderHtml, so the assertions below cleanly observe
      // only the post-`setChordPro` render path.
      initialChordPro: '',
    });
    // Clear mount-time call history so the assertions below count
    // only the renders triggered by `setChordPro`.
    vi.clearAllMocks();
    handle.setChordPro(SAMPLE_IREALB);

    expect(renderSvg).toHaveBeenCalledTimes(1);
    expect(renderSvg).toHaveBeenCalledWith(SAMPLE_IREALB);
    expect(renderers.renderHtml).not.toHaveBeenCalled();

    const iframe = getPreviewIframe(root);
    expect(iframe.srcdoc).toContain(SVG_BODY);
    // The frame wrapper is the same envelope used for the ChordPro
    // HTML branch — verifies the SVG is wrapped exactly once, not
    // double-wrapped.
    expect(iframe.srcdoc).toContain('<!DOCTYPE html>');
    expect(iframe.srcdoc.match(/<!DOCTYPE/g)?.length).toBe(1);

    handle.destroy();
    root.remove();
  });

  test('routes irealbook:// input to renderSvg', async () => {
    const renderSvg = vi.fn(() => SVG_BODY);
    const renderers = makeRenderers({ renderSvg });
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      // Empty initial content prevents the mount-time render from
      // calling renderHtml, so the assertions below cleanly observe
      // only the post-`setChordPro` render path.
      initialChordPro: '',
    });
    // Clear mount-time call history so the assertions below count
    // only the renders triggered by `setChordPro`.
    vi.clearAllMocks();
    const collectionUrl =
      'irealbook://%50%6C%61%79%6C%69%73%74%3D%51%75%69%63%6B%62%6F%6F%6B';
    handle.setChordPro(collectionUrl);

    expect(renderSvg).toHaveBeenCalledTimes(1);
    // Pin the input that flowed into renderSvg so a regression that
    // truncates or rewrites the URL en route is caught.
    expect(renderSvg).toHaveBeenCalledWith(collectionUrl);
    expect(renderers.renderHtml).not.toHaveBeenCalled();

    handle.destroy();
    root.remove();
  });

  test('falls back to ChordPro renderHtml when renderSvg is absent', async () => {
    const renderers = makeRenderers(); // no renderSvg
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      // Empty initial content prevents the mount-time render from
      // calling renderHtml, so the assertions below cleanly observe
      // only the post-`setChordPro` render path.
      initialChordPro: '',
    });
    // Clear mount-time call history so the assertions below count
    // only the renders triggered by `setChordPro`.
    vi.clearAllMocks();
    handle.setChordPro(SAMPLE_IREALB);

    // No renderSvg → existing ChordPro path is taken: renderHtml
    // is invoked, srcdoc carries the HTML body fragment, and no
    // SVG appears in the preview. Pre-#2362 byte-equal behaviour
    // is preserved exactly when the host opts out of the iReal
    // pipeline.
    expect(renderers.renderHtml).toHaveBeenCalledTimes(1);
    const iframe = getPreviewIframe(root);
    expect(iframe.srcdoc).toContain('CHORDPRO_HTML');
    expect(iframe.srcdoc).not.toContain('<svg');

    handle.destroy();
    root.remove();
  });

  test('plain ChordPro input keeps using renderHtml even when renderSvg is supplied', async () => {
    const renderSvg = vi.fn(() => SVG_BODY);
    const renderers = makeRenderers({ renderSvg });
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      // Empty initial content prevents the mount-time render from
      // calling renderHtml, so the assertions below cleanly observe
      // only the post-`setChordPro` render path.
      initialChordPro: '',
    });
    // Clear mount-time call history so the assertions below count
    // only the renders triggered by `setChordPro`.
    vi.clearAllMocks();
    handle.setChordPro('{title: Hello}\n[C]Hello [G]world');

    // Plain ChordPro must NOT trigger the SVG path even when the
    // host advertises a `renderSvg`. This is the regression guard
    // for "the existing ChordPro path is unchanged" in the AC.
    expect(renderSvg).not.toHaveBeenCalled();
    expect(renderers.renderHtml).toHaveBeenCalledTimes(1);

    handle.destroy();
    root.remove();
  });

  test('leading whitespace in front of the iReal URL still routes to renderSvg', async () => {
    // Mirrors the CLI's `trim_start()` behaviour so a file that
    // accidentally starts with whitespace is still classified as
    // iReal — the ui-web sniffer uses the same logic.
    const renderSvg = vi.fn(() => SVG_BODY);
    const renderers = makeRenderers({ renderSvg });
    const root = document.createElement('div');
    document.body.appendChild(root);

    const handle = await mountChordSketchUi(root, {
      renderers,
      // Empty initial content prevents the mount-time render from
      // calling renderHtml, so the assertions below cleanly observe
      // only the post-`setChordPro` render path.
      initialChordPro: '',
    });
    // Clear mount-time call history so the assertions below count
    // only the renders triggered by `setChordPro`.
    vi.clearAllMocks();
    const padded = `   \n  ${SAMPLE_IREALB}`;
    handle.setChordPro(padded);

    expect(renderSvg).toHaveBeenCalledTimes(1);
    // The URL passed through MUST be the original (whitespace-and-all)
    // — ui-web does NOT strip the leading whitespace before forwarding
    // to renderSvg. Pinning this ensures a future refactor that adds
    // a "normalize leading whitespace" pass at the routing site has
    // to update both the input contract and this assertion together.
    expect(renderSvg).toHaveBeenCalledWith(padded);
    expect(renderers.renderHtml).not.toHaveBeenCalled();

    handle.destroy();
    root.remove();
  });
});
