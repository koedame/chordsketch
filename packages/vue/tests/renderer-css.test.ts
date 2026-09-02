import { beforeEach, describe, expect, test } from 'vitest';

import {
  __resetInjectedCss,
  ensureRendererCss,
  injectCss,
  scopeCss,
} from '../src/renderer-css';
import { makeRenderLoader, makeRenderStub } from './stubs';

describe('scopeCss', () => {
  test('prefixes plain selectors with the scope', () => {
    expect(scopeCss('.chord { color: red }', '.sheet')).toBe('.sheet .chord { color: red }');
  });

  test('collapses document-root selectors onto the scope element itself', () => {
    // `body`'s rules must land on the wrapper, not on a descendant —
    // otherwise the renderer's page frame (max-width, margins) would
    // never apply, and worse, an unscoped copy would repaint the host.
    expect(scopeCss('body { margin: 2em auto }', '.sheet')).toBe('.sheet { margin: 2em auto }');
    expect(scopeCss('html { color: #000 }', '.sheet')).toBe('.sheet { color: #000 }');
    expect(scopeCss(':root { --x: 1 }', '.sheet')).toBe('.sheet { --x: 1 }');
  });

  test('scopes every selector of a comma-separated list', () => {
    expect(scopeCss('h1, .meta { margin: 0 }', '.sheet')).toBe(
      '.sheet h1, .sheet .meta { margin: 0 }',
    );
  });

  test('recurses into @media but leaves @keyframes untouched', () => {
    const css =
      '@media (max-width: 30em) { .line { display: block } }' +
      '@keyframes spin { from { opacity: 1 } to { opacity: 0 } }';
    const out = scopeCss(css, '.sheet');
    expect(out).toContain('.sheet .line');
    // A scoped keyframe selector would be invalid CSS and silently
    // kill the animation.
    expect(out).toContain('@keyframes spin { from { opacity: 1 } to { opacity: 0 } }');
    expect(out).not.toContain('.sheet from');
  });

  test('a brace inside a declaration string does not split the rule', () => {
    const out = scopeCss('.a { content: "}" } .b { color: red }', '.sheet');
    expect(out).toContain('.sheet .a');
    expect(out).toContain('.sheet .b');
  });

  test('a comment between rules does not leak into a selector', () => {
    const out = scopeCss('/* header */ h1 { margin: 0 }', '.sheet');
    expect(out).toContain('.sheet h1 {');
    expect(out).not.toContain('/* header */ h1 {');
  });
});

describe('injectCss', () => {
  beforeEach(() => {
    __resetInjectedCss();
    document.head.querySelectorAll('style[data-chordsketch-vue]').forEach((el) => el.remove());
  });

  test('appends the stylesheet once, however many times it is requested', () => {
    injectCss('.a { color: red }');
    injectCss('.a { color: red }');
    const styles = document.head.querySelectorAll('style[data-chordsketch-vue]');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe('.a { color: red }');
  });

  test('a different stylesheet gets its own element', () => {
    injectCss('.a { color: red }');
    injectCss('.a { color: blue }');
    expect(document.head.querySelectorAll('style[data-chordsketch-vue]')).toHaveLength(2);
  });
});

describe('ensureRendererCss', () => {
  beforeEach(() => {
    __resetInjectedCss();
    document.head.querySelectorAll('style[data-chordsketch-vue]').forEach((el) => el.remove());
  });

  test('injects the renderer stylesheet scoped to the sheet wrapper', async () => {
    const stub = makeRenderStub();
    await ensureRendererCss({}, makeRenderLoader(stub));
    const style = document.head.querySelector('style[data-chordsketch-vue]');
    expect(style?.textContent).toContain('.chordsketch-sheet__content .chord');
    expect(style?.textContent).not.toMatch(/(^|\n)body\s*{/);
  });

  test('uses the options-aware export when a config is supplied', async () => {
    const stub = makeRenderStub();
    await ensureRendererCss({ config: 'guitar' }, makeRenderLoader(stub));
    expect(stub.render_html_css_with_options).toHaveBeenCalledWith({ config: 'guitar' });
    expect(stub.render_html_css).not.toHaveBeenCalled();
  });

  test('injects nothing when the bundle exposes no stylesheet export', async () => {
    const stub = makeRenderStub();
    delete (stub as Partial<typeof stub>).render_html_css;
    delete (stub as Partial<typeof stub>).render_html_css_with_options;
    await ensureRendererCss({}, makeRenderLoader(stub));
    expect(document.head.querySelector('style[data-chordsketch-vue]')).toBeNull();
  });

  test('a failing load is swallowed — the render error is surfaced elsewhere', async () => {
    const loader = makeRenderLoader({});
    const failing = (async () => {
      throw new Error('boom');
    }) as unknown as typeof loader;
    await expect(ensureRendererCss({}, failing)).resolves.toBeUndefined();
    expect(document.head.querySelector('style[data-chordsketch-vue]')).toBeNull();
  });
});
