// Smoke verification that the playground's preview pane mounts the
// performance toolbar (#2545, #2560) — Transpose / Capo sliders
// plus a pane-head Export PDF button — and that the slider
// controls drive the underlying state correctly.
//
// Structural assertions only: this verifies the controls exist
// and their accessibility wiring is in place. Pixel-level
// appearance is out of scope (see `.claude/rules/playground-smoke.md`).

import { expect, test } from '@playwright/test';

test.describe('performance toolbar', () => {
  test('Transpose / Capo groups mount in the preview toolbar; Export sits in the pane head', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const toolbar = page.getByRole('toolbar', { name: 'Preview performance controls' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('group', { name: 'Transpose' })).toBeVisible();
    await expect(toolbar.getByRole('group', { name: 'Capo' })).toBeVisible();
    // Export PDF moved out of the toolbar to the preview pane's
    // header (#2560 follow-up). Confirm the button is mounted
    // there instead, with the canonical "Export PDF" label.
    const paneHead = page.locator('.pane.preview .pane-head');
    await expect(paneHead.getByRole('button', { name: 'Export PDF' })).toBeVisible();
    // And NOT inside the toolbar.
    await expect(toolbar.getByRole('group', { name: 'Export' })).toHaveCount(0);
  });

  test('Transpose slider drives the readout value', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const slider = transposeGroup.getByRole('slider', { name: 'Transpose' });
    await slider.fill('1');
    // The Transpose `<output>` uses aria-live but stays in the DOM as
    // the inner text of `.chordsketch-transpose__value` — assert on
    // the visible text rather than coupling to an internal attribute.
    // The tick rail also renders `+1` as a label, so target the
    // readout element directly.
    await expect(
      transposeGroup.locator('.chordsketch-transpose__value'),
    ).toHaveText('+1');
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

  test('Transpose slider exposes the toolbar default ±6 range', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const slider = transposeGroup.getByRole('slider', { name: 'Transpose' });
    // PreviewToolbar defaults `transposeMin/Max` to ±6 so the
    // tick rail's 13 labels stay readable on narrow preview panes.
    // Hosts that want the feature ceiling (±11) pass it explicitly.
    await expect(slider).toHaveAttribute('min', '-6');
    await expect(slider).toHaveAttribute('max', '6');
    await slider.fill('-6');
    await expect(
      transposeGroup.locator('.chordsketch-transpose__value'),
    ).toHaveText('-6');
  });

  test('Capo slider exposes the 0..=12 range', async ({ page }) => {
    await page.goto('./chordpro/');
    const capoGroup = page.getByRole('group', { name: 'Capo' });
    const slider = capoGroup.getByRole('slider', { name: 'Capo' });
    await expect(slider).toHaveAttribute('min', '0');
    await expect(slider).toHaveAttribute('max', '12');
  });
});
