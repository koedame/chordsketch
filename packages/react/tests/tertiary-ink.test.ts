import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { readStylesheetSource } from './stylesheet-source';

/**
 * Selectors allowed to paint with the tertiary tone (`--cs-text-tertiary`
 * / its `--cs-ink-500` source), per ADR-0054: the token is a non-text /
 * large-text / disabled tone, so it clears the 3:1 WCAG 1.4.11 floor its
 * uses are held to but not the 4.5:1 that 1.4.3 asks of small text.
 *
 * Every entry is one of the three exempt classes:
 *
 * - separator glyphs — decorative, `aria-hidden`, not read as copy
 * - icon strokes — non-text UI (1.4.11, 3:1)
 * - disabled controls — 1.4.3 exempts inactive components outright
 *
 * Adding a selector here means claiming it is not small text. Anything
 * that paints copy below 18.66px bold / 24px regular uses
 * `--cs-text-secondary` instead.
 */
const TERTIARY_ALLOWED = [
  '.chordsketch-sheet__content .role-icon',
  '.chordsketch-sheet__content .grid-chord__sep',
  '.chordsketch-sheet__cins-chip:disabled',
  '.chordsketch-ireal-bar-grid__seg button:disabled',
];

function selectorsPaintingTertiary(css: string): string[] {
  const found: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?<![-\w])color:\s*var\(--cs-(?:text-tertiary|ink-500)\b/.test(body)) continue;
    found.push(selector.trim().replace(/\s+/g, ' '));
  }
  return found;
}

/**
 * The CodeMirror source editor paints its syntax tones from a
 * `HighlightStyle` / `EditorView.theme` in TypeScript, not from
 * `styles.css`, so the stylesheet walk above cannot see them. Its
 * `punctuation` and `comment` tags carried the tertiary tone at 14px
 * until they moved to `--cs-text-secondary`; nothing else in this
 * package guards that, because axe does not colour-check inside a
 * `contenteditable`.
 */
const editorSourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/chord-source-area.tsx',
);

describe('tertiary ink', () => {
  test('the CodeMirror editor paints no text with it', () => {
    const source = readFileSync(editorSourcePath, 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      '',
    );
    expect(source).not.toMatch(/color:\s*'var\(--cs-(?:text-tertiary|ink-500)\b/);
  });

  test('only the documented non-text / disabled selectors paint with it', () => {
    // The generated token block declares the token itself; drop it so
    // only hand-authored component rules are considered.
    const [, componentRules = ''] = readStylesheetSource({
      stripComments: false,
    }).split('/* @generated:end */');
    const css = componentRules.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(selectorsPaintingTertiary(css).sort()).toEqual([...TERTIARY_ALLOWED].sort());
  });
});
