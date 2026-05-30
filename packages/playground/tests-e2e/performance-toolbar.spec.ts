// Smoke verification that the playground's preview pane mounts the
// performance toolbar (#2545, #2560) — Transpose / Capo selects
// plus a pane-head Export PDF button — and that the select
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

  test('Transpose select drives the selected value', async ({ page }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const select = transposeGroup.getByRole('combobox', { name: 'Transpose' });
    await select.selectOption('1');
    await expect(select).toHaveValue('1');
  });

  test('Capo select rewrites the {capo: N} directive in the editor source', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const editor = page.locator('.cm-editor .cm-content');
    await expect(editor).toBeVisible();
    // The bundled sample has no {capo} directive; setting the select
    // to 1 inserts `{capo: 1}` after the metadata anchor. We don't
    // pin the exact position — just assert the directive shows up.
    const capoGroup = page.getByRole('group', { name: 'Capo' });
    await capoGroup.getByRole('combobox', { name: 'Capo' }).selectOption('1');
    await expect(editor).toContainText('{capo: 1}');
  });

  test('Transpose select exposes the toolbar default ±6 range, highest-first', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const transposeGroup = page.getByRole('group', { name: 'Transpose' });
    const select = transposeGroup.getByRole('combobox', { name: 'Transpose' });
    // PreviewToolbar defaults `transposeMin/Max` to ±6. Options are
    // rendered highest-first (`+6 … -6`); hosts that want the
    // feature ceiling (±11) pass it explicitly.
    const options = select.locator('option');
    await expect(options).toHaveCount(13);
    await expect(options.first()).toHaveAttribute('value', '6');
    await expect(options.last()).toHaveAttribute('value', '-6');
    await select.selectOption('-6');
    await expect(select).toHaveValue('-6');
  });

  test('Capo select exposes the 0..=12 range, highest-first', async ({ page }) => {
    await page.goto('./chordpro/');
    const capoGroup = page.getByRole('group', { name: 'Capo' });
    const select = capoGroup.getByRole('combobox', { name: 'Capo' });
    const options = select.locator('option');
    await expect(options).toHaveCount(13);
    await expect(options.first()).toHaveAttribute('value', '12');
    await expect(options.last()).toHaveAttribute('value', '0');
  });
});
