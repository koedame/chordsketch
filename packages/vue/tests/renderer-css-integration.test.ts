import { describe, expect, test } from 'vitest';

import { SHEET_CONTENT_CLASS, scopeCss } from '../src/renderer-css';
import { defaultWasmLoader, loadWasm } from '../src/wasm-loader';

// These run against the REAL `@chordsketch/wasm` build rather than a
// stub. The unit tests around `scopeCss` pin its behaviour on
// hand-written CSS; this file pins the property that actually
// matters — that the rewrite holds for the stylesheet the renderer
// really emits — so a future renderer stylesheet that grows a
// construct the rewriter mishandles fails here instead of leaking
// onto a consumer's page.

interface Renderer {
  default?: unknown;
  render_html_css: () => string;
  render_html_body: (input: string) => string;
}

const SCOPE = `.${SHEET_CONTENT_CLASS}`;

async function renderer(): Promise<Renderer> {
  return loadWasm<Renderer>(defaultWasmLoader);
}

describe('the real @chordsketch/wasm renderer', () => {
  test('loads and initialises through the default loader', async () => {
    // The Node build has no init function while the browser build
    // does; `loadWasm` has to cope with both.
    expect(typeof (await renderer()).render_html_css).toBe('function');
  });

  test('renders a body-only fragment, with no document envelope', async () => {
    const body = (await renderer()).render_html_body('{title: T}\n[C]Hi');

    expect(body.startsWith('<article class="song">')).toBe(true);
    expect(body.toLowerCase()).not.toContain('<!doctype');
    expect(body).not.toContain('<style');
    expect(body).toContain('<span class="chord">C</span>');
  });

  test('every rule of its stylesheet ends up scoped to the sheet wrapper', async () => {
    const scoped = scopeCss((await renderer()).render_html_css(), SCOPE);
    const rules = scoped.split('\n').filter((line) => line.trim().length > 0);

    expect(rules.length).toBeGreaterThan(20);
    for (const rule of rules) {
      // Either a scoped style rule or an at-rule (whose nested rules
      // `scopeCss` scoped recursively).
      expect(rule.startsWith(SCOPE) || rule.startsWith('@')).toBe(true);
    }
    // The renderer's `body` rule is the page frame; it has to land on
    // the wrapper itself, not on a descendant of it.
    expect(scoped).toContain(`${SCOPE} { font-family`);
  });
});
