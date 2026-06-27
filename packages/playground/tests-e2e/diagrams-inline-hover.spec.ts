import { type Page, expect, test } from '@playwright/test';

// Inline / hover compact chord diagrams (ADR-0027). The placement is a
// React-JSX-walker feature (`@chordsketch/react`), and its three known
// regressions are all CSS-layout effects that jsdom unit tests cannot
// observe:
//
//   1. `{diagrams: inline}` — a chord-LESS lyric segment must sit on the
//      same baseline as a chord-bearing segment's lyric. A missing
//      `align-items: flex-end` lets the chord-less lyric float up level
//      with the tall diagram instead of the lyric row.
//   2. `{key}` / `{tempo}` `.meta-inline` chips must stay small inline
//      chips. A stray `song--diagrams-bottom` wrapper (the position
//      modifier defaults to `bottom`) flips `.song` to a flex column and
//      stretches every body child — including the chips — to full width.
//   3. `{diagrams: hover}` — the popover diagram floats free of the line
//      so it must render at the full-size geometry (ADR-0027: "the hover
//      popover floats free, so it uses the full-size diagram"). A compact
//      SVG, or the absolutely-positioned popover collapsing to the
//      trigger's ~10px inline width, makes the diagram unreadable (~0px).
//
// Per `.claude/rules/playground-smoke.md` these are exactly the "in-process
// suites are blind to the integration" cases that require a real-browser
// smoke: each assertion below measures the rendered geometry that the unit
// tests cannot, and would fail on a silent CSS regression while the DOM
// node still exists.

async function setSource(page: Page, text: string) {
  // The CodeMirror editor renders a contenteditable. Wait for it to be
  // visible AND focusable before typing: clicking the DOM node before
  // CodeMirror has claimed keyboard events would send `ControlOrMeta+a`
  // into the void, so the type would APPEND to the sample instead of
  // replacing it — and the test would then measure the wrong source.
  const editor = page.locator('.cm-content');
  await editor.waitFor({ state: 'visible' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

test.describe('inline / hover compact chord diagrams (ADR-0027)', () => {
  test('{diagrams: inline}: chord-less lyric shares the lyric baseline and meta chips stay inline', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('chordpro/', { waitUntil: 'networkidle' });
    await setSource(
      page,
      ['{key: G}', '{tempo: 120}', '{diagrams: inline}', 'Hello [C]world'].join('\n'),
    );

    // The inline diagram cell must mount (the feature actually engaged,
    // not a silent degrade to plain chord names).
    const inlineCell = page.locator('.chord-block-inline-diagram svg').first();
    await expect(inlineCell).toBeVisible();

    // Bug 1 — baseline alignment. The chord-less block ("Hello ") and the
    // chord-bearing block ("world") lyrics must share a bottom edge. The
    // 2px tolerance absorbs sub-pixel rounding only; the regression
    // (missing `align-items: flex-end`) floats the chord-less lyric to
    // the top of the tall diagram row, measured at ~71px spread.
    const lyricBottoms = await page
      .locator('.line--inline-diagrams .chord-block .lyrics')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().bottom)));
    expect(lyricBottoms.length).toBeGreaterThanOrEqual(2);
    const spread = Math.max(...lyricBottoms) - Math.min(...lyricBottoms);
    expect(spread).toBeLessThanOrEqual(2);

    // Center alignment (ADR-0039). The compact diagram is centered over the
    // lyric segment it annotates, not left-edge-aligned: the diagram's
    // horizontal center must match its own lyric's center. Under the fix
    // (`align-items: center`) both children share the block's center, so the
    // skew is sub-pixel. The regression (`align-items: flex-start`) left-
    // aligns the children, so the diagram's center and the (narrower) lyric's
    // center diverge by half the width difference between them — much larger
    // than the 2px tolerance, which absorbs sub-pixel rounding only. Measured
    // per chord-block so the assertion holds regardless of where the block
    // sits in the line.
    const centerSkew = await page
      .locator('.line--inline-diagrams .chord-block-inline-diagram')
      .evaluateAll((cells) =>
        cells.map((cell) => {
          const svg = cell.querySelector('svg');
          // The lyric lives on the sibling `.lyrics` inside the same
          // `.chord-block` (the cell's parent).
          const lyric = cell.parentElement?.querySelector(':scope > .lyrics');
          if (!svg || !lyric) return Number.NaN;
          const s = svg.getBoundingClientRect();
          const l = lyric.getBoundingClientRect();
          return Math.abs((s.left + s.right) / 2 - (l.left + l.right) / 2);
        }),
      );
    expect(centerSkew.length).toBeGreaterThanOrEqual(1);
    for (const skew of centerSkew) {
      expect(skew).toBeLessThanOrEqual(2);
    }

    // Bug 2 — the {key}/{tempo} chips must stay narrow inline chips, NOT
    // stretch to the content width. Measure each chip against its
    // container; a flex-column `.song` stretch makes a chip ~= container
    // width. A real chip is well under half the content width.
    const contentWidth = await page
      .locator('.chordsketch-sheet__content')
      .evaluate((el) => el.getBoundingClientRect().width);
    const chipWidths = await page
      .locator('.meta-inline')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(chipWidths.length).toBeGreaterThanOrEqual(2);
    for (const w of chipWidths) {
      expect(w).toBeLessThan(contentWidth * 0.5);
    }

    expect(errors).toEqual([]);
  });

  test('{diagrams: hover}: the popover renders a full-size, readable diagram', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('chordpro/', { waitUntil: 'networkidle' });
    // Push the chord line down so the `bottom: 100%` popover has room to
    // render above it inside the preview viewport.
    await setSource(
      page,
      ['{diagrams: hover}', '', '', '', '', '', 'line one', 'line two', '[C]Hello [G]world'].join(
        '\n',
      ),
    );

    // Hover mode keeps the chord NAME as a focusable trigger; the inline
    // diagram cell must NOT be used here.
    const trigger = page.locator('.chord-has-diagram').first();
    await expect(trigger).toBeVisible();
    expect(await page.locator('.chord-block-inline-diagram').count()).toBe(0);

    // Reveal the popover (CSS :hover) and measure the inner SVG. Bug 3:
    // the SVG must render at its intrinsic full size, not collapse to the
    // trigger's inline width. The full-size guitar diagram is 73×87; the
    // >60 / >80 floors are deliberately generous so the test tracks
    // "readable" rather than an exact pixel count — yet they still catch
    // the regression, which collapsed the SVG to ~0.17px. The popover must
    // render the regular diagram, not the smaller compact inline layout, so
    // assert it does NOT carry the `chord-diagram-compact` class.
    await trigger.hover();
    const popoverSvg = page.locator('.chord-diagram-popover svg').first();
    await expect(popoverSvg).toBeVisible();
    await expect(popoverSvg).not.toHaveClass(/chord-diagram-compact/);
    const box = await popoverSvg.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(60);
    expect(box!.height).toBeGreaterThan(80);

    expect(errors).toEqual([]);
  });
});
