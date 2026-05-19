// Unit coverage for the docs SSG render pipeline.
//
// `scripts/lib/docs-render.mjs` is the single source of truth for
// the docs markdown → HTML transform. The end-to-end Playwright
// suite in `tests-e2e/docs-links.spec.ts` exercises the deployed
// output; this suite probes the pipeline directly for adversarial
// URIs and rewriter rules per
// `.claude/rules/sanitizer-security.md` §"Testing completeness".

import { describe, expect, it } from 'vitest';

import {
  DOC_GROUPS,
  cleanUrlFor,
  extractOutline,
  isExternalHttpHref,
  isSafeHref,
  renderMarkdown,
  rewriteHref,
  slugify,
  slugifyWithCounter,
} from '../scripts/lib/docs-render.mjs';

describe('isSafeHref / isExternalHttpHref', () => {
  it('blocks the canonical dangerous URI schemes', () => {
    for (const scheme of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'vbscript:foo',
      'data:text/html,foo',
      'file:///etc/passwd',
      'blob:https://example.com/abc',
      'mhtml:!foo',
    ]) {
      expect(isSafeHref(scheme), scheme).toBe(false);
    }
  });

  it('allows ordinary http(s), mailto, relative, and fragment hrefs', () => {
    for (const href of [
      'https://example.com',
      'http://example.com',
      'mailto:a@b.c',
      '/chordsketch/docs/embed-react/',
      './sibling/',
      '#some-heading',
      '',
    ]) {
      expect(isSafeHref(href), href).toBe(true);
    }
  });

  it('tolerates invisible / whitespace chars inside a dangerous scheme', () => {
    expect(isSafeHref('java​script:alert(1)')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JA­vascript:alert(1)')).toBe(false);
  });

  it('isExternalHttpHref reports the absolute http(s) prefix', () => {
    expect(isExternalHttpHref('https://example.com/')).toBe(true);
    expect(isExternalHttpHref('http://example.com/')).toBe(true);
    expect(isExternalHttpHref('./relative')).toBe(false);
    expect(isExternalHttpHref('mailto:a@b.c')).toBe(false);
  });
});

describe('renderMarkdown — sanitisation', () => {
  it('strips javascript: hrefs and src values', () => {
    const html = renderMarkdown(
      '[click](javascript:alert(1))\n\n![pwn](javascript:alert(2))',
    );
    expect(html).not.toContain('javascript:');
  });

  it('strips raw <script> blocks injected in the source', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
  });

  it('upgrades external links to target=_blank rel=noreferrer noopener', () => {
    const html = renderMarkdown('[example](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noreferrer noopener"/);
  });

  it('strips author-supplied target attributes on internal links', () => {
    const html = renderMarkdown('<a href="./internal" target="_self">click</a>');
    expect(html).not.toContain('target=');
  });

  it('disambiguates duplicate headings with -1 / -2 suffixes', () => {
    const html = renderMarkdown('## Intro\n## Intro\n## Intro');
    expect(html).toContain('<h2 id="intro">');
    expect(html).toContain('<h2 id="intro-1">');
    expect(html).toContain('<h2 id="intro-2">');
  });

  it('does not leak heading counters between renders', () => {
    renderMarkdown('## Intro');
    const second = renderMarkdown('## Intro');
    expect(second).toContain('<h2 id="intro">');
    expect(second).not.toContain('intro-1');
  });
});

describe('slug parity with extractOutline', () => {
  it('produces matching slugs for duplicated headings', () => {
    const source = '## Intro\n\nfoo\n\n## Intro\n\nbar\n\n## Intro\n\nbaz';
    const html = renderMarkdown(source);
    const outline = extractOutline(source);
    expect(outline.map((e) => e.id)).toEqual(['intro', 'intro-1', 'intro-2']);
    for (const entry of outline) {
      expect(html).toContain(`id="${entry.id}"`);
    }
  });

  it('ignores headings inside fenced code blocks', () => {
    const source = [
      '## Real heading',
      '',
      '```',
      '## Code block heading',
      '```',
      '',
      '## Another real heading',
    ].join('\n');
    const outline = extractOutline(source);
    expect(outline.map((e) => e.text)).toEqual([
      'Real heading',
      'Another real heading',
    ]);
  });
});

describe('slugify primitives', () => {
  it('lowercases, strips non-alphanumeric, and collapses whitespace', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
    expect(slugify('A & B / C')).toBe('a-b-c');
  });

  it('slugifyWithCounter advances on repeat slugs', () => {
    const counters = new Map<string, number>();
    expect(slugifyWithCounter('intro', counters)).toBe('intro');
    expect(slugifyWithCounter('intro', counters)).toBe('intro-1');
    expect(slugifyWithCounter('intro', counters)).toBe('intro-2');
  });
});

