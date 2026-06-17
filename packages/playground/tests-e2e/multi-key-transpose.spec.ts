// Smoke verification for the multi-`{key}` transpose integration.
//
// Regression guard for the Map-vs-object serialization bug: the wasm
// `parseChordproWithWarningsAndOptions` entry point returns
// `transposedKeyDirectives` (every `{key:}` directive's transposed
// value). `serde_wasm_bindgen` serializes Rust maps as ES `Map` by
// default, but the React JSX walker indexes the field with
// plain-object bracket access (`transposedKeyDirectives[keyName]`),
// which is `undefined` on a `Map`. The symptom was that a transposed
// song with several `{key:}` directives rendered the
// "Original → Playing" pair for only the song-primary key and left
// every other key chip unpaired.
//
// This is precisely the integration class `.claude/rules/playground-
// smoke.md` exists for: the React unit tests hand-build the map as a
// plain JS object literal and the Rust unit tests call the parser
// directly, so neither layer ever observes the real wasm boundary.
// Only loading the deployed bundle in a browser proves the map
// crosses the boundary in a shape the walker can read.
//
// Structural assertions only (DOM class names + text content), per
// the playground-smoke authoring guidance.

import { expect, test, type Page } from "@playwright/test";

const MULTI_KEY_SOURCE = [
  "{title: Multi Key Transpose}",
  "{key: G}",
  "[G]first section in G",
  "{key: D}",
  "[D]second section in D",
  "{key: A}",
  "[A]third section in A",
].join("\n");

async function setSource(page: Page, text: string): Promise<void> {
  // Mirror the replace-the-sample dance used by the other specs:
  // wait for CodeMirror to claim keyboard focus before select-all +
  // delete, otherwise the type APPENDS to the bundled sample.
  const editor = page.locator(".cm-content");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

test.describe("multi-{key} transpose", () => {
  test("every {key} directive renders an Original → Playing pair after transpose", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("chordpro/", { waitUntil: "networkidle" });
    await setSource(page, MULTI_KEY_SOURCE);

    // Drive a +2 transpose through the performance toolbar.
    const transposeGroup = page.getByRole("group", { name: "Transpose" });
    await transposeGroup
      .getByRole("combobox", { name: "Transpose" })
      .selectOption("2");

    // All THREE `{key}` directives must surface the paired
    // "Original → Playing" marker. Before the fix only the
    // song-primary key paired (the `soundingKey` fallback), so this
    // count was 1 while the other two stayed plain `.meta-inline--key`
    // chips. `toHaveCount` auto-retries past the preview debounce.
    const pairs = page.locator(".meta-inline--key-pair");
    await expect(pairs).toHaveCount(3);

    // Spot-check the transposed (Playing) values so the assertion
    // fails if the pairing renders but with the wrong key: each pair's
    // second `.meta-inline__group` carries the sounding key. The
    // canonical rendered form is spelled out (ADR-0035), so the chips
    // read "A major" / "E major" / "B major".
    // G + 2 = A, D + 2 = E, A + 2 = B.
    const playing = await pairs.evaluateAll((els) =>
      els.map(
        (el) =>
          el
            .querySelectorAll(".meta-inline__group")[1]
            ?.querySelector(".meta-inline__value")?.textContent ?? "",
      ),
    );
    expect(playing).toEqual(["A major", "E major", "B major"]);

    expect(errors).toEqual([]);
  });
});
