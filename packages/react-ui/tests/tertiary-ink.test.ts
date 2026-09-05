import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/**
 * Selectors allowed to paint with the tertiary tone
 * (`--cs-text-tertiary` / its `--cs-ink-500` source), per ADR-0054: the
 * token is a non-text / large-text / disabled tone, so it clears the 3:1
 * floor WCAG 1.4.11 sets for non-text UI but not the 4.5:1 that 1.4.3
 * asks of text below 18.66px bold / 24px regular.
 *
 * The first two are disabled controls, which 1.4.3 exempts outright. The
 * third is the breadcrumb `/` separator — decorative punctuation between
 * links, named in ADR-0054 alongside the disabled controls as one of the
 * uses WCAG does not hold to 4.5:1; the crumb text itself is
 * `--cs-text-secondary`.
 *
 * Anything that paints active copy uses `--cs-text-secondary` instead —
 * `.song-card time`, `.setlist .stat .label`, `.setlist time` and
 * `.input::placeholder` moved there after being measured at 3.53:1.
 *
 * The scan covers the generated chrome region too (ADR-0060): rules
 * projected out of `design-system/` are shipped by this package and are
 * held to the same bar as the hand-authored ones.
 */
const TERTIARY_ALLOWED = [
  '.input:disabled, .textarea:disabled',
  '.select:disabled',
  '.topnav .crumbs .sep',
];

const stylesheet = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/styles.css',
);

function selectorsPaintingTertiary(css: string): string[] {
  const found: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?<![-\w])color:\s*var\(--cs-(?:text-tertiary|ink-500)\b/.test(body)) continue;
    found.push(selector.trim().replace(/\s+/g, ' '));
  }
  return found;
}

describe('tertiary ink', () => {
  test('only the documented disabled selectors paint with it', () => {
    // The generated token block declares the token itself; drop it so
    // only hand-authored component rules are considered.
    const [, componentRules = ''] = readFileSync(stylesheet, 'utf8').split(
      '/* @generated:end */',
    );
    const css = componentRules.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(selectorsPaintingTertiary(css).sort()).toEqual([...TERTIARY_ALLOWED].sort());
  });
});
