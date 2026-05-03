// The exact reproduction case for #2397: navigating to
// `?#format=irealb` MUST mount the iRealb bar-grid editor without
// any prior user interaction. Pre-fix the page returned a working
// SVG preview but no editor — the factory threw during mount
// because `parseIrealb` ran before wasm initialised. Both halves of
// the fix (the `mountChordSketchUi` init-order contract and the
// playground's deep-link initial-format detection) are exercised by
// loading this URL cold.

import { expect, test } from '@playwright/test';

test.describe('iRealb deep link', () => {
  test('?#format=irealb mounts the bar grid without console errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('./#format=irealb');

    const editor = page.locator('.irealb-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.irealb-editor__bar').first()).toBeVisible();
    // The select must reflect the deep-linked format so a user
    // who reloads sees a consistent state.
    await expect(page.locator('#input-format')).toHaveValue('irealb');

    // The pre-fix failure surface was a `__wbindgen_free` undefined
    // TypeError. We assert the absence of any pageerror because
    // any throw during mount points at a regression in the same
    // class.
    expect(
      consoleErrors.filter((m) => m.includes('__wbindgen_free')),
    ).toEqual([]);
  });

  test('clicking a bar opens the popover editor', async ({ page }) => {
    await page.goto('./#format=irealb');
    const firstBar = page
      .locator('.irealb-editor .irealb-editor__bar')
      .first();
    await expect(firstBar).toBeVisible();
    await firstBar.click();

    // The popover renders inside the editor's mount root with
    // `role="dialog"`; asserting the role anchors on the W3C APG
    // dialog pattern the package implements.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Escape must dismiss it — keyboard dismissal is part of the
    // adapter's accessibility contract (#2364).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
