// Regression spec for the ChordPro grid-section column alignment
// (`{start_of_grid}` body lines rendered via `@chordsketch/react`'s
// `chordpro-jsx` walker).
//
// What this spec catches that jsdom unit tests cannot:
//
// 1. **Cross-row leading / trailing barline alignment.** Rows
//    with different leading barline kinds (`|`, `||`, `|:`,
//    `:|:`) must still share a leading-edge X across the whole
//    section, because the section's 5-column CSS grid pins
//    every row's lead cell to col 2 via subgrid + `justify-
//    self: start`. JSDOM has no layout engine, so a regression
//    in the subgrid CSS (e.g., a stray width on `.grid-row__
//    lead` or `.grid-line` losing `display: grid; grid-
//    template-columns: subgrid;`) only surfaces when a real
//    browser computes bounding boxes.
//
// 2. **Cross-row label gutter alignment when label widths
//    differ.** The `A` and `Coda` rows of the kitchen-sink
//    sample land in DIFFERENT bar-count groups (4 vs 5) and
//    have DIFFERENT visible label widths. The section
//    propagates the longest label as `--cs-grid-label-max-
//    text`, which the `::before` pseudo on each `.grid-row__
//    label` renders invisibly to force the cell width to fit
//    the widest label. A previous `inline-flex` version of the
//    label cell laid the visible text and the `::before` sizer
//    side by side and added their widths, giving a too-wide
//    gutter (~95px instead of ~47px). Only a real browser's
//    bounding-rect measurement catches that class of bug.
//
// 3. **`%%` → `%` expansion across two bars.** Per the
//    project's engraving convention, `%%` (repeat-previous-two-
//    bars) is rewritten at render time into a single-bar `%`
//    here plus a single-bar `%` in the following bar. JSDOM
//    can confirm the class names (we do, in the unit suite),
//    but only a real browser confirms the two glyphs sit in
//    horizontally-adjacent bars in the expected order.
//
// The kitchen-sink sample (`packages/playground/src/chordpro/
// main.tsx`) is the canonical input. If that sample's grid
// fixtures change, update this spec to match — the spec is
// deliberately tied to the user-visible content, not to a
// throwaway test-only doc, so that "the playground looks right
// to a human" stays the actual contract.

import { expect, test } from '@playwright/test';

const ALMOST_EQ_PX = 0.5; // round-off slack in floating-point CSS layout

async function pickKitchenSinkSample(page: import('@playwright/test').Page) {
  await page.goto('./chordpro/');
  // Wait for the CodeMirror editor to mount and the wasm-backed
  // preview to produce its first `.song` tree. Without this the
  // sample-select change can fire before the rendered output
  // settles into the expected shape.
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator('.chordsketch-preview .song').first()).toBeVisible();
  await page.selectOption('select[aria-label="Sample song"]', {
    label: 'All directives (kitchen sink)',
  });
  // The preview re-renders after the editor value changes; wait
  // for at least one `section.grid` to land. There are several
  // grid sections in the kitchen-sink sample.
  await expect(page.locator('section.grid').first()).toBeVisible();
}

/**
 * Locate the grid section containing the `A` / `Coda` rows.
 * The kitchen-sink sample currently emits multiple grid sections;
 * this one is identified by having a row whose label text is
 * exactly `"A"` AND a row whose label text is exactly `"Coda"`.
 * Matching on label text rather than DOM position makes the spec
 * survive trivial reorderings of the sample.
 */
async function findAcodaSection(page: import('@playwright/test').Page) {
  // `:has(...)` selects a section that contains both an "A" and
  // a "Coda" label. The Playwright locator `filter({ has })`
  // chain is equivalent and survives older CSS engines.
  const section = page
    .locator('section.grid')
    .filter({
      has: page.locator('.grid-row__label__text', { hasText: /^A$/ }),
    })
    .filter({
      has: page.locator('.grid-row__label__text', { hasText: /^Coda$/ }),
    });
  await expect(section).toHaveCount(1);
  return section;
}

/**
 * Compute the "visual barline X" for a barline element — the
 * conventional engraving anchor position of its glyph kind:
 * - right-anchored (`:|`, `|.`) → element's RIGHT edge (the
 *   thick line sits at the glyph's right side)
 * - left-anchored (`|:`) → element's LEFT edge (the thick
 *   line sits at the glyph's left side)
 * - center-anchored (`|`, `||`, `:|:`, volta) → element's
 *   CENTER (the line / midpoint between lines / midpoint
 *   between thick lines)
 *
 * Every body intermediate kind has its anchor X land on the
 * slot's CENTRE (= the bar boundary), so two barlines of
 * any kinds at the same column position across rows have
 * matching anchor X values even though their bounding boxes
 * differ. This invariant is what makes mixed-kind columns
 * (one row with `|`, another with `:|:`) read as vertically
 * aligned.
 */
