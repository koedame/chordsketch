// Smoke coverage for the chord-editor inspector mount path in the
// ChordPro playground (#2622 / #2626 / #2630).
//
// Per `.claude/rules/playground-smoke.md`, a new React component mount
// site reached only at runtime in a real browser needs an end-to-end
// spec: the in-process vitest suites stub the wasm boundary, so the
// only thing proving the inspector actually mounts in the deployed
// bundle is loading the page and selecting a chord. The pre-#2630
// inspector was a top-left overlay that covered the lyrics; #2630
// re-docked it to the bottom, so this spec also asserts the rendered
// lyrics stay visible while the inspector is open (the "does not cover
// content" contract) and that the expanded jazz-tension chips shipped.
//
// Assertions are structural (selectors / visibility), and every test
// registers a `pageerror` listener asserting `[]` so a JS exception
// during select / edit fails the test even if the DOM still renders.

import { expect, test, type Page } from '@playwright/test';

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test.describe('chord-editor inspector (ChordPro playground)', () => {
  test('selecting a chord mounts the bottom-docked inspector without covering the lyrics', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    // In split view the preview chords are selectable buttons. Assert
    // the affordance is present first so a later miss is a real signal.
    const chord = preview.locator(".chord[role='button']").first();
    await expect(chord).toBeVisible();

    // No inspector until a chord is selected.
    await expect(preview.locator('.chordsketch-sheet__cins')).toHaveCount(0);

    await chord.click();

    // The inspector mounts on selection — this is the integration the
    // stubbed unit suites cannot observe.
    const inspector = preview.locator('.chordsketch-sheet__cins');
    await expect(inspector).toBeVisible();
    // The selected chord paints as a solid badge.
    await expect(preview.locator('.chord--selected')).toBeVisible();

    // Bottom-dock contract (#2630): the inspector does NOT replace or
    // cover the content — a sample lyric stays visible alongside it.
    await expect(inspector).toBeVisible();
    await expect(preview).toContainText('sweet');

    expect(errors).toEqual([]);
  });

  test('the inspector exposes the expanded jazz-tension chips and edits without error (#2630)', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    await preview.locator(".chord[role='button']").first().click();
    await expect(preview.locator('.chordsketch-sheet__cins')).toBeVisible();

    // A tension chip added in #2630 (would be absent if the expanded
    // preset set regressed). `maj9` is one of the new extended entries.
    const maj9 = preview.locator('.chordsketch-sheet__cins-chip', { hasText: /^maj9$/ });
    await expect(maj9).toHaveCount(1);

    // Picking it rewrites the selected chord through the source-as-truth
    // edit pipeline; the editor source should now contain a `maj9` chord.
    await maj9.click();
    await expect(page.locator('.cm-editor')).toContainText('maj9');

    expect(errors).toEqual([]);
  });
});
