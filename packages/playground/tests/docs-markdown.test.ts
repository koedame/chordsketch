// Adversarial-input coverage for the docs-site Markdown sanitiser.
//
// `.claude/rules/sanitizer-security.md` §"Testing completeness"
// makes adversarial tests a hard requirement when any entry lands
// in a URI scheme allowlist or tag blocklist. Playwright cannot
// reach the URI hook because the canonical docs Markdown under
// `docs/sdk/` has no malicious URIs in it — these tests probe the
// hook directly.

import { describe, expect, it } from 'vitest';

import {
  DOCS_SDK_PATH_TO_SLUG,
  extractOutline,
  isExternalHttpHref,
  isSafeHref,
  renderMarkdown,
  rewriteHref,
  slugify,
  slugifyWithCounter,
} from '../src/docs/markdown';

describe('isSafeHref', () => {
  it('keeps http and https links', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
  });

  it('keeps relative paths and fragments', () => {
    expect(isSafeHref('./foo.md')).toBe(true);
    expect(isSafeHref('../sibling.md')).toBe(true);
    expect(isSafeHref('#section')).toBe(true);
    expect(isSafeHref('/absolute')).toBe(true);
    expect(isSafeHref('plain-relative.md')).toBe(true);
    expect(isSafeHref('?q=1')).toBe(true);
    expect(isSafeHref('')).toBe(true);
    expect(isSafeHref(null)).toBe(true);
  });

  it('keeps mailto: links', () => {
    expect(isSafeHref('mailto:foo@example.com')).toBe(true);
  });

  it('rejects dangerous schemes (case-insensitive)', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
    expect(isSafeHref('blob:https://x.example/abc')).toBe(false);
    expect(isSafeHref('mhtml:https://x.example')).toBe(false);
  });

  it('rejects schemes hidden behind leading whitespace', () => {
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
    expect(isSafeHref('\t javascript:alert(1)')).toBe(false);
    expect(isSafeHref(' javascript:alert(1)')).toBe(false); // NBSP
    expect(isSafeHref(' javascript:alert(1)')).toBe(false); // em space
  });

  it('rejects schemes hidden behind invisible / format codepoints', () => {
    // Sister-site parity with chordpro-jsx.tsx + render-html — every
    // codepoint these strip must round-trip the same answer here.
    expect(isSafeHref('java​script:alert(1)')).toBe(false); // zero-width space
    expect(isSafeHref('java‌script:alert(1)')).toBe(false); // ZWNJ
    expect(isSafeHref('java‍script:alert(1)')).toBe(false); // ZWJ
    expect(isSafeHref('java‎script:alert(1)')).toBe(false); // LRM
    expect(isSafeHref('java‏script:alert(1)')).toBe(false); // RLM
    expect(isSafeHref('java﻿script:alert(1)')).toBe(false); // BOM
    expect(isSafeHref('java‮script:alert(1)')).toBe(false); // bidi override
    expect(isSafeHref('java­script:alert(1)')).toBe(false); // soft hyphen
  });

  it('rejects schemes hidden behind embedded ASCII whitespace / control', () => {
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\x00script:alert(1)')).toBe(false);
  });
});

describe('isExternalHttpHref', () => {
  it('detects http and https external links', () => {
    expect(isExternalHttpHref('http://example.com')).toBe(true);
    expect(isExternalHttpHref('https://example.com')).toBe(true);
    // Leading whitespace must not bypass the check — this is the
    // regression class the original `startsWith('http://')` check
    // missed.
    expect(isExternalHttpHref('  https://example.com')).toBe(true);
    expect(isExternalHttpHref(' https://example.com')).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(isExternalHttpHref('mailto:foo@example.com')).toBe(false);
    expect(isExternalHttpHref('./relative')).toBe(false);
    expect(isExternalHttpHref('#fragment')).toBe(false);
  });
});

