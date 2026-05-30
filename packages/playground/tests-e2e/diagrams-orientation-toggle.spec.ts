// Playground smoke for the chord-diagrams orientation toggle (#2572).
//
// Targets the production build (`vite preview` over `dist/`) per
// `.claude/rules/playground-smoke.md` — the deployed bundle is what
// users hit and what this spec proves still mounts the toggle and
// flips the diagram orientation end-to-end across the wasm boundary.

import { test, expect } from '@playwright/test';

test('diagrams orientation toggle flips the rendered SVG class end-to-end', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('chordpro/', { waitUntil: 'networkidle' });

  // At least one chord diagram must mount with the default sample
  // (Amazing Grace renders with diagrams enabled by default per the
  // preset selected for #2572's verifiable demo path).
  await page.locator('svg.chord-diagram').first().waitFor({ timeout: 20_000 });

  // Default orientation is vertical — the horizontal-mode class must
  // not be present at first paint.
  const initialClass = await page
    .locator('svg.chord-diagram')
    .first()
    .getAttribute('class');
  expect(initialClass).toContain('chord-diagram');
  expect(initialClass).not.toContain('chord-diagram-horizontal');

  // Flip the orientation toolbar dropdown to horizontal.
  const orientSelect = page.locator(
    '.chordsketch-preview-toolbar__diagrams-orientation',
  );
  await orientSelect.waitFor();

  // Design-system check: the orientation select must pick up the
  // package's design-system tokens, not fall back to the bare
  // browser-native control. Assert (a) the native-arrow `appearance`
  // is suppressed so the custom caret shows, and (b) the border is
  // crimson on focus (focus-ring token). Locks in the rule that the
  // toolbar matches `chordsketch-chord-pro-editor__select` / the
  // design-system `.select` reference (#2572 follow-up).
  const tokenSnapshot = await orientSelect.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      appearance: cs.appearance || (cs as { webkitAppearance?: string }).webkitAppearance,
      borderColor: cs.borderColor,
      borderRadius: cs.borderRadius,
      height: cs.height,
    };
  });
  expect(tokenSnapshot.appearance).toBe('none');
  // 4px radius matches the editor select. A raw browser default
  // would be 0 (Chromium native select renders square corners).
  expect(tokenSnapshot.borderRadius).toBe('4px');
  // 32px height matches the editor select. Native select height is
  // user-agent dependent and would not be 32px.
  expect(tokenSnapshot.height).toBe('32px');

  await orientSelect.selectOption('horizontal');

  await expect
    .poll(
      async () =>
        page.locator('svg.chord-diagram').first().getAttribute('class'),
      { timeout: 5_000 },
    )
    .toContain('chord-diagram-horizontal');

  // Horizontal mode is reader-view only per ADR-0026 — the toolbar
  // must not surface a string-order select.
  await expect(
    page.locator('.chordsketch-preview-toolbar__diagrams-string-order'),
  ).toHaveCount(0);

  // Switching back to vertical drops the horizontal class — the
  // round-trip contract pins that the toggle is bidirectional.
  await orientSelect.selectOption('vertical');
  await expect
    .poll(async () =>
      page.locator('svg.chord-diagram').first().getAttribute('class'),
    )
    .not.toContain('chord-diagram-horizontal');

  expect(errors).toEqual([]);
});
