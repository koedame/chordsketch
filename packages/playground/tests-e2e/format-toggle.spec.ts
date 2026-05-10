// Smoke verification that the playground's ChordPro editor mounts.
// Each spec asserts a structural anchor (a DOM element only the
// mounted adapter would create) so the test fails loudly if the
// mount path silently degrades.
//
// Assertions are intentionally structural, not visual: we are
// guarding the "the page is wired up" guarantee, not the rendering
// fidelity of the editor itself.
//
// The ChordPro adapter is the CodeMirror 6 editor introduced in
// #2454: the visible structural anchors are `.cm-editor` (the root
// CM6 view container) and `.cm-content` (the contenteditable
// document body). We assert the seed text shows up inside
// `.cm-content` rather than via `toHaveValue`, since CodeMirror
// renders the doc as DOM text rather than as a form-control value.
//
// iRealb support was removed from the playground in the
// 2026-05-09 design-system migration window and is tracked for
// reintroduction once the React component surface for the
// bar-grid editor is ready. The corresponding deep-link spec
// (`irealb-deep-link.spec.ts`) was deleted at the same time;
// re-add it alongside the iRealb React component.

import { expect, test } from '@playwright/test';

test.describe('playground editor mount', () => {
  test('the ChordPro editor mounts seeded with sample content', async ({
    page,
  }) => {
    await page.goto('./chordpro/');
    const cmEditor = page.locator('.cm-editor');
    await expect(cmEditor).toBeVisible();
    // The default seed is `SAMPLE_CHORDPRO`; an empty doc would
    // mean either the seed was lost or the editor swap fired
    // unexpectedly during mount. Match against a known fragment
    // from the seed (the `{title:` directive prefix) so the
    // assertion stays robust against trivial whitespace tweaks.
    await expect(cmEditor.locator('.cm-content')).toContainText('{title:');
  });
});
