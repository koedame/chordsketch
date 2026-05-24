// Smoke verification that the playground's preview pane mounts the
// performance toolbar (#2545, #2560) — Transpose / Capo / Export
// sliders + button — and that the slider controls drive the
// underlying state correctly.
//
// Structural assertions only: this verifies the toolbar exists and
// its accessibility wiring is in place. Pixel-level appearance is
// out of scope (see `.claude/rules/playground-smoke.md`).

import { expect, test } from '@playwright/test';

test.describe('performance toolbar', () => {
  test('Transpose / Capo / Export groups mount in the preview pane', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const toolbar = page.getByRole('toolbar', { name: 'Preview performance controls' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('group', { name: 'Transpose' })).toBeVisible();
    await expect(toolbar.getByRole('group', { name: 'Capo' })).toBeVisible();
    await expect(toolbar.getByRole('group', { name: 'Export' })).toBeVisible();
  });

  test('Transpose slider drives the readout value', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const slider = transposeGroup.getByRole('slider', { name: 'Transpose' });
    await slider.fill('1');
    // The Transpose `<output>` uses aria-live but stays in the DOM as
    // the inner text of `.chordsketch-transpose__value` — assert on
    // the visible text rather than coupling to an internal attribute.
    await expect(transposeGroup).toContainText('+1');
  });

  test('Capo slider rewrites the {capo: N} directive in the editor source', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const editor = page.locator('.cm-editor .cm-content');
    await expect(editor).toBeVisible();
    // The bundled sample has no {capo} directive; setting the slider
    // to 1 inserts `{capo: 1}` after the metadata anchor. We don't
    // pin the exact position — just assert the directive shows up.
    const capoGroup = page.getByRole('group', { name: 'Capo' });
    await capoGroup.getByRole('slider', { name: 'Capo' }).fill('1');
    await expect(editor).toContainText('{capo: 1}');
  });

  test('Transpose slider exposes the toolbar default ±11 range', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const slider = transposeGroup.getByRole('slider', { name: 'Transpose' });
    await expect(slider).toHaveAttribute('min', '-11');
    await expect(slider).toHaveAttribute('max', '11');
    await slider.fill('-11');
    await expect(transposeGroup).toContainText('-11');
  });

  test('Capo slider exposes the 0..=12 range', async ({ page }) => {
    await page.goto('./chordpro/');
    const capoGroup = page.getByRole('group', { name: 'Capo' });
    const slider = capoGroup.getByRole('slider', { name: 'Capo' });
    await expect(slider).toHaveAttribute('min', '0');
    await expect(slider).toHaveAttribute('max', '12');
  });
});
