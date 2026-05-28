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
  highlightCodeBlock,
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

  it('passes through root-relative absolute paths unchanged', () => {
    // Without this guard a root-relative href would fall into
    // `resolveRelative` and be rewritten to a github.com blob URL.
    expect(rewriteHref('/chordsketch/docs/embed-react/', 'docs/sdk')).toBe(
      '/chordsketch/docs/embed-react/',
    );
    expect(rewriteHref('/some/absolute/path', 'docs/sdk/tasks')).toBe(
      '/some/absolute/path',
    );
  });

  it('rewrites `#/<slug>` hash routes to clean URLs when the slug is registered', () => {
    expect(rewriteHref('#/embed-react', 'docs/sdk/reference')).toBe(
      '/chordsketch/docs/embed-react/',
    );
    expect(
      rewriteHref('#/reference/chord-sheet', 'docs/sdk/reference'),
    ).toBe('/chordsketch/docs/reference/chord-sheet/');
  });

  it('leaves an unknown `#/<slug>` route as an in-page anchor', () => {
    // Unrecognised slugs degrade to the literal hash so the browser
    // attempts a native anchor scroll for unknown targets.
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
  it('declares 18 pages across 3 groups', () => {
    const total = DOC_GROUPS.reduce(
      (n: number, g: { pages: readonly unknown[] }) => n + g.pages.length,
      0,
    );
    expect(total).toBe(18);
    expect(DOC_GROUPS.map((g) => g.label)).toEqual([
      'Getting started',
      'Recipes',
      'API reference',
    ]);
  });

  it('every page declares slug, sourcePath, title, and blurb in the expected shape', () => {
    const SLUG_RE = /^(?:|[a-z0-9-]+(?:\/[a-z0-9-]+)*)$/;
    const SOURCE_PATH_RE = /^docs\/sdk\/[A-Za-z0-9/_-]+\.md$/;
    for (const group of DOC_GROUPS) {
      for (const page of group.pages) {
        expect(page.slug, `slug ${JSON.stringify(page.slug)}`).toMatch(SLUG_RE);
        expect(page.sourcePath, page.sourcePath).toMatch(SOURCE_PATH_RE);
        expect(page.title.length).toBeGreaterThan(0);
        expect(page.blurb.length).toBeGreaterThan(0);
      }
    }
  });

  it('every page sourcePath resolves to a file that exists on disk', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    for (const group of DOC_GROUPS) {
      for (const page of group.pages) {
        const path = resolve(__dirname, '../../..', page.sourcePath);
        await expect(readFile(path, 'utf8')).resolves.toBeTypeOf('string');
      }
    }
  });
});

describe('findPage / allPages', () => {
  it('findPage returns undefined for an unknown slug', async () => {
    const { findPage } = await import('../scripts/lib/docs-render.mjs');
    expect(findPage('no-such-page')).toBeUndefined();
  });

  it('findPage returns the matching page for a known slug', async () => {
    const { findPage } = await import('../scripts/lib/docs-render.mjs');
    const page = findPage('embed-react');
    expect(page?.slug).toBe('embed-react');
    expect(page?.title).toBe('Embed in a React app');
  });

  it('allPages returns every entry in DOC_GROUPS in declaration order', async () => {
    const { allPages } = await import('../scripts/lib/docs-render.mjs');
    const slugs = allPages().map((p) => p.slug);
    expect(slugs).toEqual([
      '',
      'embed-react',
      'render',
      'transpose-task',
      'reference',
      'reference/chord-sheet',
      'reference/playground',
      'reference/chord-pro-preview',
      'reference/editors',
      'reference/layout',
      'reference/transpose',
      'reference/chord-diagram',
      'reference/pdf-export',
      'reference/chord-source-edit',
      'reference/ireal-components',
      'reference/ireal-hooks',
      'reference/ireal-helpers',
      'reference/version',
    ]);
  });
});

describe('extractOutline depth filter', () => {
  it('includes h2 + h3 only, excluding h1 / h4 / h5 / h6', async () => {
    const { extractOutline } = await import(
      '../scripts/lib/docs-render.mjs'
    );
    const source =
      '# Title\n\n## Section\n\n### Detail\n\n#### Skip me\n\n##### Skip me\n\n###### Skip me';
    const outline = extractOutline(source);
    expect(outline.map((e) => `${e.level}:${e.text}`)).toEqual([
      '2:Section',
      '3:Detail',
    ]);
  });
});