describe('renderMarkdown', () => {
  it('produces sanitised HTML with stable heading ids', () => {
    const html = renderMarkdown('# Hello\n\nWorld');
    expect(html).toContain('<h1 id="hello">Hello</h1>');
    expect(html).toContain('<p>World</p>');
  });

  it('drops anchors whose href carries a dangerous scheme', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    // The anchor tag stays but href is stripped by the hook.
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/href="javascript:/);
  });

  it('drops images whose src carries a dangerous scheme', () => {
    const html = renderMarkdown(
      '![x](data:text/html,<script>alert(1)</script>)',
    );
    expect(html).not.toContain('data:');
    expect(html).not.toMatch(/src="data:/);
  });

  it('upgrades external links to target=_blank rel=noreferrer noopener', () => {
    const html = renderMarkdown('[example](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noreferrer noopener"/);
  });

  it('rewrites relative links so they resolve under the docs SPA deploy', () => {
    // A relative `.md` path works on GitHub's repo viewer but 404s
    // under the docs SPA's hash-routed deploy. The renderer rewrites
    // it to either a `#/<slug>` hash route (when the resolved file
    // is a registered docs/sdk page) or a `github.com` blob URL.
    // `./other.md` from no source dir resolves to repo-root
    // `other.md`, which is not a docs/sdk page, so the blob URL
    // branch fires. No `target=` because the rewriter does not
    // touch internal hashes; the sanitiser hook re-applies
    // `target=_blank` only because the rewritten href is now
    // an absolute https URL — that is the intended behaviour for
    // a link leaving the SPA.
    const html = renderMarkdown('[doc](./other.md)');
    expect(html).toContain(
      'href="https://github.com/koedame/chordsketch/blob/main/other.md"',
    );
    expect(html).toContain('target="_blank"');
  });

  it('strips author-supplied target attributes on internal links', () => {
    // Raw HTML in Markdown lets the author try to ship their own
    // `target` — the hook must drop it before re-applying only
    // for validated external HTTP hrefs.
    const html = renderMarkdown(
      '<a href="./internal" target="_self">click</a>',
    );
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

  it('escapes ampersands and quotes inside heading ids', () => {
    // A heading like `## A & B "C"` slugifies to `a-b-c`. The id
    // attribute is escaped defensively even when slugify drops
    // the chars — guards against a future slugify rule that
    // permits richer characters.
    const html = renderMarkdown('## A & B');
    expect(html).toContain('<h2 id="a-b">');
  });
});

describe('rewriteHref', () => {
  it('passes through absolute http(s) URLs', () => {
    expect(rewriteHref('https://example.com/x', 'docs/sdk')).toBe(
      'https://example.com/x',
    );
    expect(rewriteHref('http://example.com', 'docs/sdk')).toBe(
      'http://example.com',
    );
  });

  it('passes through `mailto:` and protocol-relative URLs', () => {
    expect(rewriteHref('mailto:a@b.c', 'docs/sdk')).toBe('mailto:a@b.c');
    expect(rewriteHref('//cdn.example.com/x', 'docs/sdk')).toBe(
      '//cdn.example.com/x',
    );
  });

  it('passes through root-relative absolute paths unchanged', () => {
    // A path like `/chordsketch/docs/#/reference` is an absolute path
    // from the origin root, not a relative `.md` link. The rewriter
    // must not resolve it against `sourceDir` (which would produce a
    // wrong GitHub blob URL). Both the single-slash path and one that
    // coincidentally starts with a docs-known filename are covered.
    expect(rewriteHref('/chordsketch/docs/#/reference', 'docs/sdk')).toBe(
      '/chordsketch/docs/#/reference',
    );
    expect(rewriteHref('/absolute', 'docs/sdk/tasks')).toBe('/absolute');
  });

  it('passes through fragment-only hrefs untouched', () => {
    expect(rewriteHref('#some-heading', 'docs/sdk/tasks')).toBe('#some-heading');
    expect(rewriteHref('#/reference', 'docs/sdk/tasks')).toBe('#/reference');
  });

  it('maps a relative .md path to the matching SPA hash route', () => {
    // From docs/sdk/README.md the README's `tasks/render.md` link
    // resolves to docs/sdk/tasks/render.md → slug `render`.
    expect(rewriteHref('tasks/render.md', 'docs/sdk')).toBe('#/render');
    expect(rewriteHref('tasks/embed-react.md', 'docs/sdk')).toBe(
      '#/embed-react',
    );
  });

  it('maps a sibling .md from within docs/sdk/tasks to the matching slug', () => {
    expect(rewriteHref('render.md', 'docs/sdk/tasks')).toBe('#/render');
    expect(rewriteHref('transpose.md', 'docs/sdk/tasks')).toBe(
      '#/transpose-task',
    );
  });

  it('maps the docs/sdk/README.md path to the SPA index hash', () => {
    expect(rewriteHref('../README.md', 'docs/sdk/tasks')).toBe('#/');
  });

  it('rewrites repo paths outside docs/sdk to a github.com blob URL', () => {
    expect(
      rewriteHref('../../packages/npm/README.md', 'docs/sdk'),
    ).toBe('https://github.com/koedame/chordsketch/blob/main/packages/npm/README.md');
    expect(
      rewriteHref('../adr/0021-docs-site-co-located-with-playground.md', 'docs/sdk'),
    ).toBe(
      'https://github.com/koedame/chordsketch/blob/main/docs/adr/0021-docs-site-co-located-with-playground.md',
    );
  });

  it('preserves a #anchor suffix when rewriting to github.com', () => {
    expect(
      rewriteHref('../../README.md#installation', 'docs/sdk'),
    ).toBe(
      'https://github.com/koedame/chordsketch/blob/main/README.md#installation',
    );
  });
});

describe('slug parity between renderMarkdown and extractOutline', () => {
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
      '## Not a heading',
      '```',
      '',
      '## Second real',
    ].join('\n');
    const outline = extractOutline(source);
    expect(outline.map((e) => e.text)).toEqual(['Real heading', 'Second real']);
  });

  it('keeps slug counters in sync across heading depths', () => {
    // An h1 + an h2 sharing the same slugified text must agree
    // between the rendered HTML (which counts across all depths)
    // and the outline (which surfaces h2/h3 only). Pre-fix, the
    // outline counted only h2/h3, so the h2's outline id was
    // "intro" while its rendered id was "intro-1" — a broken
    // anchor.
    const source = '# Intro\n\n## Intro\n\n### Intro';
    const html = renderMarkdown(source);
    const outline = extractOutline(source);
    expect(html).toContain('<h1 id="intro">');
    expect(html).toContain('<h2 id="intro-1">');
    expect(html).toContain('<h3 id="intro-2">');
    expect(outline.map((e) => e.id)).toEqual(['intro-1', 'intro-2']);
    expect(outline.map((e) => e.level)).toEqual([2, 3]);
  });
});

