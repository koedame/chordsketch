// Browser smoke: opening any page of the deployed site sends nothing to
// another origin. The site promises that it collects nothing (README,
// Privacy section); a font or script pulled from a third-party host would
// hand the visitor's IP address to that host and break the promise.
//
// The fonts are served from `/assets/` (see `src/fonts.css`), so this also
// asserts that the self-hosted web fonts actually load.

import { expect, test } from '@playwright/test';

const ROUTES = ['./', './chordpro/', './irealpro/', './vue/', './svelte/', './docs/'];

for (const route of ROUTES) {
  test(`${route} sends no request to another origin and loads its own fonts`, async ({
    page,
    baseURL,
  }) => {
    const siteOrigin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return;
      if (url.origin !== siteOrigin) foreign.push(req.url());
    });

    await page.goto(route);
    await page.waitForLoadState('networkidle');

    expect(foreign).toEqual([]);

    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/["']/g, ''));
    });
    // Which family a page uses first differs per route; any self-hosted face
    // loading proves the `@font-face` rules resolve to files on this origin.
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((family) => family.endsWith(' Variable'))).toBe(true);
  });
}

// The kitchen-sink sample demonstrates `{image}`. Its image must come from the
// site itself: a remote host would receive the visitor's IP address as soon as
// the sample is picked.
test('the kitchen-sink sample requests no image from another origin', async ({
  page,
  baseURL,
}) => {
  const siteOrigin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== siteOrigin) foreign.push(req.url());
  });

  await page.goto('./chordpro/');
  await page.getByLabel('Sample').selectOption({ label: 'All directives (kitchen sink)' });
  await page.waitForLoadState('networkidle');

  expect(foreign).toEqual([]);
});
