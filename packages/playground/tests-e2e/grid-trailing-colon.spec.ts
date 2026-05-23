// Regression spec for #2556 — typing a `{start_of_grid}` body
// row that ends in a bare `:` no longer hangs the browser. The
// production guard lives in `tokenizeGridLine` (and its Rust
// sister); this spec catches a regression that re-introduces
// the hang AS WELL AS the silent-drop class where the preview
// renders an empty grid instead of an infinite loop.
//
// Per `.claude/rules/playground-smoke.md` a `pageerror`
// listener is registered before navigation so a regression
// that surfaces as an uncaught exception still fails the test.

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

    // `keyboard.type` would drop keystrokes against a not-yet-
    // mounted contenteditable, so wait for both surfaces first.
    await expect(page.locator('.cm-editor')).toBeVisible();
    await expect(page.locator('.chordsketch-preview .song').first()).toBeVisible();

    // Drive CodeMirror through the same path a real user takes
    // so the renderer runs on every intermediate state including
    // the exact bad state. A regression that reintroduces the
    // no-progress loop hangs the very last `:` keystroke and the
    // following locator wait times out.
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type(BROKEN_GRID_SOURCE);

    // Structural shell: a parsed grid section must mount, and at
    // least one bar must be present.
    await expect(page.locator('section.grid')).toBeVisible();
    await expect(page.locator('.grid-bar').first()).toBeVisible();

    // Surviving chord cells: the bare `:` is dropped, but the
    // preceding `C7` and `G7` must still reach the DOM. Asserting
    // chord-name text guards the silent-drop regression class
    // where the tokeniser returns `[]` without hanging.
    await expect(
      page.locator('.grid-chord').filter({ hasText: /^C7$/ }),
    ).toBeVisible();
    await expect(
      page.locator('.grid-chord').filter({ hasText: /^G7$/ }),
    ).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
