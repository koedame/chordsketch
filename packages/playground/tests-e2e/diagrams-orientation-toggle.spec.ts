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
