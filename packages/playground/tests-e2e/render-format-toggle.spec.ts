// Pins the cache-bust contract on the playground's HTML preview
// iframe. #2421 hardened `mountChordSketchUi`'s `<RendererPreview>`
// host with a monotonic cache-bust marker so the iframe `srcdoc`
// attribute is byte-different on every render — without it, real
// Chrome elides the navigation as a same-value no-op and leaves
// the preview blank after a re-render trigger (the symptom that
// motivated #2321 / PR #2322).
//
// Originally this spec drove the Format `<select>` (HTML / Text /
// PDF) to force re-renders. The 2026-05 design-system migration
// (#2454, commit 6115ad3) removed the Format selector — HTML is
// now the only preview surface — so this spec drives the Transpose
// stepper instead. Transpose changes flow through the same
// `<RendererPreview>` mount path the Format toggle used, so the
// cache-bust invariant being verified is the same one #2421
// introduced.
//
// Selectors target the React playground (#2454):
// `iframe.chordsketch-preview__frame` is the HTML preview iframe
// rendered by `<RendererPreview>`; the transpose-up button is
// labelled "Transpose up one semitone" inside the preview-pane
// performance controls.

import { expect, test } from '@playwright/test';

test.describe('playground render cache-bust', () => {
  test('mount-time srcdoc carries the cache-bust marker', async ({ page }) => {
    await page.goto('./chordpro/');
    const iframe = page.locator('iframe.chordsketch-preview__frame');
    await expect(iframe).toBeVisible();

    const initialSrcdoc = await iframe.getAttribute('srcdoc');
    expect(initialSrcdoc, 'mount-time srcdoc should be populated').toBeTruthy();
    expect(initialSrcdoc).toMatch(/<!--\s*r:\d+\s*-->/);
    expect(initialSrcdoc).toContain('<div class="song"');
  });

  test('transpose changes bump the cache-bust marker and survive re-render', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const iframe = page.locator('iframe.chordsketch-preview__frame');
    await expect(iframe).toBeVisible();

    const initialSrcdoc = await iframe.getAttribute('srcdoc');
    expect(initialSrcdoc).toMatch(/<!--\s*r:\d+\s*-->/);

    await page.getByLabel('Transpose up one semitone').click();
    // Wait for the iframe's srcdoc to change. The cache-bust
    // marker increments synchronously inside the React render
    // path, so polling on attribute change is sufficient — no
    // need to wait for a network request or a global event.
    await expect
      .poll(async () => await iframe.getAttribute('srcdoc'))
      .not.toBe(initialSrcdoc);

    const finalSrcdoc = await iframe.getAttribute('srcdoc');
    expect(finalSrcdoc, 'post-transpose srcdoc should be populated').toBeTruthy();
    expect(finalSrcdoc).toContain('<div class="song"');
    expect(finalSrcdoc).toMatch(/<!--\s*r:\d+\s*-->/);
  });

  test('repeated transpose steps produce strictly distinct srcdoc values', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const iframe = page.locator('iframe.chordsketch-preview__frame');
    await expect(iframe).toBeVisible();
    const upButton = page.getByLabel('Transpose up one semitone');

    const seen = new Set<string>();
    seen.add((await iframe.getAttribute('srcdoc')) ?? '');
    let lastSeen = (await iframe.getAttribute('srcdoc')) ?? '';
    for (let i = 0; i < 4; i++) {
      await upButton.click();
      // Poll until srcdoc changes — async React renders may not
      // settle before the next click otherwise.
      await expect
        .poll(async () => await iframe.getAttribute('srcdoc'))
        .not.toBe(lastSeen);
      const next = (await iframe.getAttribute('srcdoc')) ?? '';
      seen.add(next);
      lastSeen = next;
    }
    // 1 mount-time + 4 post-step writes = 5 distinct strings if
    // the cache-bust marker is increment-on-render. A regression
    // that drops the marker collapses this set to size 1.
    expect(seen.size).toBe(5);
  });
});
