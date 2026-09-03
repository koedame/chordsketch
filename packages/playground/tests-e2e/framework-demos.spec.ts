// Browser smoke for the per-binding live demos at `/chordsketch/vue/`
// and `/chordsketch/svelte/` (#2046).
//
// These are the only place `@chordsketch/vue` and
// `@chordsketch/svelte` run in a real browser: both packages' own
// suites are jsdom + a stubbed wasm loader, so nothing else in the
// repo would notice either binding failing to boot the real module.
// Per `.claude/rules/playground-smoke.md` the assertions are
// structural anchors, `pageerror` is captured on every navigation,
// and each case would fail if the page silently degraded to "no
// editor mounted".

import { expect, test, type Page } from '@playwright/test';

interface Demo {
  /** Route under the site base, and the label used in test titles. */
  readonly route: string;
  readonly framework: string;
  readonly heading: RegExp;
  readonly recipeSlug: string;
}

const DEMOS: readonly Demo[] = [
  {
    route: './vue/',
    framework: 'Vue',
    heading: /Edit ChordPro, see it render — in Vue/,
    recipeSlug: 'embed-vue',
  },
  {
    route: './svelte/',
    framework: 'Svelte',
    heading: /Edit ChordPro, see it render — in Svelte/,
    recipeSlug: 'embed-svelte',
  },
];

/** Collect uncaught exceptions for the lifetime of the page. */
function trackPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (err) => {
    errors.push(err);
  });
  return errors;
}

for (const demo of DEMOS) {
  test.describe(`${demo.framework} live demo`, () => {
    test('mounts the editor and renders the sample through wasm', async ({
      page,
    }) => {
      const pageErrors = trackPageErrors(page);

      await page.goto(demo.route);

      // Scoped to the page's own title: the rendered sheet carries
      // the song's `<h1>` too (the engine emits the ChordPro
      // `{title}` as a heading), so an unscoped level-1 lookup
      // matches two elements.
      await expect(page.locator('.framework-demo__title')).toHaveText(
        demo.heading,
      );

      const editor = page.getByRole('textbox', { name: 'ChordPro editor' });
      await expect(editor).toBeVisible();
      await expect(editor).toHaveValue(/\{title: Amazing Grace\}/);

      // The rendered sheet only appears once the wasm module has
      // booted and `render_html_body` has returned — an assertion on
      // the editor alone would pass against a dead preview pane.
      const preview = page.locator('.chordsketch-sheet__content');
      await expect(
        preview.getByRole('heading', { name: 'Amazing Grace' }),
      ).toBeVisible();
      // `.chord` spans are emitted by the renderer, never typed by
      // the user, so their presence proves the engine ran.
      await expect(preview.locator('.chord').first()).toHaveText('G');

      expect(pageErrors).toEqual([]);
    });

    test('re-renders the preview from typed source', async ({ page }) => {
      const pageErrors = trackPageErrors(page);

      await page.goto(demo.route);

      const editor = page.getByRole('textbox', { name: 'ChordPro editor' });
      await expect(editor).toBeVisible();

      await editor.fill('{title: Smoke Test}\n[G]Hello [D]world');

      const preview = page.locator('.chordsketch-sheet__content');
      await expect(
        preview.getByRole('heading', { name: 'Smoke Test' }),
      ).toBeVisible();
      await expect(preview.locator('.lyrics').first()).toHaveText('Hello ');
      // Chord glyphs come from the renderer, not from the typed
      // text — asserting one proves the preview is the engine's
      // output rather than an echo of the textarea.
      await expect(preview.locator('.chord').first()).toHaveText('G');

      expect(pageErrors).toEqual([]);
    });

    test('transposing the preview re-renders the chords', async ({ page }) => {
      const pageErrors = trackPageErrors(page);

      await page.goto(demo.route);

      const preview = page.locator('.chordsketch-sheet__content');
      await expect(preview.locator('.chord').first()).toHaveText('G');

      // `<Transpose>` is a native select; +2 semitones takes the
      // sample's opening G to A.
      await page
        .getByRole('combobox', { name: 'Transpose' })
        .selectOption('2');

      await expect(preview.locator('.chord').first()).toHaveText('A');

      expect(pageErrors).toEqual([]);
    });

    test('links back to the site root and to its recipe page', async ({
      page,
    }) => {
      await page.goto(demo.route);

      await expect(page.getByRole('link', { name: 'ChordSketch' })).toHaveAttribute(
        'href',
        '../',
      );
      await expect(page.getByRole('link', { name: 'Recipes' })).toHaveAttribute(
        'href',
        `../docs/${demo.recipeSlug}/`,
      );
    });
  });
}

test('the landing page links to every binding demo', async ({ page }) => {
  await page.goto('./');

  for (const demo of DEMOS) {
    await expect(
      page.getByRole('link', { name: new RegExp(`^${demo.framework}\\b`) }),
    ).toHaveAttribute('href', demo.route.replace('./', ''));
  }
});