describe('slugifyWithCounter fallback', () => {
  it('falls back to "heading" for non-ASCII-only text', () => {
    const counters = new Map<string, number>();
    expect(slugifyWithCounter('日本語', counters)).toBe('heading');
    expect(slugifyWithCounter('中文', counters)).toBe('heading-1');
  });
});

describe('renderMarkdown — query-string rewrite', () => {
  it('strips ?query from a relative .md href before slug lookup', async () => {
    const { renderMarkdown } = await import('../scripts/lib/docs-render.mjs');
    const html = renderMarkdown(
      '[link](render.md?v=1)',
      'docs/sdk/tasks/transpose.md',
    );
    // Resolved against docs/sdk/tasks → docs/sdk/tasks/render.md →
    // the `render` slug → /chordsketch/docs/render/. The query is
    // dropped because static URLs have no query semantics here.
    expect(html).toContain('href="/chordsketch/docs/render/"');
    expect(html).not.toContain('?v=1');
  });
});

describe('renderMarkdown — relative-link sourcePath gating', () => {
  it('passes through relative .md hrefs verbatim when sourcePath is missing', async () => {
    const { renderMarkdown } = await import('../scripts/lib/docs-render.mjs');
    // No `sourcePath` argument: the link renderer treats the href as
    // an opaque relative path with no resolution context, so it falls
    // through to the github.com fallback. Locks the behaviour the
    // SSG depends on (it always passes sourcePath) so a future refactor
    // doesn't silently relax the contract.
    const html = renderMarkdown('[doc](./other.md)');
    expect(html).toContain(
      'https://github.com/koedame/chordsketch/blob/main/other.md',
    );
  });
});

describe('resolveRelative escape detection', () => {
  it('throws when a `..` escape would climb above the repo root', async () => {
    const { rewriteHref } = await import('../scripts/lib/docs-render.mjs');
    expect(() => rewriteHref('../../../../etc/passwd', 'docs/sdk')).toThrow(
      /climbs above the repo root/i,
    );
  });
});

describe('isSafeHref — adversarial parity with the Rust suite', () => {
  // Mirrors the corpus in `crates/render-html/src/lib.rs`'s
  // sanitiser tests. Each entry MUST be rejected. Sister-site
  // parity per `.claude/rules/sanitizer-security.md` §"Testing
  // completeness" and `.claude/rules/fix-propagation.md`.
  const blocked: { label: string; href: string }[] = [
    // Uppercase / mixed-case scheme prefixes.
    { label: 'uppercase JAVASCRIPT:', href: 'JAVASCRIPT:alert(1)' },
    { label: 'mixed-case JavaScript:', href: 'JavaScript:alert(1)' },
    { label: 'uppercase VBSCRIPT:', href: 'VBSCRIPT:foo' },
    { label: 'uppercase DATA:', href: 'DATA:text/html,foo' },
    { label: 'uppercase FILE:', href: 'FILE:///etc/passwd' },
    { label: 'uppercase BLOB:', href: 'BLOB:https://example.com/abc' },
    { label: 'uppercase MHTML:', href: 'MHTML:!foo' },
    // Leading-whitespace variants — `trim_start` strips ASCII +
    // Unicode whitespace so `javascript:` ends up at index 0.
    { label: 'leading ASCII spaces', href: '  javascript:alert(1)' },
    { label: 'leading tab', href: '\tjavascript:alert(1)' },
    { label: 'leading newline', href: '\njavascript:alert(1)' },
    { label: 'leading NBSP (U+00A0)', href: '\u00a0javascript:alert(1)' },
    { label: 'leading ideographic space (U+3000)', href: '\u3000javascript:alert(1)' },
    { label: 'leading NEL (U+0085)', href: '\u0085javascript:alert(1)' },
    // ASCII control / whitespace / invisible-format characters in
    // the middle of the scheme — filtered by the body's predicate
    // before the prefix check.
    { label: 'NUL split', href: 'java\u0000script:alert(1)' },
    { label: 'tab split', href: 'java\tscript:alert(1)' },
    { label: 'newline split', href: 'java\nscript:alert(1)' },
    { label: 'CR split', href: 'java\rscript:alert(1)' },
    { label: 'space split', href: 'java\u0020script:alert(1)' },
    { label: 'ZWSP split', href: 'java\u200bscript:alert(1)' },
    { label: 'soft-hyphen split', href: 'java\u00adscript:alert(1)' },
    { label: 'RTL-override split', href: 'java\u202escript:alert(1)' },
    { label: 'BOM split', href: 'java\ufeffscript:alert(1)' },
    // The 30-char filter cap MUST apply to filtered characters, not
    // raw input — 50 invisible-format chars must not push
    // `javascript:` past the cap.
    {
      label: '50x ZWSP padding then javascript:',
      href: `${'\u200b'.repeat(50)}javascript:alert(1)`,
    },
  ];
  for (const { label, href } of blocked) {
    it(`rejects ${label}`, () => {
      expect(isSafeHref(href)).toBe(false);
    });
  }
});