async function anchorX(locator: import('@playwright/test').Locator): Promise<number> {
  const data = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const c = el.className;
    if (c.includes('grid-barline--repeat-end') || c.includes('grid-barline--final')) {
      return r.x + r.width;
    }
    if (c.includes('grid-barline--repeat-start')) {
      return r.x;
    }
    return r.x + r.width / 2;
  });
  return Math.round(data * 100) / 100;
}

/** Bounding rect of a single locator (asserts it exists first). */
async function rect(locator: import('@playwright/test').Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`locator ${locator} has no bounding box`);
  return {
    left: box.x,
    right: box.x + box.width,
    width: box.width,
    top: box.y,
    bottom: box.y + box.height,
    height: box.height,
  };
}

test.describe('chordpro grid — column alignment across rows', () => {
  test('A and Coda rows share lead-left, body edges, trail-right, and comment-left', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = await findAcodaSection(page);
    const rows = section.locator('.grid-line');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // Capture per-row edge X positions for the cells the user's
    // spec called out: leading barline (LEFT edge anchored),
    // body (LEFT + RIGHT edges shared = same bar-start / bar-end
    // X across rows), trailing barline (RIGHT edge anchored),
    // comment (LEFT edge anchored).
    const edges: Array<{
      label: string;
      leadLeft: number;
      bodyLeft: number;
      bodyRight: number;
      trailRight: number;
      commentLeft: number;
    }> = [];
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const label = (
        await row.locator('.grid-row__label__text').textContent()
      )?.trim() ?? '';
      const leadR = await rect(row.locator('.grid-row__lead'));
      const bodyR = await rect(row.locator('.grid-line__body'));
      const trailR = await rect(row.locator('.grid-row__trail'));
      const commentR = await rect(row.locator('.grid-row__comment'));
      edges.push({
        label,
        leadLeft: leadR.left,
        bodyLeft: bodyR.left,
        bodyRight: bodyR.right,
        trailRight: trailR.right,
        commentLeft: commentR.left,
      });
    }

    // Sanity check: the section under test actually contains
    // both label kinds — otherwise the alignment assertion is
    // trivially satisfied by a single-row section.
    expect(edges.map((e) => e.label)).toEqual(
      expect.arrayContaining(['A', 'Coda']),
    );

    // Every row must share each edge position within `ALMOST_EQ_
    // PX` of every other row. Comparing every row to the first
    // gives an O(n) check with clear failure messages naming the
    // offending row.
    const baseline = edges[0]!;
    for (let i = 1; i < edges.length; i++) {
      const here = edges[i]!;
      expect(
        Math.abs(here.leadLeft - baseline.leadLeft),
        `row[${i}] label="${here.label}" leadLeft drifted vs row[0] label="${baseline.label}"`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(
        Math.abs(here.bodyLeft - baseline.bodyLeft),
        `row[${i}] label="${here.label}" bodyLeft (= bar-1 X) drifted vs row[0]`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(
        Math.abs(here.bodyRight - baseline.bodyRight),
        `row[${i}] label="${here.label}" bodyRight (= last-bar right X) drifted vs row[0]`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(
        Math.abs(here.trailRight - baseline.trailRight),
        `row[${i}] label="${here.label}" trailRight drifted vs row[0]`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(
        Math.abs(here.commentLeft - baseline.commentLeft),
        `row[${i}] label="${here.label}" commentLeft drifted vs row[0]`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
    }
  });

  // Label gutter width matches the widest label across the
  // section. Without the `::before` sizer this would degrade
  // either to A's width (gutter too narrow for Coda) or to the
  // sum of A + Coda (`inline-flex` regression — sibling flex
  // items added widths instead of overlaying).
  test('label cells render the same width regardless of label text', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = await findAcodaSection(page);
    const labels = section.locator('.grid-row__label');
    const count = await labels.count();
    const widths: number[] = [];
    for (let i = 0; i < count; i++) {
      const w = (await rect(labels.nth(i))).width;
      widths.push(w);
    }
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    expect(max - min).toBeLessThanOrEqual(ALMOST_EQ_PX);
    // The CSS var the section publishes is the longest label
    // wrapped as a CSS string literal — `"Coda"` in this
    // sample. Re-asserting in the browser proves the var
    // actually reaches the rendered DOM (not just that React
    // emitted it in markup).
    const cssVar = await section.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--cs-grid-label-max-text').trim(),
    );
    expect(cssVar).toBe('"Coda"');
  });

  test('comment cells render the same width regardless of comment text', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = await findAcodaSection(page);
    const comments = section.locator('.grid-row__comment');
    const count = await comments.count();
    const widths: number[] = [];
    for (let i = 0; i < count; i++) {
      const w = (await rect(comments.nth(i))).width;
      widths.push(w);
    }
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    expect(max - min).toBeLessThanOrEqual(ALMOST_EQ_PX);
    const cssVar = await section.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--cs-grid-comment-max-text').trim(),
    );
    // The widest comment in the kitchen-sink A/Coda section is
    // `repeat 4 times` (row 3 of the original source). If the
    // sample changes this string, update the expectation.
    expect(cssVar).toBe('"repeat 4 times"');
  });
});

