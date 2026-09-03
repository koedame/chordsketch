// WCAG audit of every deployed playground route.
//
// The contrast and ARIA defects this suite guards were all found by
// running Lighthouse by hand, months after the markup that introduced
// them landed. Nothing in CI measured rendered colour or computed an
// accessible name, so `--cs-text-tertiary` on 12px labels
// (ADR-0054), `github-dark` comment tokens on a near-black code
// surface (ADR-0055), `role="status"` on `<footer>`, an unnamed
// CodeMirror textbox and three buttons whose accessible name dropped
// their visible text all shipped green.
//
// axe-core is the engine behind Lighthouse's accessibility category,
// so a violation here is a Lighthouse point there. It runs against the
// production build for the reason `.claude/rules/playground-smoke.md`
// gives: the deployed bundle is what users get.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

interface Route {
  readonly path: string;
  /**
   * Rules to switch off for this route only, each with the reason.
   * Never a blanket list: a rule disabled site-wide stops guarding the
   * routes that do satisfy it.
   */
  readonly disable?: Readonly<Record<string, string>>;
}

/**
 * `.cm-scroller` is a scrollable region whose focusable content is
 * `.cm-content`, which CodeMirror makes focusable through
 * `contenteditable` rather than `tabindex` — axe does not count that.
 * Satisfying the rule means putting a `tabindex` on the scroller,
 * which inserts a second tab stop in front of the editor for every
 * keyboard user. Owned upstream in `@codemirror/view`, not here; the
 * rule stays on for every other route.
 */
const CODEMIRROR_SCROLLER = { 'scrollable-region-focusable': 'CodeMirror .cm-scroller' };

const ROUTES: readonly Route[] = [
  { path: './' },
  { path: './chordpro/', disable: CODEMIRROR_SCROLLER },
  { path: './irealpro/' },
  { path: './vue/' },
  { path: './svelte/' },
  { path: './docs/' },
  // Recipe pages — the docs shape that carries syntax-highlighted code
  // fences, which the docs index does not. `embed-react` is here as
  // well as `embed-vue` because its fences are the ones long enough to
  // overflow, making its `<pre>` a scrollable region.
  { path: './docs/embed-vue/' },
  { path: './docs/embed-react/' },
  // A reference page: the other docs shape, and the second one whose
  // fences overflow.
  { path: './docs/reference/ireal-components/' },
];

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * SC 2.5.3 (Label in Name). axe ships the rule as `experimental` and so
 * leaves it off by default, but Lighthouse enables it — it is what
 * caught the chord-audio toggle and the `{key}` / `{tempo}` chips
 * naming themselves after their action instead of their visible text.
 */
const EXTRA_RULES = { 'label-content-name-mismatch': { enabled: true } };

for (const route of ROUTES) {
  test(`${route.path} has no WCAG A/AA violations`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: 'networkidle' });

    const disabled = Object.fromEntries(
      Object.keys(route.disable ?? {}).map((id) => [id, { enabled: false }]),
    );
    // One `options()` call rather than `withTags().disableRules()`:
    // AxeBuilder's `options` replaces whatever those builders staged,
    // so mixing the two silently runs axe's whole default ruleset —
    // best-practice findings included — instead of the WCAG subset.
    const results = await new AxeBuilder({ page })
      .options({
        runOnly: { type: 'tag', values: WCAG_TAGS },
        rules: { ...EXTRA_RULES, ...disabled },
      })
      .analyze();

    // Name the offending selectors and the reason in the failure
    // message — an assertion on the raw array prints an object graph
    // that says nothing about which element is wrong.
    const summary = results.violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n` +
        v.nodes
          .map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary?.replace(/\s+/g, ' ')}`)
          .join('\n'),
    );
    expect(summary, `axe violations on ${route.path}`).toEqual([]);
  });
}
