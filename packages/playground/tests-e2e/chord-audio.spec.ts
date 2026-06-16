import { expect, test } from '@playwright/test';

// Chord-audio smoke (#2650). The toolbar's "Chord audio" toggle puts
// the preview into audio mode, where every rendered chord becomes a
// play button (`.chord--audio`, backed by the `useChordAudio` Web Audio
// hook in `@chordsketch/react`). The in-package vitest suites stub Web
// Audio and the wasm `chordPitches` export, so — per
// `.claude/rules/playground-smoke.md` — only a real-browser smoke
// proves the toggle wires the audio mode into the deployed bundle's
// preview.
//
// The default sample ("Amazing Grace") contains chords, so the preview
// renders chord spans without editing the source. Assertions are
// structural (toggle state + `.chord--audio` presence + no uncaught
// exceptions); audible output is out of scope for a headless smoke.

test.describe('chord-audio toggle on the ChordPro preview', () => {
  test('toggling Chord audio turns chords into play buttons without errors', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('./chordpro/', { waitUntil: 'networkidle' });

    const toolbar = page.getByRole('toolbar', {
      name: 'Preview performance controls',
    });
    await expect(toolbar).toBeVisible();

    const toggle = toolbar.getByRole('button', { name: 'Play chords on click' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Before enabling audio mode, no chord carries the audio affordance.
    const audioChords = page.locator('.chordsketch-preview .chord--audio');
    await expect(audioChords).toHaveCount(0);

    // Enable audio mode: chords become play buttons.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(audioChords.first()).toBeVisible();

    const firstChord = audioChords.first();
    await expect(firstChord).toHaveAttribute('role', 'button');
    await expect(firstChord).toHaveAttribute('aria-label', /^Play chord /);

    // Clicking a chord (a real user gesture, so the autoplay-gated
    // AudioContext may run) must not raise an uncaught exception even if
    // the wasm pitch lookup is still warming up.
    await firstChord.click();

    // Toggling back off removes the audio affordance.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(audioChords).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
