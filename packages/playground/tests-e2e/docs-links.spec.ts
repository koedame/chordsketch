// Browser smoke for the static docs site's link integrity.
//
// Sibling to docs.spec.ts (mount + a handful of navigation paths).
// This spec exhaustively walks every registered docs URL and inspects
// the rendered article for link defects that no in-process suite
// reaches:
//
//   1. Every clean URL `/chordsketch/docs/<slug>/` mounts a real
//      article.
//   2. No rendered article contains a bare relative `.md` path —
//      `tasks/render.md` works on GitHub but 404s on the static
//      deploy. The renderer must rewrite them.
//   3. Every clean cross-page link in an article (anything pointing
//      at `/chordsketch/docs/...`) resolves to a registered slug.
//   4. Every in-page `#anchor` link resolves to a heading id on the
//      same page. Browser-native scrolling handles the click; the
//      assertion guards against typo anchors and renderer drift.
//   5. Clicking a sidebar nav link actually navigates to the
//      matching clean URL.

import { expect, test } from '@playwright/test';

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

const DOCS_BASE_PATH = '/chordsketch/docs/';

function urlForSlug(slug: string): string {
  return slug === '' ? './docs/' : `./docs/${slug}/`;
}

test.describe('docs site link integrity (static)', () => {
  for (const slug of REGISTERED_SLUGS) {
    test(`URL ${urlForSlug(slug)} mounts a real article`, async ({ page }) => {
      const pageErrors: Error[] = [];
      page.on('pageerror', (err) => pageErrors.push(err));

      await page.goto(urlForSlug(slug));

      const h1 = page.getByRole('heading', { level: 1 }).first();
      await expect(h1).toBeVisible();
      await expect(h1).not.toHaveText('Page not found');

      expect(pageErrors).toEqual([]);
    });
  }

  test('no rendered article contains a relative .md link', async ({ page }) => {
    const offenders: { slug: string; href: string; text: string }[] = [];

    for (const slug of REGISTERED_SLUGS) {
      await page.goto(urlForSlug(slug));
      const hrefs = await page
        .locator('main a[href]')
        .evaluateAll((els) =>
          els.map((el) => ({
            href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
            text: el.textContent?.trim() ?? '',
          })),
        );
      for (const { href, text } of hrefs) {
        const isAbsolute = /^https?:\/\//i.test(href) || href.startsWith('mailto:');
        const isFragment = href.startsWith('#');
        const isAbsolutePath = href.startsWith('/');
        if (!isAbsolute && !isFragment && !isAbsolutePath) {
          offenders.push({ slug: slug || '(index)', href, text });
        }
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test('every cross-page docs URL resolves to a registered slug', async ({
    page,
  }) => {
    const offenders: { slug: string; href: string; text: string }[] = [];
    const registered = new Set(REGISTERED_SLUGS);

    for (const slug of REGISTERED_SLUGS) {
      await page.goto(urlForSlug(slug));
      const hrefs = await page
        .locator(`main a[href^="${DOCS_BASE_PATH}"]`)
        .evaluateAll((els) =>
          els.map((el) => ({
            href: (el as HTMLAnchorElement).getAttribute('href') ?? '',
            text: el.textContent?.trim() ?? '',
          })),
        );
      for (const { href, text } of hrefs) {
        const path = href.slice(DOCS_BASE_PATH.length).replace(/\/$/, '');
        if (!registered.has(path)) {
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
      await page.goto(urlForSlug(slug));
      const ids = await page
        .locator('main h1[id], main h2[id], main h3[id], main h4[id]')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).id));
      const idSet = new Set(ids);

      const inPage = await page
        .locator('main a[href^="#"]')
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

  test('sidebar click navigates to the matching clean URL', async ({ page }) => {
    await page.goto('./docs/');
    const sidebar = page.getByRole('complementary', {
      name: /documentation navigation/i,
    });
    await sidebar.getByRole('link', { name: 'Embed in a React app' }).click();
    await page.waitForURL(/\/docs\/embed-react\/$/);
    await expect(
      page.getByRole('heading', { level: 2, name: /^Recipe 1\b/ }),
    ).toBeVisible();
  });
});
