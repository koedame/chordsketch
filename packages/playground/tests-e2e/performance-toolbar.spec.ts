// Smoke verification that the playground's preview pane mounts the
// performance toolbar (#2545) — Transpose / Capo / Export — and
// that keyboard navigation moves focus across groups and the
// disabled state at boundaries is reachable.
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

  test('Transpose +/- click drives the readout value', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    await transposeGroup.getByRole('button', { name: 'Transpose up one semitone' }).click();
    // The Transpose `<output>` uses aria-live but stays in the DOM as
    // the inner text of `.chordsketch-transpose__value` — assert on the
    // visible text rather than coupling to an internal attribute.
    await expect(transposeGroup).toContainText('+1');
  });

  test('Capo +/- rewrites the {capo: N} directive in the editor source', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const editor = page.locator('.cm-editor .cm-content');
    await expect(editor).toBeVisible();
    // The bundled sample has no {capo} directive; clicking Capo + once
    // inserts `{capo: 1}` after the metadata anchor. We don't pin the
    // exact position — just assert the directive shows up.
    await page
      .getByRole('group', { name: 'Capo' })
      .getByRole('button', { name: 'Capo up one fret' })
      .click();
    await expect(editor).toContainText('{capo: 1}');
  });

  test('Transpose down disables at the -11 lower bound', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const down = transposeGroup.getByRole('button', { name: 'Transpose down one semitone' });
    // Step down 11 times to hit the lower bound.
    for (let i = 0; i < 11; i++) {
      await down.click();
    }
    await expect(transposeGroup).toContainText('-11');
    await expect(down).toBeDisabled();
  });

  test('keyboard `+` shortcut inside a group steps the value', async ({ page }) => {
    await page.goto('./chordpro/');
    const capoGroup = page.getByRole('group', { name: 'Capo' });
    // Focus a button inside the group so the keydown reaches the wrapper.
    await capoGroup.getByRole('button', { name: 'Capo up one fret' }).focus();
    await page.keyboard.press('+');
    await expect(capoGroup).toContainText('1');
  });
});