// Per-type lead/trail alignment rules (user spec, 2026-05-23):
//
//   1. `|`            keep as-is (defaults: lead=start, trail=end)
//   2. `||`           lead=start, trail=end, else=center
//   3. `|.`           always end (right)
//   4. `|:`           always start (left)
//   5. `:|`           always end (right)
//   6. `:|:`          always center
//
// These map to `justify-self` on the `.grid-row__lead` /
// `.grid-row__trail` wrappers via `data-barline-type` selectors
// in the React package's stylesheet. The spec drives the
// kitchen-sink sample, walks every grid row, and for each
// `lead` / `trail` slot asserts that its resolved
// `justify-self` matches the rule for its barline type. Drift
// in the CSS (a typo'd selector, an inverted rule, a forgotten
// override) surfaces here as a clear per-row mismatch report.
test.describe('chordpro grid — per-type lead/trail alignment', () => {
  const LEAD_RULES: Record<string, 'start' | 'end' | 'center'> = {
    barline: 'start',
    double: 'start',
    'repeat-start': 'start',
    final: 'end',
    'repeat-end': 'end',
    'repeat-both': 'center',
    volta: 'start',
  };
  const TRAIL_RULES: Record<string, 'start' | 'end' | 'center'> = {
    barline: 'end',
    double: 'end',
    'repeat-start': 'start',
    final: 'end',
    'repeat-end': 'end',
    'repeat-both': 'center',
    volta: 'end',
  };

  test('every lead/trail slot resolves justify-self per barline kind', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const observations = await page.evaluate(() => {
      const out: Array<{
        slot: 'lead' | 'trail';
        kind: string;
        justifySelf: string;
      }> = [];
      for (const sec of Array.from(document.querySelectorAll('section.grid'))) {
        for (const line of Array.from(sec.querySelectorAll('.grid-line'))) {
          for (const slot of ['lead', 'trail'] as const) {
            const el = line.querySelector<HTMLElement>(`.grid-row__${slot}`);
            const kind = el?.getAttribute('data-barline-type');
            if (!el || !kind) continue;
            out.push({
              slot,
              kind,
              justifySelf: getComputedStyle(el).justifySelf,
            });
          }
        }
      }
      return out;
    });

    // Sanity floor: the kitchen-sink sample exercises every
    // major barline kind. If this falls below the floor it
    // means the sample was rewritten and the spec has lost
    // its coverage — update the sample or this floor in lockstep.
    expect(observations.length).toBeGreaterThanOrEqual(8);
    const seenKinds = new Set(observations.map((o) => o.kind));
    // Must observe at least these in some slot, to prove the
    // rules actually fire on real markup.
    for (const required of [
      'barline',
      'double',
      'repeat-start',
      'repeat-end',
      'final',
    ]) {
      expect(seenKinds, `kind "${required}" missing from kitchen-sink observations`).toContain(
        required,
      );
    }

    for (const obs of observations) {
      const rule = obs.slot === 'lead' ? LEAD_RULES[obs.kind] : TRAIL_RULES[obs.kind];
      expect(
        rule,
        `no rule registered for ${obs.slot} kind="${obs.kind}" (sample uses an unknown barline?)`,
      ).toBeDefined();
      expect(
        obs.justifySelf,
        `${obs.slot} kind="${obs.kind}" justify-self mismatch`,
      ).toBe(rule);
    }
  });
});

