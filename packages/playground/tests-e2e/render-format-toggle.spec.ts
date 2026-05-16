// Pins the inline-render contract on the playground's HTML
// preview surface.
//
// Pre-#2475 this spec drove the Format `<select>` and asserted a
// monotonic cache-bust marker inside the iframe `srcdoc`
// (#2421 / PR #2322 / #2421). After the AST → JSX cut-over
// (ADR-0017, this PR) the html branch renders inline through
// `<ChordSheet format="html">`'s walker — no iframe, no
// `srcdoc`, no cache-bust marker. The invariant that survived
// the architecture change is "transpose changes the rendered
// chord names": the AST → JSX path replaces the previous
// "transpose changes the iframe's srcdoc string" guarantee with
// the more direct "React re-renders the DOM with new chord
// labels".
//
// Selectors target the React playground (#2454 / #2475):
// `.chordsketch-preview .song` is the AST → JSX root, and chord
// labels live inside `.chord-block .chord` spans. The transpose
// stepper is labelled "Transpose up one semitone".

import { expect, test } from '@playwright/test';

async function chordTexts(
  page: import('@playwright/test').Page,
): Promise<string[]> {
  return page
    .locator('.chordsketch-preview .song .chord-block .chord')
    .allInnerTexts();
}

test.describe('playground render inline path', () => {
  test('mount-time render produces a `.song` tree with chord labels', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const song = page.locator('.chordsketch-preview .song');
    await expect(song).toBeVisible();
    // The default seed contains lyrics with chord annotations;
    // the AST walker emits a `.chord` span per chord segment.
    await expect
      .poll(async () => (await chordTexts(page)).length)
      .toBeGreaterThan(0);
  });

  test('transpose changes the rendered chord labels', async ({ page }) => {
    await page.goto('./chordpro/');
    const song = page.locator('.chordsketch-preview .song');
    await expect(song).toBeVisible();

    const initial = await chordTexts(page);
    expect(initial.length).toBeGreaterThan(0);

    await page.getByLabel('Transpose up one semitone').click();
    await expect
      .poll(async () => (await chordTexts(page)).join('|'))
      .not.toBe(initial.join('|'));

    const after = await chordTexts(page);
    expect(after.length).toBe(initial.length);
  });

  test('repeated transpose steps produce strictly distinct chord-label sets', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    await expect(page.locator('.chordsketch-preview .song')).toBeVisible();
    const upButton = page.getByLabel('Transpose up one semitone');

    const seen = new Set<string>();
    seen.add((await chordTexts(page)).join('|'));
    let last = (await chordTexts(page)).join('|');
    for (let i = 0; i < 4; i++) {
      await upButton.click();
      await expect.poll(async () => (await chordTexts(page)).join('|')).not.toBe(last);
      last = (await chordTexts(page)).join('|');
      seen.add(last);
    }
    // 1 mount-time + 4 post-step states = 5 distinct chord-label
    // strings. A regression that breaks the transpose pipeline (or
    // the AST → JSX walker) would collapse this set.
    expect(seen.size).toBe(5);
  });
});
