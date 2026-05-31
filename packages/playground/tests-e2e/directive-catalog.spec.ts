import { expect, test } from '@playwright/test';

const PLAYGROUND_PATH = './chordpro/';

// The "Insert directive" picker is driven by the shared @chordsketch/wasm
// directive catalog (ADR-0028) rather than a hard-coded list. This smoke
// proves the integration end to end in the deployed bundle: the wasm
// `listDirectives` export loads, the playground consumes it, and the
// resulting option list is complete — none of which the in-process unit
// suites observe, since they stub the wasm boundary (see
// .claude/rules/playground-smoke.md).
test.describe('playground directive picker', () => {
  test('populates the directive picker from the shared wasm catalog', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto(PLAYGROUND_PATH);

    const picker = page.getByRole('combobox', {
      name: 'Insert ChordPro directive',
    });
    await expect(picker).toBeVisible();

    // Directives the old hard-coded list omitted are now present. `pagetype`
    // and `diagrams` were both absent before the catalog wiring, so their
    // presence is a regression guard against the picker silently falling
    // back to a stale subset.
    await expect(picker.locator('option', { hasText: /^pagetype$/ })).toHaveCount(
      1,
    );
    await expect(picker.locator('option', { hasText: /^diagrams$/ })).toHaveCount(
      1,
    );

    // The enum-valued `diagrams` directive inserts a colon-ready stub so the
    // editor's value completion can follow; a value-less directive would not
    // carry the trailing `: `.
    await expect(
      picker.locator('option[value="{diagrams: }"]'),
    ).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });
});
