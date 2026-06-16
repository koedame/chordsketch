// Smoke coverage for the chord-editor footer mount path in the ChordPro
// playground (#2622 / #2626 / #2630 / #2638 / #2644).
//
// Per `.claude/rules/playground-smoke.md`, a React component mount site
// reached only at runtime in a real browser needs an end-to-end spec:
// the in-process vitest suites stub the wasm boundary, so the only thing
// proving the footer actually mounts in the deployed bundle is loading
// the page and exercising it. History: the inspector was a top-left
// overlay (#2626), re-docked to the bottom (#2630), made a full-width
// FOOTER inside the preview (#2638), and finally (#2644) LIFTED to a
// shell-level band spanning the editor + preview, driven by the editor
// caret, always visible (idle when no chord is selected) and able to
// build + insert a chord at the caret.
//
// This spec asserts the lifted footer mounts below the panes (not inside
// the preview), a chord click activates it via the editor caret, the
// jazz-tension chips ship and edit, inserting a built chord writes it to
// source, and selecting a chord does not reflow its neighbours.
//
// Assertions are structural (selectors / visibility), and every test
// registers a `pageerror` listener asserting `[]` so a JS exception
// during select / edit / insert fails the test even if the DOM renders.

import { expect, test, type Page } from '@playwright/test';

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

const FOOTER = '.chordsketch-chord-pro-editor__chord-footer';

test.describe('chord-editor footer (ChordPro playground)', () => {
  test('the lifted footer mounts below the panes (not inside the preview)', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    // The footer is always present in split view, even before any chord
    // is selected (idle state) — the pre-#2644 dock only appeared on
    // selection. This is the integration the stubbed unit suites cannot
    // observe.
    const footer = page.locator(FOOTER);
    await expect(footer).toBeVisible();
    await expect(footer.locator('.chordsketch-sheet__cins')).toBeVisible();

    // It is NOT inside the preview pane any more — it spans both panes.
    await expect(page.locator('.pane .chordsketch-sheet__cins')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('clicking a preview chord selects it via the editor caret', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    const chord = preview.locator(".chord[role='button']").first();
    await expect(chord).toBeVisible();

    await chord.click();

    // The click moves the editor caret onto the chord, which the footer
    // resolves into a selection: the badge paints and the footer flips to
    // edit mode.
    await expect(preview.locator('.chord--selected')).toBeVisible();
    await expect(page.locator(`${FOOTER} .chordsketch-sheet__cins[data-mode='edit']`)).toBeVisible();
    // The lyrics stay visible alongside the footer.
    await expect(preview).toContainText('sweet');

    expect(errors).toEqual([]);
  });

  test('the footer exposes the jazz-tension chips and edits the selected chord', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    await preview.locator(".chord[role='button']").first().click();
    await expect(page.locator(`${FOOTER} .chordsketch-sheet__cins[data-mode='edit']`)).toBeVisible();

    // `maj9` is one of the extended jazz entries (#2630); absent if the
    // preset set regressed.
    const maj9 = page.locator(`${FOOTER} .chordsketch-sheet__cins-chip`, { hasText: /^maj9$/ });
    await expect(maj9).toHaveCount(1);

    // Picking it rewrites the selected chord through the source-as-truth
    // edit pipeline; the editor source should now contain a `maj9` chord.
    await maj9.click();
    await expect(page.locator('.cm-editor')).toContainText('maj9');

    expect(errors).toEqual([]);
  });

  test('building a chord and inserting it writes it to source at the caret', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    // Place the caret off any chord (document end) so the footer is in
    // idle "New chord" mode and the Insert action targets the caret. A
    // caret after a `]` (or anywhere in the lyrics) is not "on a chord".
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const idle = page.locator(`${FOOTER} .chordsketch-sheet__cins[data-mode='idle']`);
    await expect(idle).toBeVisible();

    // Build a chord the sample does not already contain (default root C +
    // the `dim7` type chip -> `Cdim7`), then insert it.
    await page.locator(`${FOOTER} .chordsketch-sheet__cins-chip`, { hasText: /^dim7$/ }).click();
    await page.getByRole('button', { name: 'Insert chord' }).click();

    await expect(page.locator('.cm-editor')).toContainText('Cdim7');

    expect(errors).toEqual([]);
  });

  test('selecting a chord does not reflow its neighbours (#2638)', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    const chords = preview.locator(".chord[role='button']");
    // The first sample line is `[G]Amazing [G7]grace …`, so chord 0 (G)
    // and chord 1 (G7) sit on the same line with G7 to the right of G.
    // Selecting G paints the badge; the badge offsets its padding with an
    // equal negative margin, so G7's x must not move.
    const second = chords.nth(1);
    const beforeX = (await second.boundingBox())?.x ?? 0;

    await chords.nth(0).click();
    await expect(preview.locator('.chord--selected')).toBeVisible();

    const afterX = (await second.boundingBox())?.x ?? 0;
    expect(Math.abs(afterX - beforeX)).toBeLessThan(1.5);

    expect(errors).toEqual([]);
  });
});
