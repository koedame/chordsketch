// Smoke verification that every editor format the playground exposes
// actually mounts. Each spec asserts a structural anchor (a DOM
// element only the mounted adapter would create) so the test fails
// loudly if the mount path silently degrades — the failure mode that
// shipped the iRealb factory in #2388 with the wasm-init race that
// produced #2397.
//
// Assertions are intentionally structural, not visual: we are
// guarding the "the page is wired up" guarantee, not the rendering
// fidelity of the editor itself (covered by the package-level vitest
// suites in `packages/ui-irealb-editor/tests/`).

import { expect, test } from '@playwright/test';

test.describe('playground editor mount', () => {
  test('default ChordPro path renders the textarea seeded with sample content', async ({
    page,
  }) => {
    await page.goto('./');
    const textarea = page.locator('textarea#editor');
    await expect(textarea).toBeVisible();
    // The default seed is `SAMPLE_CHORDPRO`; an empty textarea would
    // mean either the seed was lost or the editor swap fired
    // unexpectedly during mount.
    await expect(textarea).not.toHaveValue('');
    // The iRealb editor MUST NOT be in the DOM on the ChordPro path.
    await expect(page.locator('.irealb-editor')).toHaveCount(0);
  });

  test('switching the input format select mounts the iRealb bar grid', async ({
    page,
  }) => {
    await page.goto('./');
    const select = page.locator('#input-format');
    await expect(select).toBeVisible();
    await select.selectOption('irealb');

    const editor = page.locator('.irealb-editor');
    await expect(editor).toBeVisible();
    // Visibility of `.first()` already implies count >= 1, which is
    // what we care about — the wasm parse + grid render fired.
    await expect(editor.locator('.irealb-editor__bar').first()).toBeVisible();
    // The textarea adapter must have been torn down; leaving both
    // mounted would mean `replaceEditor` skipped `destroy()`.
    await expect(page.locator('textarea#editor')).toHaveCount(0);
  });

  test('toggling back to ChordPro restores the textarea adapter', async ({
    page,
  }) => {
    await page.goto('./');
    const select = page.locator('#input-format');
    await select.selectOption('irealb');
    await expect(page.locator('.irealb-editor')).toBeVisible();

    await select.selectOption('chordpro');
    await expect(page.locator('textarea#editor')).toBeVisible();
    await expect(page.locator('.irealb-editor')).toHaveCount(0);
  });
});
