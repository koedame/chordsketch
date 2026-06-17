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
//
// Audio is ADDITIVE (#2652 follow-up): the default split view wires chord
// selection too, so an audio chord both plays and stays selectable —
// clicking it opens the editing footer. The smoke asserts that
// co-existence so a regression back to the old "audio replaces editing"
// mode fails CI.

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
    // Default split view wires selection too, so the chord is a combined
    // edit+play control ("Edit and play chord …"); a preview-only host
    // would label it "Play chord …". Match either.
    await expect(firstChord).toHaveAttribute('aria-label', /play chord /i);

    // Clicking a chord (a real user gesture, so the autoplay-gated
    // AudioContext may run) must not raise an uncaught exception even if
    // the wasm pitch lookup is still warming up.
    await firstChord.click();

    // Audio is additive: the click ALSO selected the chord for editing,
    // so the footer panel switches into its edit state. This is the core
    // of the #2652 follow-up — editing stays usable while audio is on.
    const footer = page.getByRole('group', { name: /Edit chord/ });
    await expect(footer).toBeVisible();

    // Toggling back off removes the audio affordance.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(audioChords).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
