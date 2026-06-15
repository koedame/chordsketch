// Regression coverage for the pane-visibility modes of the ChordPro
// playground.
//
// The playground relays the editor caret into `<RendererPreview>` so
// the split view can highlight the line being edited (`line--active`)
// and draw a caret marker (`.caret-marker`). The overlay only makes
// sense in split view, where the editor sits beside the preview. In
// preview-only view the editor is unmounted, so the overlay would
// point at a caret the user can no longer see — it must not render.
// The caret state survives the view switch (it is only reset on editor
// focus), so without an explicit guard the stale highlight leaks into
// the clean rendered sheet.
//
// Assertions are structural (presence / absence of the overlay
// classes), matching the rest of the e2e smoke suite. Each test
// registers a `pageerror` listener so a JS exception thrown during a
// view switch fails the test even when the DOM still renders, per
// `.claude/rules/playground-smoke.md`.

import { expect, test, type Page } from '@playwright/test';

// Place the caret on a lyric line so the preview has a body element
// mapped to that source line to highlight, and a lyric caret position
// for the marker. Clicking a `.cm-line` element drives CodeMirror's
// selection, which fires the playground's `onCaretChange` relay.
async function focusLyricCaret(page: Page): Promise<void> {
  const lyric = page
    .locator('.cm-editor .cm-line')
    .filter({ hasText: 'sweet' });
  // The default sample has exactly one "sweet"; assert it so the helper
  // fails loudly rather than silently clicking the wrong line should the
  // sample ever gain a second occurrence.
  await expect(lyric).toHaveCount(1);
  await lyric.click();
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test.describe('playground pane visibility', () => {
  test('split view highlights the caret line once the editor is focused', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    const preview = page.locator('.pane.preview');
    // Caret is null until the editor is focused, so a fresh load shows
    // no overlay. Asserting the baseline makes the "appears on focus"
    // assertion below meaningful.
    await expect(preview.locator('.line--active')).toHaveCount(0);
    await expect(preview.locator('.caret-marker')).toHaveCount(0);

    await focusLyricCaret(page);
    await expect(preview.locator('.line--active')).toBeVisible();
    await expect(preview.locator('.caret-marker')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('preview-only view suppresses the active-line highlight and caret marker', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    const editor = page.locator('.cm-editor');
    await expect(editor).toBeVisible();

    // Establish a caret in split view first and confirm the overlay is
    // actually present, so the absence asserted after the switch is a
    // real regression signal rather than a vacuous pass.
    await focusLyricCaret(page);
    const preview = page.locator('.pane.preview');
    await expect(preview.locator('.line--active')).toBeVisible();
    await expect(preview.locator('.caret-marker')).toBeVisible();

    await page.getByRole('button', { name: 'Preview' }).click();

    // Editor is gone; the rendered sheet is still there...
    await expect(editor).toHaveCount(0);
    await expect(preview).toContainText('sweet');
    // ...but the caret-driven overlay must not be.
    await expect(preview.locator('.line--active')).toHaveCount(0);
    await expect(preview.locator('.caret-marker')).toHaveCount(0);

    // Returning to split restores the overlay — the suppression is
    // scoped to the view, not a permanent teardown of the caret state.
    await page.getByRole('button', { name: 'Split' }).click();
    await expect(preview.locator('.line--active')).toBeVisible();
    await expect(preview.locator('.caret-marker')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('preview-only view disables chord drag-and-drop repositioning', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    // Drag-and-drop chord repositioning is an editing gesture: a drop
    // rewrites the ChordPro source the editor shows. In split view the
    // editor is mounted, so the preview's `.chord` spans are drag
    // sources (`draggable="true"`). Assert the affordance is present
    // first so the absence asserted after the switch is a real
    // regression signal, not a vacuous pass.
    const preview = page.locator('.pane.preview');
    await expect(preview.locator('.chord[draggable="true"]').first()).toBeVisible();

    await page.getByRole('button', { name: 'Preview' }).click();

    // Editor is gone; the rendered sheet is still there as a read-only
    // display surface...
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await expect(preview).toContainText('sweet');
    // ...but no chord may be draggable — preview-only is display-only,
    // so a drop cannot silently rewrite source the user cannot see.
    await expect(preview.locator('[draggable="true"]')).toHaveCount(0);

    // Returning to split restores the drag affordance — the suppression
    // is scoped to the view, not a permanent teardown.
    await page.getByRole('button', { name: 'Split' }).click();
    await expect(preview.locator('.chord[draggable="true"]').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('source-only view unmounts the preview pane entirely', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto('./chordpro/');
    await expect(page.locator('.cm-editor')).toBeVisible();

    await page.getByRole('button', { name: 'Source' }).click();
    // The preview pane is gated out of the DOM in source-only view, so
    // there is no surface for a stale overlay to render on.
    await expect(page.locator('.pane.preview')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