// Body intermediate barlines follow the SAME per-type
// alignment rules as the lead/trail wrappers (since the body
// is now a CSS grid with uniform slot widths, `justify-self`
// resolves to the engraving-correct anchor for every kind).
// Bare `|`, `||`, `:|:` → center; `|.`, `:|` → end; `|:` →
// start. Bars themselves stretch their 1fr column.
test.describe('chordpro grid — body intermediate barline alignment', () => {
  test('every body barline resolves justify-self per kind', async ({ page }) => {
    await pickKitchenSinkSample(page);
    const observations = await page.evaluate(() => {
      const out: Array<{ cls: string; js: string }> = [];
      for (const body of Array.from(document.querySelectorAll('.grid-line__body'))) {
        for (const el of Array.from(body.children) as HTMLElement[]) {
          if (!el.classList.contains('grid-barline') && !el.classList.contains('grid-volta'))
            continue;
          // First descriptor: which modifier (if any) sits on the
          // element. Multiple cells contribute; reduce to a single
          // canonical kind for the assertion below.
          let kind = 'barline';
          if (el.classList.contains('grid-barline--repeat-both')) kind = 'repeat-both';
          else if (el.classList.contains('grid-barline--repeat-start')) kind = 'repeat-start';
          else if (el.classList.contains('grid-barline--repeat-end')) kind = 'repeat-end';
          else if (el.classList.contains('grid-barline--double')) kind = 'double';
          else if (el.classList.contains('grid-barline--final')) kind = 'final';
          else if (el.classList.contains('grid-volta')) kind = 'volta';
          out.push({ cls: kind, js: getComputedStyle(el).justifySelf });
        }
      }
      return out;
    });
    // Sanity floor — same as the lead/trail spec; if the
    // sample loses coverage of these kinds, update both.
    expect(observations.length).toBeGreaterThanOrEqual(4);
    const RULES: Record<string, 'start' | 'end' | 'center'> = {
      // Body intermediate barlines uniformly use `justify-
      // self: center` — the glyph sits in the centre of its
      // slot, with the slot CENTRE being the bar boundary.
      // Per-kind translates (set in a sibling CSS rule, not
      // observed by this test) shift the right/left-anchored
      // kinds so their conventional anchors also land on the
      // slot centre.
      barline: 'center',
      double: 'center',
      'repeat-start': 'center',
      'repeat-end': 'center',
      'repeat-both': 'center',
      final: 'center',
      volta: 'center',
    };
    for (const o of observations) {
      expect(o.js, `body barline kind="${o.cls}" mismatch`).toBe(RULES[o.cls]);
    }
  });

  // `%` (single-bar repeat) glyph must sit at the centre of
  // the VISIBLE bar — the rectangle between the barline to
  // its left and the barline to its right — not at the
  // centre of its `.grid-bar` ELEMENT. The element only
  // spans the `1fr` body column; the slot to its right
  // visually belongs to the same bar from the reader's
  // perspective, so the visible-bar centre is half a slot
  // to the RIGHT of the element centre. Regression guard:
  // ensure the rendered `%` X matches the visible-bar
  // centre, not the element centre.
  test('% glyph sits at the visible bar centre (= bar element centre under slot-centre boundary model)', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    // A/Coda is the second grid section; row 0 has bars
    // [G7, %, %, %] in a 4-bar group. Inspect the % bars.
    const section = page.locator('section.grid').nth(1);
    const row0 = section.locator('.grid-line').nth(0);
    const data = await row0.evaluate((row) => {
      const bars = Array.from(row.querySelectorAll('.grid-line__body > .grid-bar')) as HTMLElement[];
      return bars.map((bar) => {
        const r = bar.getBoundingClientRect();
        const svg = bar.querySelector('.grid-percent');
        // Under the slot-centre boundary model, visible bar
        // centre equals the .grid-bar element centre — the
        // slot to either side contributes equally (slot/2 on
        // each side) so the midpoint balances out to the
        // element centre.
        return {
          hasPercent: svg !== null,
          elementCenter: Math.round((r.x + r.width / 2) * 100) / 100,
          percentCenter: svg
            ? Math.round((svg.getBoundingClientRect().x + svg.getBoundingClientRect().width / 2) * 100) / 100
            : null,
        };
      });
    });
    for (const bar of data) {
      if (!bar.hasPercent || bar.percentCenter === null) continue;
      expect(
        Math.abs(bar.percentCenter - bar.elementCenter),
        `% center=${bar.percentCenter} should match bar element centre=${bar.elementCenter} (= visible bar centre)`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
    }
  });

  // Regression guard for the `:|:G` overlap. Under the
  // slot-centre boundary model the `:|:` glyph centres on
  // the slot centre and fits ENTIRELY within the slot, so
  // its right edge sits at slot.right - half_slot_width
  // and never crosses into the next bar's element bounds.
  // The chord in the following bar (G7 here) sits at the
  // bar element's left edge with no obscured pixels.
  test(':|: glyph does not overflow into the adjacent bar (no chord overlap)', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid').nth(1);
    const row2 = section.locator('.grid-line').nth(2);
    const repBoth = row2.locator('.grid-line__body > .grid-barline--repeat-both');
    const nextChord = row2.locator('.grid-line__body > .grid-bar').nth(2).locator('.grid-chord');
    expect(await repBoth.count()).toBe(1);
    expect(await nextChord.count()).toBe(1);
    const rb = await rect(repBoth);
    const cr = await rect(nextChord);
    expect(
      rb.right,
      `:|: right edge=${rb.right} must not extend past the next chord's left edge=${cr.left}`,
    ).toBeLessThanOrEqual(cr.left + ALMOST_EQ_PX);
  });

  // `:|:` (repeat-both) is a CENTER-anchored glyph — its
  // conventional engraving anchor is the midpoint between
  // the two thick lines. To make it visually align with a
  // bare `|` line at the SAME column position in a sibling
  // row, the `:|:` glyph's CENTER must sit on the slot's
  // right edge (= bar boundary). With `justify-self: end`
  // alone the glyph's RIGHT edge sits at the slot's right,
  // putting the centre half-a-glyph to the LEFT of where
  // it should be. The `transform: translateX(50%)` fix
  // shifts the glyph rightward by half its own width.
  // Regression guard for the `:|:` shifted-position
  // report.
  test(':|: glyph anchor sits on the slot right edge (= bar boundary)', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid').nth(1);
    // Row 2 of the A/Coda section has the `:|:` intermediate.
    const row2 = section.locator('.grid-line').nth(2);
    const repBoth = row2.locator('.grid-line__body > .grid-barline--repeat-both');
    expect(await repBoth.count()).toBe(1);
    // Row 0 has a bare `|` at the same column position; its
    // anchor X is the reference for "where the boundary is".
    const row0 = section.locator('.grid-line').nth(0);
    const refBarline = row0.locator('.grid-line__body > .grid-barline').nth(1);
    const a1 = await anchorX(repBoth);
    const a0 = await anchorX(refBarline);
    expect(
      Math.abs(a1 - a0),
      `:|: anchor X=${a1} should align with bare | anchor X=${a0}`,
    ).toBeLessThanOrEqual(ALMOST_EQ_PX);
  });

  // Perceived bar spacing must be identical across rows of
  // the same bar count even when the intermediate barline
  // kinds differ. The bar widths themselves are uniform
  // (same `1fr` columns + same slot var), but the prior
  // per-type `justify-self: center` for `||` / `:|:` placed
  // their glyphs in the MIDDLE of their slots instead of
  // the right edge — so the visible barline X for a `||`
  // slot ended up half-a-slot-width to the left of a `|`
  // slot at the same column position in a sibling row. The
  // user's "row 1 (all `|`) is the ideal" feedback drove
  // the unified `end` anchor.
  test('visible barline X stays identical across rows mixing | / || / :|: in same column', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    // A/Coda is the second grid section; its 4-bar group
    // has rows mixing `|`, `||`, and `:|:` at the middle
    // body slot position across rows 0/1/2 (row 3 is the
    // 5-bar Coda group).
    const section = page.locator('section.grid').nth(1);
    // Body's MIDDLE intermediate barline (between bar 2 and
    // bar 3 in a 4-bar row). Body children order: bar,
    // barline, bar, barline, bar, barline, bar. Middle =
    // body child[3].
    const rows = section.locator('.grid-line');
    const rowCount = await rows.count();
    const middleAnchors: number[] = [];
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const bars = await row.locator('.grid-line__body > .grid-bar').count();
      if (bars !== 4) continue; // skip the 5-bar Coda row
      const middle = row.locator('.grid-line__body > .grid-barline').nth(1);
      middleAnchors.push(await anchorX(middle));
    }
    expect(middleAnchors.length).toBeGreaterThanOrEqual(2);
    const baseline = middleAnchors[0]!;
    for (let i = 1; i < middleAnchors.length; i++) {
      expect(
        Math.abs(middleAnchors[i]! - baseline),
        `row[${i}] middle barline anchor X=${middleAnchors[i]} drifted vs row[0] anchor X=${baseline} — per-kind glyph translate regression`,
      ).toBeLessThanOrEqual(ALMOST_EQ_PX);
    }
  });

  // Bar widths are pixel-identical for any two same-bar-count
  // rows in the same section, even when their intermediate
  // barlines mix kinds. Validates the uniform `--cs-grid-
  // barline-slot` propagation + the body CSS-grid layout.
  test('same-bar-count rows have pixel-identical bar widths in body', async ({ page }) => {
    await pickKitchenSinkSample(page);
    const section = await findAcodaSection(page);
    const rows = section.locator('.grid-line');
    const rowCount = await rows.count();
    // Group bars per row by their row's bar count; assert all
    // rows with the same count have equal bar widths.
    const measurements: Array<{ count: number; widths: number[] }> = [];
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const bars = row.locator('.grid-line__body > .grid-bar');
      const n = await bars.count();
      const widths: number[] = [];
      for (let b = 0; b < n; b++) {
        widths.push((await rect(bars.nth(b))).width);
      }
      measurements.push({ count: n, widths });
    }
    const byCount = new Map<number, number[][]>();
    for (const m of measurements) {
      if (!byCount.has(m.count)) byCount.set(m.count, []);
      byCount.get(m.count)!.push(m.widths);
    }
    for (const [n, rowsWidths] of byCount.entries()) {
      if (rowsWidths.length < 2) continue;
      const baseline = rowsWidths[0]!;
      for (let r = 1; r < rowsWidths.length; r++) {
        for (let b = 0; b < n; b++) {
          expect(
            Math.abs(rowsWidths[r]![b]! - baseline[b]!),
            `bar[${b}] width in row[${r}] (count=${n}) drifted vs row[0]`,
          ).toBeLessThanOrEqual(ALMOST_EQ_PX);
        }
      }
    }
  });
});

