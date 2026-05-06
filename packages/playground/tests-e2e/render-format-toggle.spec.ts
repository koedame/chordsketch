// Pins the contract that the HTML preview survives a round-trip
// through the Text or PDF format selector. #2321 / PR #2322 left a
// residual blank-preview symptom on the HTML → Text → HTML toggle
// in real Chrome that headless Chromium does not reproduce; #2421
// hardens the host with a monotonic cache-bust marker so the iframe
// `srcdoc` attribute is byte-different on every render. This smoke
// asserts the marker is present and increments — a regression that
// drops the cache-bust would collapse it to a constant string and
// fail this test loudly.

import { expect, test } from '@playwright/test';

test.describe('playground render-format toggle', () => {
  test('html → text → html keeps the preview rendering and bumps the cache-bust marker', async ({
    page,
  }) => {
    await page.goto('./');
    const iframe = page.locator('iframe#preview');
    await expect(iframe).toBeVisible();

    const initialSrcdoc = await iframe.getAttribute('srcdoc');
    expect(initialSrcdoc, 'mount-time srcdoc should be populated').toBeTruthy();
    expect(initialSrcdoc).toMatch(/<!--\s*r:\d+\s*-->/);

    const formatSelect = page.locator('select#format');
    await formatSelect.selectOption('text');
    // The text pane is now visible; the iframe still carries its
    // previous `srcdoc` value but is hidden via `display: none`.
    const textPane = page.locator('pre#text-output');
    await expect(textPane).toBeVisible();

    await formatSelect.selectOption('html');
    await expect(iframe).toBeVisible();

    const finalSrcdoc = await iframe.getAttribute('srcdoc');
    expect(finalSrcdoc, 'post-toggle srcdoc should be populated').toBeTruthy();
    // The iframe must still carry the rendered body; a regression
    // that wipes the document on hide/show would leave srcdoc empty.
    expect(finalSrcdoc).toContain('<div class="song"');
    // Most important assertion: the cache-bust marker increments
    // monotonically, which guarantees Chromium cannot elide the
    // navigation as a same-value no-op (#2421).
    expect(finalSrcdoc).not.toBe(initialSrcdoc);
    expect(finalSrcdoc).toMatch(/<!--\s*r:\d+\s*-->/);
  });

  test('repeated html ↔ text toggles produce strictly distinct srcdoc values', async ({
    page,
  }) => {
    await page.goto('./');
    const iframe = page.locator('iframe#preview');
    const formatSelect = page.locator('select#format');
    await expect(iframe).toBeVisible();

    const seen = new Set<string>();
    seen.add((await iframe.getAttribute('srcdoc')) ?? '');
    for (let i = 0; i < 4; i++) {
      await formatSelect.selectOption('text');
      await formatSelect.selectOption('html');
      seen.add((await iframe.getAttribute('srcdoc')) ?? '');
    }
    // 1 mount-time + 4 post-toggle writes = 5 distinct strings if
    // the cache-bust marker is increment-on-render. A regression
    // that drops the marker collapses this set to size 1.
    expect(seen.size).toBe(5);
  });
});