describe('rewriteHref', () => {
  it('passes through absolute http(s) URLs', () => {
    expect(rewriteHref('https://example.com/x', 'docs/sdk')).toBe(
      'https://example.com/x',
    );
  });

  it('passes through mailto + protocol-relative URLs', () => {
    expect(rewriteHref('mailto:a@b.c', 'docs/sdk')).toBe('mailto:a@b.c');
    expect(rewriteHref('//cdn.example.com/x', 'docs/sdk')).toBe(
      '//cdn.example.com/x',
    );
  });

  it('passes through fragment-only in-page anchors untouched', () => {
    expect(rewriteHref('#some-heading', 'docs/sdk/tasks')).toBe('#some-heading');
  });

  it('rewrites SPA-era `#/<slug>` hash routes to clean URLs', () => {
    expect(rewriteHref('#/embed-react', 'docs/sdk/reference')).toBe(
      '/chordsketch/docs/embed-react/',
    );
    expect(
      rewriteHref('#/reference/chord-sheet', 'docs/sdk/reference'),
    ).toBe('/chordsketch/docs/reference/chord-sheet/');
  });

  it('leaves an unknown `#/<slug>` route as an in-page anchor', () => {
    // Unrecognised slugs degrade to the literal hash so the browser
    // attempts a native anchor scroll — preserves the SPA fallback
    // semantic for non-registered targets.
    expect(rewriteHref('#/no-such-page', 'docs/sdk')).toBe('#/no-such-page');
  });

  it('rewrites docs/sdk relative paths to clean URLs', () => {
    expect(rewriteHref('tasks/render.md', 'docs/sdk')).toBe(
      '/chordsketch/docs/render/',
    );
    expect(rewriteHref('render.md', 'docs/sdk/tasks')).toBe(
      '/chordsketch/docs/render/',
    );
    expect(rewriteHref('reference/chord-sheet.md', 'docs/sdk')).toBe(
      '/chordsketch/docs/reference/chord-sheet/',
    );
  });

  it('rewrites docs/sdk/README.md to the docs index URL', () => {
    expect(rewriteHref('../README.md', 'docs/sdk/tasks')).toBe(
      '/chordsketch/docs/',
    );
  });

  it('routes non-docs repo paths to github.com blob URLs', () => {
    expect(rewriteHref('../../packages/npm/README.md', 'docs/sdk')).toBe(
      'https://github.com/koedame/chordsketch/blob/main/packages/npm/README.md',
    );
    expect(
      rewriteHref('../adr/0021-docs-site-co-located-with-playground.md', 'docs/sdk'),
    ).toBe(
      'https://github.com/koedame/chordsketch/blob/main/docs/adr/0021-docs-site-co-located-with-playground.md',
    );
  });

  it('preserves a #anchor suffix on github.com rewrites', () => {
    expect(rewriteHref('../../README.md#installation', 'docs/sdk')).toBe(
      'https://github.com/koedame/chordsketch/blob/main/README.md#installation',
    );
  });
});

describe('cleanUrlFor', () => {
  it('returns the docs-base URL for the empty slug', () => {
    expect(cleanUrlFor('')).toBe('/chordsketch/docs/');
  });
  it('appends a slash to non-empty slugs', () => {
    expect(cleanUrlFor('embed-react')).toBe('/chordsketch/docs/embed-react/');
    expect(cleanUrlFor('reference/chord-sheet')).toBe(
      '/chordsketch/docs/reference/chord-sheet/',
    );
  });
});

describe('DOC_GROUPS registry', () => {
  it('declares 17 pages across 3 groups', () => {
    const total = DOC_GROUPS.reduce((n, g) => n + g.pages.length, 0);
    expect(total).toBe(17);
    expect(DOC_GROUPS.map((g) => g.label)).toEqual([
      'Getting started',
      'Recipes',
      'API reference',
    ]);
  });

  it('every page declares slug + title + sourcePath + blurb', () => {
    for (const group of DOC_GROUPS) {
      for (const page of group.pages) {
        expect(typeof page.slug).toBe('string');
        expect(page.title.length).toBeGreaterThan(0);
        expect(page.sourcePath.startsWith('docs/sdk/')).toBe(true);
        expect(page.blurb.length).toBeGreaterThan(0);
      }
    }
  });
});
