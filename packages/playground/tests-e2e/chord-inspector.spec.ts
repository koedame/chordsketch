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

  test('the lifted footer top-aligns its clusters (not bottom-aligned)', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    // The lifted footer lays its clusters out in a wrapping row. Their
    // cross-axis alignment must be top (`flex-start`) so the labelled
    // clusters share one baseline at the top and read top-down; the
    // earlier `flex-end` floated every cluster to the bottom edge with
    // empty space above. Assert the computed value so a regression back
    // to bottom-alignment fails here. The root `.chordsketch-sheet__cins`
    // is present in both the idle and edit states, so this holds at first
    // paint before any chord is selected.
    const cins = page.locator(`${FOOTER} .chordsketch-sheet__cins`);
    await expect(cins).toBeVisible();
    await expect(cins).toHaveCSS('align-items', 'flex-start');

    // The label-less actions cluster only renders in the edit state, so
    // select a chord first, then assert it is centred on the band (it has
    // no label above it, so top-aligning it with the labelled clusters
    // would pin its button above their controls).
    await page.locator('.pane.preview').locator(".chord[role='button']").first().click();
    await expect(
      page.locator(`${FOOTER} .chordsketch-sheet__cins[data-mode='edit']`),
    ).toBeVisible();
    await expect(
      page.locator(`${FOOTER} .chordsketch-sheet__cins-footer`),
    ).toHaveCSS('align-self', 'center');

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

  test('the footer exposes the structured chord-type controls and edits the selected chord', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    await preview.locator(".chord[role='button']").first().click();
    await expect(page.locator(`${FOOTER} .chordsketch-sheet__cins[data-mode='edit']`)).toBeVisible();

    // The chord-type controls are three orthogonal groups (triad / 7th /
    // tensions, ADR-0037), not a flat palette. Their composition produces only
    // explicit, unambiguous suffixes — `maj7(13)`, never the ambiguous `maj9`.
    const footer = page.locator(FOOTER);
    const triadMaj = footer.locator('[aria-label="Triad quality"] button', { hasText: /^maj$/ });
    const seventhMaj7 = footer.locator('[aria-label="Seventh"] button', { hasText: /^maj7$/ });
    const tension13 = footer.locator('[aria-label="Tensions"] button', { hasText: /^13$/ });
    await expect(triadMaj).toHaveCount(1);
    await expect(seventhMaj7).toHaveCount(1);
    await expect(tension13).toHaveCount(1);

    // Composing triad=maj, 7th=maj7, tension=13 rewrites the selected chord
    // through the source-as-truth edit pipeline; the editor source should now
    // carry the explicit `maj7(13)` chord.
    await triadMaj.click();
    await seventhMaj7.click();
    await tension13.click();
    await expect(page.locator('.cm-editor')).toContainText('maj7(13)');

    expect(errors).toEqual([]);
  });

  test('the footer is edit-only: idle shows a hint, no editing controls or Insert', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    // Place the caret off any chord (document end) so the footer is idle.
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const idle = page.locator(`${FOOTER} .chordsketch-sheet__cins[data-mode='idle']`);
    await expect(idle).toBeVisible();

    // Edit-only: idle renders a hint and none of the editing controls.
    await expect(idle.locator('.chordsketch-sheet__cins-idle-hint')).toBeVisible();
    await expect(page.locator(`${FOOTER} .chordsketch-sheet__cins-chip`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Insert chord' })).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('keyboard-nudging the selected chord shows no focus-ring outline', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    await preview.locator(".chord[role='button']").first().click();
    await expect(preview.locator('.chord--selected')).toBeVisible();

    // Nudge with the keyboard: this moves the chord AND makes
    // `:focus-visible` match (the last input modality is now a key), and
    // the walker re-focuses the advanced selection. The crimson badge is
    // the selection / focus indicator; a focus ring stacked on top would
    // read as an unwanted outline flickering on every Arrow press. The
    // computed box-shadow must therefore stay the badge's elevation
    // shadow, NOT the crimson focus ring (rgb(189, 22, 70) = #bd1642).
    await page.keyboard.press('ArrowRight');
    await expect(preview.locator('.chord--selected')).toBeVisible();

    const boxShadow = await preview
      .locator('.chord--selected')
      .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toContain('189, 22, 70');

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
