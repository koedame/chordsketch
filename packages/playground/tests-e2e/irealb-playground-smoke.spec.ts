// Smoke verification that the playground's iReal Pro route mounts.
// The iRealb route at `/chordsketch/irealpro/` boots the wasm
// bundle and renders an `irealb://` URL through
// `parseIrealb` → AST → React chart pipeline. Each spec asserts a
// structural anchor (a DOM element only the mounted adapter would
// create) so the test fails loudly if the mount path silently
// degrades.
//
// Per `.claude/rules/playground-smoke.md`, this spec exists because
// `packages/playground/src/irealpro/main.tsx` mounts a wasm-backed
// React app on a new `parseIrealb` invocation site. The
// `mountChordSketchUi`-style wasm-init race (#2397) the rule was
// authored against is the exact class of regression a deep-link
// smoke must catch.
//
// Assertions are intentionally structural, not visual: we are
// guarding the "the page is wired up" guarantee, not the rendering
// fidelity of the chart itself.

import { expect, test } from '@playwright/test';

test.describe('iRealb playground mount', () => {
  test('chart mounts seeded with sample URL and no uncaught exceptions', async ({
    page,
  }) => {
    // `pageerror` fires only on uncaught exceptions reaching the
    // window. Per `playground-smoke.md` "Authoring guidance", this
    // is decoupled from any specific symbol name so the assertion
    // stays robust against wasm-bindgen rename churn — a regression
    // of the `?#format=irealb` wasm-init race class would surface
    // here regardless of which symbol the exception names.
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await page.goto('./irealpro/');

    // The wasm bootstrap is async — `parseIrealb` is only callable
    // after `init()` resolves. Wait for the chart's structural
    // anchor instead of polling for a specific text fragment, so
    // the assertion is robust against the sample URL being swapped
    // for a different default.
    const chart = page.locator('section.chart');
    await expect(chart).toBeVisible();

    // The chart-body container only renders once the parser
    // produced a non-null AST. Asserting both anchors together
    // proves the wasm pipeline ran end-to-end: chart wrapper +
    // populated body = `parseIrealb` succeeded + React chart
    // mounted. A regression that stranded the UI on the
    // `Loading…` placeholder (wasm-init never resolves) or on
    // the parse-error pane (`role="alert"`) would fail this
    // assertion.
    await expect(chart.locator('.chart-body')).toBeVisible();

    // The URL textarea is the canonical edit surface. The accessible
    // name `iRealb URL` matches both the section wrapper (aria-label
    // "iRealb URL editor") and the textarea itself; scoping by role
    // disambiguates to the textarea exactly.
    const urlField = page.getByRole('textbox', { name: 'iRealb URL' });
    await expect(urlField).toBeVisible();
    await expect(urlField).not.toHaveValue('');

    // Drive a basic interaction: editing the URL field should
    // trigger a re-parse. We don't assert what the new state looks
    // like (a malformed URL would land on the error pane, which
    // is also a valid "the pipeline ran" outcome) — we only
    // require that the page survives the edit without an uncaught
    // exception. The end-of-spec `pageErrors` assertion catches
    // any wasm panic that escapes the React error boundary.
    await urlField.fill('irealb://Smoke%20Test%3D%3D%3DC%3D44%3D');

    // No uncaught exception leaked to the window during mount or
    // the interaction above. The pre-#2397 failure class — a
    // wasm-init race — would surface here regardless of which
    // symbol the runtime cited.
    expect(pageErrors).toEqual([]);
  });
});
