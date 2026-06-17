// Key-audition smoke (#2658). The `{key}` chip the AST walker emits is an
// interactive control: clicking it auditions the key — the movable-do
// scale "do re mi fa sol la ti do" followed by the tonic triad, played
// through the `useKeyAudio` Web Audio hook in `@chordsketch/react`. The
// pitches come from the new `keyScalePitches` / `keyTonicTriad`
// `@chordsketch/wasm` exports.
//
// The in-package vitest suites stub Web Audio and the wasm exports, so —
// per `.claude/rules/playground-smoke.md` — only a real-browser smoke
// proves the interactive `{key}` chip mounts in the deployed bundle and
// that clicking it drives the new wasm exports without an uncaught
// exception. Unlike chord audio, the key chip needs no toggle: it is
// always interactive when Web Audio is available, like the `{tempo}`
// metronome chip.
//
// The default sample ("Amazing Grace") contains `{key: G}`, so the chip
// renders without editing the source. Assertions are structural (the chip
// upgraded from a `<span>` to a `<button>` + no uncaught exceptions);
// audible output is out of scope for a headless smoke.

import { expect, test } from "@playwright/test";

test.describe("key-audition chip on the ChordPro preview", () => {
  test("the {key} chip is an interactive button and clicking it auditions the key without errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("./chordpro/", { waitUntil: "networkidle" });

    // The {key: G} directive renders a key chip. It must upgrade from the
    // static <span> fallback to an interactive <button> once the Web Audio
    // support probe resolves — a span-only state would mean the audition
    // affordance silently failed to mount.
    const keyButton = page.locator("button.meta-inline--key");
    await expect(keyButton.first()).toBeVisible();
    await expect(keyButton.first()).toHaveAttribute(
      "aria-label",
      /play the .* scale and chord/i,
    );

    // Clicking the chip (a real user gesture, so the autoplay-gated
    // AudioContext may run) must not raise an uncaught exception even if
    // the wasm key-pitch lookup is still warming up.
    await keyButton.first().click();

    expect(errors).toEqual([]);
  });
});
