// Browser smoke for the docs site's link integrity.
//
// Sibling to docs.spec.ts (which covers mount + a handful of
// navigation paths). This spec exhaustively walks every sidebar
// nav link and inspects the rendered article for link defects no
// in-process suite reaches:
//
//   1. Sidebar nav: every registered slug mounts a non-"Page not
//      found" article.
//   2. In-doc links: a relative `.md` path (e.g. `tasks/render.md`)
//      works on GitHub's repo viewer but 404s under the SPA. The
//      walker must rewrite those at render time or the source must
//      avoid them.
//   3. Cross-page hash links: every `#/<slug>` reference inside an
//      article resolves to a slug registered in DOC_GROUPS.
//   4. In-page anchor links (h2/h3 headings + outline): every
//      `#anchor` reference resolves to a heading id on the SAME
//      page. Clicking an outline link MUST NOT unmount the active
//      article — that was the original failure mode of the
//      hash-only outline (`#some-heading` is parsed by the router
//      as a route to slug `some-heading`).
//
// Per `.claude/rules/playground-smoke.md`: assertions are structural
// anchors, the production build is driven (not the dev server), and
// pageerror is captured to catch wasm-init-class regressions even
// though the docs bundle does not pull in `@chordsketch/wasm`.

import { expect, test } from '@playwright/test';

// Mirrors DOC_GROUPS in src/docs/pages.ts. Kept inline so the smoke
// has zero coupling to the prod bundle's internals — if the registry
// drifts, the mount-each assertion catches the drift here.
const REGISTERED_SLUGS = [
  '',
  'embed-react',
  'render',
  'transpose-task',
  'reference',
  'reference/chord-sheet',
  'reference/playground',
  'reference/editors',
  'reference/layout',
  'reference/transpose',
  'reference/chord-diagram',
  'reference/pdf-export',
  'reference/chord-source-edit',
  'reference/ireal-components',
  'reference/ireal-hooks',
  'reference/ireal-helpers',
  'reference/version',
];

test.describe('docs site link integrity', () => {
  for (const slug of REGISTERED_SLUGS) {
    test(`page #/${slug || ''} mounts a real article (not 'Page not found')`, async ({
      page,
    }) => {
      const pageErrors: Error[] = [];
      page.on('pageerror', (err) => pageErrors.push(err));

      await page.goto(slug === '' ? './docs/' : `./docs/#/${slug}`);

      const h1 = page.getByRole('heading', { level: 1 }).first();
      await expect(h1).toBeVisible();
      await expect(h1).not.toHaveText('Page not found');

      expect(pageErrors).toEqual([]);
    });
  }

  test('no rendered article contains a relative .md link', async ({ page }) => {
    const offenders: { slug: string; href: string; text: string }[] = [];

    for (const slug of REGISTERED_SLUGS) {
      await page.goto(slug === '' ? './docs/' : `./docs/#/${slug}`);
      const hrefs = await page
        .locator('main a[href]')
        .evaluateAll((els) =>
          els.map((el) => ({
            href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
            text: el.textContent?.trim() ?? '',
          })),
        );
      for (const { href, text } of hrefs) {
        // Anything not absolute, not a fragment, and not a hash route
        // is a relative path. The deploy is static; relative-md links
        // 404 under the SPA.
        const isAbsolute = /^https?:\/\//i.test(href) || href.startsWith('mailto:');
        const isFragment = href.startsWith('#');
        if (!isAbsolute && !isFragment) {
          offenders.push({ slug: slug || '(index)', href, text });
        }
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test('every cross-page #/<slug> link resolves to a registered slug', async ({
    page,
  }) => {
    const offenders: { slug: string; href: string; text: string }[] = [];
    const registered = new Set(REGISTERED_SLUGS);

    for (const slug of REGISTERED_SLUGS) {
      await page.goto(slug === '' ? './docs/' : `./docs/#/${slug}`);
      const hrefs = await page
        .locator('main a[href^="#/"]')
        .evaluateAll((els) =>
          els.map((el) => ({
            href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
            text: el.textContent?.trim() ?? '',
          })),
        );
      for (const { href, text } of hrefs) {
        const target = href.slice(2).replace(/\/$/, '');
        if (!registered.has(target)) {
          offenders.push({ slug: slug || '(index)', href, text });
        }
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test('every in-page #anchor link resolves to a heading id on the same page', async ({
    page,
  }) => {
    const offenders: {
      slug: string;
      href: string;
      text: string;
      available: string[];
    }[] = [];

    for (const slug of REGISTERED_SLUGS) {
      await page.goto(slug === '' ? './docs/' : `./docs/#/${slug}`);
      const ids = await page
        .locator('main h1[id], main h2[id], main h3[id], main h4[id]')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).id));
      const idSet = new Set(ids);

      const inPage = await page
        .locator('main a[href^="#"]:not([href^="#/"])')
        .evaluateAll((els) =>
          els.map((el) => ({
            href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
            text: el.textContent?.trim() ?? '',
          })),
        );
      for (const { href, text } of inPage) {
        const anchor = href.slice(1);
        if (anchor === '' || idSet.has(anchor)) continue;
        offenders.push({
          slug: slug || '(index)',
          href,
          text,
          available: ids,
        });
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test('clicking an outline link keeps the active page mounted', async ({
    page,
  }) => {
    // The index page has the largest outline; using it exercises the
    // bug surface most aggressively.
    await page.goto('./docs/');

    const outlineLinks = page.locator(
      'aside[aria-label="Documentation navigation"] nav[aria-label="On this page"] a',
    );
    const count = await outlineLinks.count();
    expect(count).toBeGreaterThan(0);

    // Click the first outline link; the article must remain the
    // index article (not "Page not found").
    await outlineLinks.first().click();

    const h1 = page.getByRole('heading', { level: 1 }).first();
    await expect(h1).toContainText('ChordSketch SDK');
    await expect(h1).not.toHaveText('Page not found');
  });
});