// Regression spec for the Outro Riff section (kitchen-sink
// row 2 = `|1 Em . . . | C . . . :| |2 Am . . . | G . . . |.`).
// The source legitimately puts TWO consecutive markers in
// the body (`:|` immediately followed by `|2`), which broke
// the prior body grid template that assumed strict bar /
// marker alternation: the cell count exceeded the column
// count, the overflow cells wrapped onto implicit row
// tracks, and the row visually collapsed into a tall stack
// of singletons. After the fix, the template is derived
// from the actual cell sequence and every body cell lands
// on row 1 of the body grid.
test.describe('chordpro grid — Outro Riff (clustered markers)', () => {
  test('every body cell renders on a single grid row (no implicit-row wrap)', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    // Find the Outro Riff section by its section label.
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    await expect(section).toHaveCount(1);
    const rows = section.locator('.grid-line');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const body = row.locator('.grid-line__body');
      // Pull the resolved DOM stats from inside the page so
      // childElementCount and getBoundingClientRect are real
      // browser values.
      const { childCount, childTops, bodyTop } = await body.evaluate((el) => {
        const childs = Array.from(el.children) as HTMLElement[];
        return {
          childCount: childs.length,
          childTops: childs.map((c) => Math.round(c.getBoundingClientRect().top)),
          bodyTop: Math.round(el.getBoundingClientRect().top),
        };
      });
      // The body must have at least 1 child (the row has bars).
      expect(childCount, `row[${i}] body has no children`).toBeGreaterThan(0);
      // Every child sits on the same Y as the body — i.e., none
      // wrapped onto implicit row tracks. (Tolerate small
      // sub-pixel rounding by snapping to integer pixels.)
      for (let c = 0; c < childTops.length; c++) {
        expect(
          Math.abs(childTops[c]! - bodyTop),
          `row[${i}] body child[${c}] top=${childTops[c]} drifted from body top=${bodyTop} — implicit-row wrap regression`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  // The `:| |2` cluster collapses to a single repeat-end
  // marker carrying a volta-2 bracket overlay, so row 2's
  // body cell count matches row 1's (both 4 bars + 3 markers).
  // That means the two rows share the same body grid template
  // and bar X positions land identically — verifies the merge
  // + body-template-from-cells fix together restore visual
  // alignment between the two phrases.
  test('row 1 and row 2 bar X positions match after `:| |2` collapse', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    const rows = section.locator('.grid-line');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    const allLefts: number[][] = [];
    for (let i = 0; i < rowCount; i++) {
      const bars = rows.nth(i).locator('.grid-line__body > .grid-bar');
      const n = await bars.count();
      const lefts: number[] = [];
      for (let b = 0; b < n; b++) {
        lefts.push((await rect(bars.nth(b))).left);
      }
      allLefts.push(lefts);
    }
    // Sanity floor: both rows must have the same bar count
    // for the alignment assertion to be meaningful.
    expect(new Set(allLefts.map((l) => l.length)).size).toBe(1);
    const baseline = allLefts[0]!;
    for (let r = 1; r < allLefts.length; r++) {
      for (let b = 0; b < baseline.length; b++) {
        expect(
          Math.abs(allLefts[r]![b]! - baseline[b]!),
          `row[${r}] bar[${b}] X drifted vs row[0] — :| |2 collapse regression`,
        ).toBeLessThanOrEqual(ALMOST_EQ_PX);
      }
    }
  });

  // Volta bracket overlay surfaces ON the merged host marker
  // (not as a sibling cell). Row 2 of the kitchen-sink source
  // has TWO collapsed pairs — leading `| |1` and middle `:|
  // |2` — so two `.grid-volta__bracket` overlays should be
  // attached to barline-kind hosts in row 2 (one on the
  // leading-edge bare barline, one on the middle repeat-end).
  // Row 1 has no volta markers so zero brackets.
  test('volta brackets render as overlays on their host barlines after collapse', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    const rows = section.locator('.grid-line');
    // Row 1: no voltas at all.
    expect(await rows.nth(0).locator('.grid-volta__bracket').count()).toBe(0);
    expect(await rows.nth(0).locator('.grid-volta').count()).toBe(0);
    // Row 2: two bracket overlays. NO standalone `.grid-volta`
    // cell because the leading `|1` is preceded by the row's
    // implicit bar-grid lead position (handled by the lead/
    // trail extraction, not by a barline marker), so `|1`
    // sits in the lead slot as a standalone volta — that's
    // ONE `.grid-volta`. The middle `|2` collapses into the
    // `:|` host. Total: 2 brackets, 1 standalone volta.
    expect(await rows.nth(1).locator('.grid-volta__bracket').count()).toBe(2);
    expect(await rows.nth(1).locator('.grid-volta').count()).toBe(1);
  });

  // Visible barline X parity across rows: row 1's bare `|`
  // in the middle of the body and row 2's `:|` (merged with
  // volta-2) in the SAME column position must paint their
  // visible barline on the same X. Both anchor at the slot's
  // RIGHT edge (`justify-self: end` default for `|`; same
  // override for `repeat-end`), so the `|`'s line and the
  // `:|`'s thick line share an X. Without this parity the
  // engraving reads as misaligned barlines between the two
  // phrases — the user-reported regression that motivated
  // the default change from `center` to `end` for bare `|`.
  test('bare | and merged :| paint their visible line on the same X across rows', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    // Row 1 body's MIDDLE bare barline (between bars 2 and 3).
    // Body has 7 children: bar, barline, bar, barline, bar,
    // barline, bar. Middle barline = body child[3].
    const row1Mid = section.locator('.grid-line').nth(0).locator('.grid-line__body > .grid-barline').nth(1);
    // Row 2 body's middle marker — the merged `:|+v2` host.
    const row2Mid = section.locator('.grid-line').nth(1).locator('.grid-line__body .grid-barline--repeat-end');
    // Each kind anchors at its conventional position: bare
    // `|` at glyph centre (after the +50% translate), merged
    // `:|` at glyph right edge (no translate). Both anchor
    // X values must coincide — they should both sit on the
    // bar boundary X for this column position.
    const a1 = await anchorX(row1Mid);
    const a2 = await anchorX(row2Mid);
    expect(
      Math.abs(a1 - a2),
      `row1 | anchor X=${a1} should match row2 :| anchor X=${a2} (bar boundary)`,
    ).toBeLessThanOrEqual(ALMOST_EQ_PX);
  });

  // Volta bracket's L-shape leg MUST start at the host glyph's
  // conventional "barline X" — that is, the X of the line
  // that the volta annotates. For `:|` (repeat-end) the
  // anchor is the thick line on the right edge of the glyph,
  // so the bracket's LEFT EDGE (the leg, painted via
  // `border-left`) must align with the host's right edge.
  // For a standalone volta at the row lead position, the
  // host's own line is at its left edge so the bracket's
  // left edge sits there. Regression guard — the bracket's
  // visible left border is the L's vertical leg, and it must
  // visually continue into the barline beneath it.
  test('volta bracket leg anchors at the host barline X per host kind', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    const row2 = section.locator('.grid-line').nth(1);

    // Case A: standalone leading volta `|1` (NOT collapsed).
    // The bracket's left edge (= leg) sits at the volta
    // element's left edge, continuing into the volta's own
    // line below.
    const leadVolta = row2.locator('.grid-row__lead .grid-volta');
    expect(await leadVolta.count()).toBe(1);
    const leadVoltaBox = await rect(leadVolta);
    const leadBracket = leadVolta.locator('.grid-volta__bracket');
    const leadBracketBox = await rect(leadBracket);
    expect(
      Math.abs(leadBracketBox.left - leadVoltaBox.left),
      'leading volta bracket leg should start at the volta element left edge',
    ).toBeLessThanOrEqual(ALMOST_EQ_PX);

    // Case B: merged `:| |2` overlay on the body's repeat-end
    // host. The host's barline X is the THICK line on the
    // right edge of the glyph, so the bracket's left edge
    // (the leg) must align with the host's right edge.
    const merged = row2.locator('.grid-line__body .grid-barline--repeat-end');
    expect(await merged.count()).toBe(1);
    const hostBox = await rect(merged);
    const mergedBracket = merged.locator('.grid-volta__bracket');
    expect(await mergedBracket.count()).toBe(1);
    const bracketBox = await rect(mergedBracket);
    expect(
      Math.abs(bracketBox.left - hostBox.right),
      `merged volta bracket leg left=${bracketBox.left} should align with host right=${hostBox.right} for repeat-end`,
    ).toBeLessThanOrEqual(ALMOST_EQ_PX);
  });

  // Visual breathing room: the bracket bottom must sit ~4px
  // ABOVE the host's top edge so the leg and the barline
  // beneath read as two distinct strokes (not a single
  // continuous run of pixels). Regression guard for the
  // intentional gap — accept a small rounding band around
  // the nominal 4px so sub-pixel layout drift does not
  // flake the test.
  test('volta bracket leaves a ~4px gap above the host barline', async ({ page }) => {
    const NOMINAL_GAP_PX = 4;
    const GAP_TOLERANCE_PX = 1.5;
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    const row2 = section.locator('.grid-line').nth(1);
    // Standalone leading volta's host = the volta element
    // itself; the bracket's bottom should sit above the
    // host's top by ~4px.
    const leadVolta = row2.locator('.grid-row__lead .grid-volta');
    const leadHostBox = await rect(leadVolta);
    const leadBracketBox = await rect(leadVolta.locator('.grid-volta__bracket'));
    const leadGap = leadHostBox.top - leadBracketBox.bottom;
    expect(
      Math.abs(leadGap - NOMINAL_GAP_PX),
      `leading-volta gap=${leadGap}px should be ~${NOMINAL_GAP_PX}px`,
    ).toBeLessThanOrEqual(GAP_TOLERANCE_PX);
    // Merged repeat-end host.
    const merged = row2.locator('.grid-line__body .grid-barline--repeat-end');
    const mergedHostBox = await rect(merged);
    const mergedBracketBox = await rect(merged.locator('.grid-volta__bracket'));
    const mergedGap = mergedHostBox.top - mergedBracketBox.bottom;
    expect(
      Math.abs(mergedGap - NOMINAL_GAP_PX),
      `merged-volta gap=${mergedGap}px should be ~${NOMINAL_GAP_PX}px`,
    ).toBeLessThanOrEqual(GAP_TOLERANCE_PX);
  });

  // L-shape integrity: the bracket box renders BOTH a
  // `border-top` (the cap) AND a `border-left` (the leg).
  // Without either border the engraving collapses to a
  // dangling label, so guard both via computed style.
  test('volta bracket renders both top and left borders for the L-shape', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    const brackets = section.locator('.grid-volta__bracket');
    const count = await brackets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const borders = await brackets.nth(i).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          topWidth: parseFloat(cs.borderTopWidth),
          topStyle: cs.borderTopStyle,
          leftWidth: parseFloat(cs.borderLeftWidth),
          leftStyle: cs.borderLeftStyle,
          // No right / bottom borders — the L is open on those
          // two sides so the cap extends RIGHTWARD over the
          // bracketed bars and the leg only descends downward.
          rightWidth: parseFloat(cs.borderRightWidth),
          bottomWidth: parseFloat(cs.borderBottomWidth),
        };
      });
      expect(borders.topWidth, `bracket[${i}] border-top width`).toBeGreaterThan(0);
      expect(borders.topStyle).toBe('solid');
      expect(borders.leftWidth, `bracket[${i}] border-left width`).toBeGreaterThan(0);
      expect(borders.leftStyle).toBe('solid');
      expect(borders.rightWidth, `bracket[${i}] must not paint a right border`).toBe(0);
      expect(borders.bottomWidth, `bracket[${i}] must not paint a bottom border`).toBe(0);
    }
  });

  // Bar X positions don't perfectly align between Outro Riff
  // rows because row 2 carries an extra `:| |2` pair the
  // first row does not. What MUST be aligned is the section-
  // level edges: lead-left, body-left, body-right, trail-
  // right. This catches a regression where the grid layout
  // resync between the two rows would break under the cluster.
  test('lead/body/trail edges stay aligned across rows even with clustered body markers', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    const section = page.locator('section.grid', { hasText: 'Outro Riff' });
    const rows = section.locator('.grid-line');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    const edges: Array<{ leadLeft: number; bodyLeft: number; bodyRight: number; trailRight: number }> = [];
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const leadR = await rect(row.locator('.grid-row__lead'));
      const bodyR = await rect(row.locator('.grid-line__body'));
      const trailR = await rect(row.locator('.grid-row__trail'));
      edges.push({
        leadLeft: leadR.left,
        bodyLeft: bodyR.left,
        bodyRight: bodyR.right,
        trailRight: trailR.right,
      });
    }
    const baseline = edges[0]!;
    for (let i = 1; i < edges.length; i++) {
      const here = edges[i]!;
      expect(Math.abs(here.leadLeft - baseline.leadLeft), `row[${i}] leadLeft drift`).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(Math.abs(here.bodyLeft - baseline.bodyLeft), `row[${i}] bodyLeft drift`).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(Math.abs(here.bodyRight - baseline.bodyRight), `row[${i}] bodyRight drift`).toBeLessThanOrEqual(ALMOST_EQ_PX);
      expect(Math.abs(here.trailRight - baseline.trailRight), `row[${i}] trailRight drift`).toBeLessThanOrEqual(ALMOST_EQ_PX);
    }
  });
});

test.describe('chordpro grid — `%%` expansion', () => {
  test('no `--percent2` cells survive; `%%` becomes two adjacent `%` glyphs', async ({
    page,
  }) => {
    await pickKitchenSinkSample(page);
    // Anywhere in the rendered page — `%%` is expanded in every
    // grid renderer pass, so a stray `--percent2` class
    // anywhere is the regression signal.
    await expect(page.locator('.grid-beat--percent2')).toHaveCount(0);
    // The kitchen-sink sample has at least one row containing
    // `%% .` followed by `. .` (the "(2) Full-syntax" grid
    // section). After expansion that row carries at least two
    // adjacent `%` beats. Looking up the first matching row by
    // its `data-label-text="A"` keeps the assertion bound to a
    // stable structural anchor.
    const row = page.locator('.grid-line[data-label-text="A"]').first();
    const percentBeats = row.locator('.grid-beat--percent1');
    // Row has at least three `%` after expansion (one from the
    // standalone `% .` bar 2, one from the `%% .` bar 3, plus
    // one from the auto-injected next-bar `% .`). Use `>=` so
    // the spec survives small fixture tweaks.
    expect(await percentBeats.count()).toBeGreaterThanOrEqual(3);
  });
});
