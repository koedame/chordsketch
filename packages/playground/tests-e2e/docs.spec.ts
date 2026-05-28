// Browser smoke for the static docs route (#2506 / ADR-0021,
// extended by #2514 to ship per-page static HTML).
//
// Per `.claude/rules/playground-smoke.md`: assertions are
// structural anchors (selectors, `role=`), not visual snapshots;
// `pageerror` is captured to catch any uncaught exceptions even
// though the static docs pages do not load `@chordsketch/wasm`.

import { expect, test } from '@playwright/test';

test.describe('docs site (static)', () => {
  test('home page mounts the sidebar nav + index article', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await page.goto('./docs/');

    const sidebar = page.getByRole('complementary', {
      name: /documentation navigation/i,
    });
    await expect(sidebar).toBeVisible();

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText('ChordSketch SDK');

    await expect(
      sidebar.getByRole('link', { name: 'Embed in a React app' }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole('link', { name: '<ChordSheet> + AST hooks' }),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('clean URL deep-link mounts the matching recipe page', async ({
    page,
  }) => {
    await page.goto('./docs/embed-react/');
    await expect(
      page.getByRole('heading', { level: 2, name: /^Recipe 1\b/ }),
    ).toBeVisible();
  });

  test('deep-link to a nested reference page mounts the matching article', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await page.goto('./docs/reference/chord-sheet/');
    await expect(
      page.getByRole('heading', { level: 1, name: /<ChordSheet>/ }),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('legacy #/<slug> hash URL redirects to the clean URL', async ({
    page,
  }) => {
    await page.goto('./docs/#/embed-react');
    await page.waitForURL(/\/docs\/embed-react\/$/);
    await expect(
      page.getByRole('heading', { level: 2, name: /^Recipe 1\b/ }),
    ).toBeVisible();
  });

  test('code fences on a recipe page render with Shiki syntax highlighting', async ({
    page,
  }) => {
    // Asserts the build-time highlighter is wired into the deployed
    // pipeline per ADR-0021's zero-JS posture: every recipe block
    // must reach the DOM as a `<pre class="shiki">` with per-token
    // colour spans. A regression that silently fell back to plain
    // `<pre><code>` would clear the unit suite (the highlighter
    // module still loads) but show up here.
    await page.goto('./docs/embed-react/');

    const shikiBlocks = page.locator('pre.shiki');
    await expect(shikiBlocks.first()).toBeVisible();
    // Embed-react ships 12 fenced code blocks at the time of
    // writing; assert a meaningful floor rather than the exact
    // count so a future recipe addition / removal does not
    // mechanically break the smoke.
    expect(await shikiBlocks.count()).toBeGreaterThanOrEqual(5);

    // Per-token colour spans are the load-bearing visual signal:
    // without them, the block is plain text wearing a "shiki" class.
    const colouredSpan = shikiBlocks
      .first()
      .locator('span[style*="color:"]')
      .first();
    await expect(colouredSpan).toBeVisible();
  });
});
