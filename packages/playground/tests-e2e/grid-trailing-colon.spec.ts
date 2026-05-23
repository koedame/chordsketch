// Regression spec for issue #2556 — the ChordPro grid tokeniser
// hangs the browser when a `{start_of_grid}` body line ends in a
// bare `:` not followed by `|`. Reproduces the user-visible
// failure: load the kitchen-sink sample, delete the trailing
// `| repeat 4 times` one character at a time until the line ends
// in `:`, and confirm the page stays responsive.
//
// Before the fix the cell-text fallback in `tokenizeGridLine`
// (and its Rust sister `tokenize_grid_line`) made no forward
// progress on a bare `:`, leaving the outer `while (i < input
// .length)` loop spinning on the same offset on the JS main
// thread. Playwright's default `actionTimeout` (10 s in the
// playground config) is the catch — a hung renderer never lets
// the next preview update land, so the locator wait fires.
//
// The spec also registers a `pageerror` listener per
// `.claude/rules/playground-smoke.md` so a future regression
// that surfaces as an uncaught exception (rather than a hang)
// still fails the test.

import { expect, test } from '@playwright/test';

const BROKEN_GRID_SOURCE = [
  '{title: Grid Trailing Colon}',
  '',
  '{start_of_grid shape="1+4x2+4"}',
  '     |: C7 . | %  . :|: G7 . | %  . :',
  '{end_of_grid}',
  '',
].join('\n');

test.describe('chordpro grid — bare trailing colon', () => {
  test('does not hang when a grid line ends in a bare `:`', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await page.goto('./chordpro/');

    // Editor + preview must be live before we replace the source —
    // otherwise the controlled-value sync would race the mount.
    await expect(page.locator('.cm-editor')).toBeVisible();
    await expect(page.locator('.chordsketch-preview .song').first()).toBeVisible();

    // Replace the buffer with the bug-triggering source. We
    // select-all + delete + type so CodeMirror's reconciliation
    // path is the one driving the value, matching how a user's
    // edit reaches `tokenizeGridLine`.
    const editor = page.locator('.cm-content');
    await editor.click();
    // `ControlOrMeta+A` is Playwright's built-in cross-platform
    // shorthand (Ctrl on Linux/Windows, Cmd on macOS); no
    // `process.platform` branch needed.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    // `page.keyboard.type` issues keystrokes one at a time, so the
    // renderer runs on every intermediate state including the
    // exact bad state. If the no-progress guard regresses, the
    // very last `:` keystroke would hang the main thread and the
    // following locator wait would time out.
    await page.keyboard.type(BROKEN_GRID_SOURCE);

    // After the bad-state keystroke, the preview must still be
    // able to render the surviving grid markup. We pin a
    // structural anchor that only the parsed-grid path emits:
    // `section.grid` wraps every `{start_of_grid}…{end_of_grid}`
    // block, and `.grid-bar` is one of the structural row cells.
    await expect(page.locator('section.grid')).toBeVisible();
    await expect(page.locator('.grid-bar').first()).toBeVisible();

    // No uncaught exception escaped to the window during the edit
    // sequence (catches the failure class where the regression
    // mutates into a thrown error rather than a hang).
    expect(pageErrors).toEqual([]);
  });
});