describe('slugify', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('  Lots   of   space  ')).toBe('lots-of-space');
  });

  it('drops punctuation', () => {
    expect(slugify('foo, bar! baz?')).toBe('foo-bar-baz');
    expect(slugify('<Playground>')).toBe('playground');
  });

  it('keeps digits', () => {
    expect(slugify('Recipe 10')).toBe('recipe-10');
  });
});

describe('slugifyWithCounter', () => {
  it('suffixes duplicates with -1 / -2 …', () => {
    const counters = new Map<string, number>();
    expect(slugifyWithCounter('Intro', counters)).toBe('intro');
    expect(slugifyWithCounter('Intro', counters)).toBe('intro-1');
    expect(slugifyWithCounter('Intro', counters)).toBe('intro-2');
    expect(slugifyWithCounter('Outro', counters)).toBe('outro');
  });
});

describe('DOCS_SDK_PATH_TO_SLUG', () => {
  // This test must stay in lockstep with DOC_GROUPS in pages.ts AND
  // with DOCS_SDK_PATH_TO_SLUG in markdown.ts. When a new page is
  // added to DOC_GROUPS, adding its sourcePath → slug entry to
  // DOCS_SDK_PATH_TO_SLUG but forgetting to update this test (or
  // vice-versa) produces a failing assertion that stops the drift
  // before it reaches the deployed docs site.
  it('contains exactly the source paths registered in DOC_GROUPS', () => {
    const expected: Record<string, string> = {
      'docs/sdk/README.md': '',
      'docs/sdk/tasks/embed-react.md': 'embed-react',
      'docs/sdk/tasks/render.md': 'render',
      'docs/sdk/tasks/transpose.md': 'transpose-task',
      'docs/sdk/reference/README.md': 'reference',
      'docs/sdk/reference/chord-sheet.md': 'reference/chord-sheet',
      'docs/sdk/reference/playground.md': 'reference/playground',
      'docs/sdk/reference/editors.md': 'reference/editors',
      'docs/sdk/reference/layout.md': 'reference/layout',
      'docs/sdk/reference/transpose.md': 'reference/transpose',
      'docs/sdk/reference/chord-diagram.md': 'reference/chord-diagram',
      'docs/sdk/reference/pdf-export.md': 'reference/pdf-export',
      'docs/sdk/reference/chord-source-edit.md': 'reference/chord-source-edit',
      'docs/sdk/reference/ireal-components.md': 'reference/ireal-components',
      'docs/sdk/reference/ireal-hooks.md': 'reference/ireal-hooks',
      'docs/sdk/reference/ireal-helpers.md': 'reference/ireal-helpers',
      'docs/sdk/reference/version.md': 'reference/version',
    };
    expect(DOCS_SDK_PATH_TO_SLUG).toEqual(expected);
  });
});
