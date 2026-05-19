// Browser smoke for the docs route (#2506 / ADR-0021).
//
// The docs site is a fourth multi-page Vite entry co-located with
// the playground. Each assertion guards an integration boundary
// that no in-process suite reaches — the canonical Markdown under
// `docs/sdk/` is bundled via Vite's `?raw` import at build time,
// so a missing or moved file would only surface at production
// build / load time.
//
// Per `.claude/rules/playground-smoke.md`: assertions are
// structural anchors (selectors, `role=`), not visual snapshots;
// a `pageerror` listener catches uncaught exceptions reaching the
// page — including the wasm-init race class that motivated the
// playground-smoke discipline.

import { expect, test } from '@playwright/test';

test.describe('docs site', () => {
  test('home page mounts the sidebar nav + index article', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await page.goto('./docs/');

    // The sidebar nav is the structural anchor for "App mounted
    // and rendered the page registry."
    const sidebar = page.getByRole('complementary', {
      name: /documentation navigation/i,
    });
    await expect(sidebar).toBeVisible();

    // The Getting started group's index page renders an H1 from
    // the canonical `docs/sdk/README.md`. Match the prefix so the
    // assertion stays stable against trivial title tweaks.
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText('ChordSketch SDK');

    // Every API reference + recipe page is registered in the nav.
    // Sampling one entry from each group catches a missing import
    // (registry registration without the matching `?raw` bundle).
    await expect(
      sidebar.getByRole('link', { name: 'Embed in a React app' }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole('link', { name: '<ChordSheet> + AST hooks' }),
    ).toBeVisible();

    // No uncaught exceptions should reach the page during mount.
    // The list is empty when the bundle is healthy; failures here
    // catch the wasm-init-race class from #2397 even though the
    // docs bundle does not itself load `@chordsketch/wasm`.
    expect(pageErrors).toEqual([]);
  });

  test('navigating to the embed-react recipe loads its content', async ({
    page,
  }) => {
    await page.goto('./docs/');

    // Click the recipe link in the sidebar — exercises the hash
    // router + the canonical Markdown import path together.
    await page
      .getByRole('complementary', { name: /documentation navigation/i })
      .getByRole('link', { name: 'Embed in a React app' })
      .click();

    // The recipe's first recipe heading appears once the page
    // mounts. Using a Markdown-emitted H2 ensures both the
    // marked-driven render and the slug-id renderer ran. Match
    // the full first-recipe title so the regex does not also
    // catch "Recipe 10 — ..." further down the page.
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: /Recipe 1 — Drop in a ChordPro playground/,
      }),
    ).toBeVisible();

    // The hash reflects the route the user navigated to so direct
    // links + sharing work.
    expect(new URL(page.url()).hash).toBe('#/embed-react');
  });

  test('deep-link via hash mounts the matching reference page', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await page.goto('./docs/#/reference/chord-sheet');

    // The ChordSheet reference page begins with an H1 carrying the
    // component name. Cold-load through a deep hash must mount the
    // same content as click-navigation; an asymmetric path would
    // ship the same regression class as the `?#format=irealb`
    // failure that motivated `.claude/rules/playground-smoke.md`.
    await expect(
      page.getByRole('heading', { level: 1, name: /<ChordSheet>/ }),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