describe('highlightCodeBlock', () => {
  it('emits a shiki-wrapped pre + per-token coloured spans for a known language', () => {
    const html = highlightCodeBlock(
      "import { ChordSheet } from '@chordsketch/react';",
      'tsx',
    );
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    // Per-token colour spans are the load-bearing visual signal of
    // highlighting; without them the block degrades to plain text.
    expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{3,8}">import<\/span>/);
    expect(html).toContain('ChordSheet');
    // Wrapper-level inline `style` / `tabindex` are stripped so the
    // existing `.docs-prose pre` rule keeps controlling padding /
    // background / border-radius.
    expect(html).not.toMatch(/<pre[^>]*\sstyle=/);
    expect(html).not.toMatch(/<pre[^>]*\stabindex=/);
  });

  it('highlights ChordPro using the in-repo TextMate grammar', () => {
    // `syntaxes/chordpro.tmLanguage.json` scopes `{title` as a
    // `keyword.control.directive.chordpro` and the value as a
    // string. Both segments MUST land in distinct coloured spans —
    // otherwise the grammar load silently fell back to plain text.
    const html = highlightCodeBlock('{title: Demo}', 'chordpro');
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{3,8}">title<\/span>/);
    expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{3,8}">Demo<\/span>/);
  });

  it('falls back to plain escaped <pre><code> for an unknown language', () => {
    expect(highlightCodeBlock('a < b && c', 'klingon')).toBe(
      '<pre><code>a &lt; b &amp;&amp; c</code></pre>',
    );
  });

  it('falls back to plain escaped <pre><code> when no language is set', () => {
    expect(highlightCodeBlock('plain', '')).toBe('<pre><code>plain</code></pre>');
  });

  it('resolves the `ts` alias to typescript', () => {
    const html = highlightCodeBlock("const x: number = 1;", 'ts');
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{3,8}">const<\/span>/);
  });
});

describe('renderMarkdown code-fence integration', () => {
  it('runs Shiki on a fenced TSX block and survives DOMPurify with per-span colours intact', () => {
    // DOMPurify's HTML profile strips `style` by default. The
    // colour-span output is the integration evidence that the
    // PURIFY_CONFIG allowance + the SHIKI_STYLE_TAGS guard hook are
    // both wired in; without either, the spans would survive but
    // their `style` would not.
    const html = renderMarkdown(
      "```tsx\nimport { x } from 'y';\n```\n",
      'docs/sdk/tasks/embed-react.md',
    );
    expect(html).toMatch(/<pre class="shiki[^"]*"><code>/);
    expect(html).toMatch(
      /<span style="color:#[0-9A-Fa-f]{3,8}">import<\/span>/,
    );
  });

  it('strips a stray <div style="..."> in inline HTML even though Shiki spans keep theirs', () => {
    // The PURIFY_CONFIG allowlist widening for Shiki MUST NOT
    // become a general `style=` allowance on every tag — the
    // post-sanitize hook narrows the survivors to PRE / CODE / SPAN.
    const html = renderMarkdown(
      '<div style="background:red">payload</div>\n',
      'docs/sdk/README.md',
    );
    expect(html).not.toContain('style="background:red"');
  });
});
