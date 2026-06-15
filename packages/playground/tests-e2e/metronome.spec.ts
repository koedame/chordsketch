import { expect, test } from '@playwright/test';

// Audible-metronome smoke (#2611). The whole `{tempo}` chip is an
// interactive `<MetronomeButton>` (in `@chordsketch/react`, backed by
// the `useMetronome` Web Audio hook): clicking anywhere on the pill
// toggles playback and the frame animates while playing. The
// in-package vitest suite stubs Web Audio, so — per
// `.claude/rules/playground-smoke.md` — only a real-browser smoke
// proves the control actually mounts and toggles in the deployed
// bundle.
//
// The sample ChordPro seed contains `{tempo: 80}`
// (`packages/playground/src/sample.ts`), so the default preview
// renders the metronome control without editing the source.
// Assertions are structural (button presence + `aria-pressed`
// toggle), not audio fidelity, and a `pageerror` listener guards
// against an uncaught exception in the new audio path.

test.describe('audible metronome on the {tempo} chip', () => {
  test('the metronome control mounts and toggles', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('chordpro/', { waitUntil: 'networkidle' });

    // The whole `{tempo}` chip is the interactive control (a button),
    // not just the icon — clicking anywhere on the pill toggles play.
    const button = page.locator('button.meta-inline--tempo').first();
    await expect(button).toBeVisible();
    // The decorative glyph and the BPM readout both live inside it.
    await expect(button.locator('.music-glyph--metronome')).toBeVisible();
    await expect(button).toContainText('BPM');
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // Clicking starts the metronome (Playwright's click is a user
    // gesture, so the autoplay-gated AudioContext is allowed to run).
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // The playing state drives the animated frame via `is-playing`.
    await expect(button).toHaveClass(/is-playing/);

    // Clicking again stops it.
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).not.toHaveClass(/is-playing/);

    expect(errors).toEqual([]);
  });
});
