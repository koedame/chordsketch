import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/**
 * The chrome and layout vocabulary this package ships as CSS (ADR-0061).
 * `design-system/DESIGN.md` §4.1 / §6 / §9 name these canonical, and §11
 * makes removing or renaming one a MAJOR change — so the published
 * stylesheet is asserted to carry each of them rather than whatever the
 * generator's family matchers happened to find in the reference pages.
 * A class deleted upstream is a deletion decision, not a silent one.
 */
const CHROME_SELECTORS = [
  '.topnav',
  '.topnav .brand',
  '.topnav .crumbs',
  '.topnav .nav-links',
  '.topnav .right',
  '.topnav .save-state',
  '.topnav .actions',
  '.sidenav',
  '.sidenav nav',
  '.sidenav .body',
  '.pane',
  '.pane-head',
  '.pane-body',
  '.stack',
  ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32].map((n) => `.stack-${n}`),
];

const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
  'utf8',
);

/**
 * The region a marker pair delimits, comments stripped. `start` matches the
 * opening marker by its stable prefix (the rest of that comment names the
 * generator and how to run it); the region begins after the comment closes.
 */
function region(css: string, start: string, end: string): string {
  const marker = css.indexOf(start);
  expect(marker, `missing marker: ${start}`).toBeGreaterThan(-1);
  const from = css.indexOf('*/', marker) + '*/'.length;
  const to = css.indexOf(end, from);
  expect(to, `missing marker: ${end}`).toBeGreaterThan(from);
  return css.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
}

function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, ' '),
    body,
  }));
}

const chrome = region(
  stylesheet,
  '/* @generated:chrome:start',
  '/* @generated:chrome:end */',
);
const chromeRules = rules(chrome);

/** The selector list the generated token block declares `--cs-*` on. */
const tokenRoots = rules(
  region(stylesheet, '/* @generated:start', '/* @generated:end */'),
)[0].selector
  .split(',')
  .map((s) => s.trim());

describe('chrome & layout CSS', () => {
  test('ships every canonical class the design system names', () => {
    const shipped = new Set(chromeRules.map((r) => r.selector));
    expect(CHROME_SELECTORS.filter((s) => !shipped.has(s))).toEqual([]);
  });

  test('every rule that paints resolves its tokens from a scoped root', () => {
    // `--cs-*` is scoped to the roots in the token block, not to `:root`, so a
    // family whose root is missing from that list would paint with dangling
    // `var()` references — visually unstyled, with nothing else to catch it.
    // Custom-property-only rules are exempt: they are modifiers (`.stack-8`)
    // applied alongside a base class that carries the tokens.
    const unscoped = chromeRules
      .filter(({ body }) => /var\(--cs-/.test(body))
      .filter(({ body }) => body.split(';').some((d) => d.trim() && !d.trim().startsWith('--')))
      .map(({ selector }) => selector)
      .filter((selector) => !tokenRoots.includes(selector.split(/[\s>+~:[]/)[0]));
    expect(unscoped).toEqual([]);
  });
});
