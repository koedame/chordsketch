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
  test('?#format=irealb mounts the bar grid without uncaught exceptions', async ({
    page,
  }) => {
    // `pageerror` fires only on uncaught exceptions reaching the
    // window — exactly the failure surface the pre-fix mount
    // produced (`__wbindgen_free` TypeError from `parseIrealb`).
    // Asserting an empty list catches this whole regression class
    // without coupling to a specific wasm-bindgen symbol name (it
    // could be renamed upstream and still leave the bug intact).
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('./#format=irealb');

    const editor = page.locator('.irealb-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.irealb-editor__bar').first()).toBeVisible();
    // The select must reflect the deep-linked format so a user
    // who reloads sees a consistent state.
    await expect(page.locator('#input-format')).toHaveValue('irealb');

    expect(pageErrors).toEqual([]);
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
