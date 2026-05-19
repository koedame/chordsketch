// Pure Node-side render pipeline for the docs SSG.
//
// Imported by:
//   - `scripts/build-docs-static.mjs` (production build)
//   - `tests/docs-render.test.ts` (vitest unit suite)
//
// JSDOM + DOMPurify supply the sanitiser; `marked` parses Markdown.
// Heading slugs match GitHub-style anchors. The link renderer routes
// every relative href through `rewriteHref` so docs/sdk/<page>.md
// links collapse to clean URLs and other repo paths point at
// github.com.
//
// Per `.claude/rules/sanitizer-security.md`: every string that
// reaches an HTML attribute passes through DOMPurify here. The
// URI-scheme denylist mirrors `crates/render-html`'s
// `has_dangerous_uri_scheme` and the React JSX walker's
// `isSafeHref` — sister-site parity per
// `.claude/rules/fix-propagation.md`.

import { Marked } from 'marked';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const SITE_BASE = '/chordsketch/';
export const DOCS_BASE = `${SITE_BASE}docs/`;
export const REPO_BLOB_BASE =
  'https://github.com/koedame/chordsketch/blob/main/';

export const DOC_GROUPS = [
  {
    label: 'Getting started',
    pages: [
      {
        slug: '',
        title: 'ChordSketch SDK',
        blurb:
          'Unified entry point for using ChordSketch from any language or runtime.',
        sourcePath: 'docs/sdk/README.md',
      },
    ],
  },
  {
    label: 'Recipes',
    pages: [
      {
        slug: 'embed-react',
        title: 'Embed in a React app',
        blurb:
          '10 copy-paste recipes for the @chordsketch/react component surface.',
        sourcePath: 'docs/sdk/tasks/embed-react.md',
      },
      {
        slug: 'render',
        title: 'Render across every binding',
        blurb:
          'Render to HTML, plain text, or PDF — same operation, every host.',
        sourcePath: 'docs/sdk/tasks/render.md',
      },
      {
        slug: 'transpose-task',
        title: 'Transpose chords',
        blurb:
          'Transpose by N semitones across every binding (CLI / wasm / FFI / Rust).',
        sourcePath: 'docs/sdk/tasks/transpose.md',
      },
    ],
  },
  {
    label: 'API reference',
    pages: [
      {
        slug: 'reference',
        title: '@chordsketch/react reference',
        blurb: 'Per-component and per-hook reference for every export.',
        sourcePath: 'docs/sdk/reference/README.md',
      },
      {
        slug: 'reference/chord-sheet',
        title: '<ChordSheet> + AST hooks',
        blurb:
          '<ChordSheet>, renderChordproAst, useChordRender, useChordproAst.',
        sourcePath: 'docs/sdk/reference/chord-sheet.md',
      },
      {
        slug: 'reference/playground',
        title: '<Playground>',
        blurb: 'One-component editor + preview + transpose embed.',
        sourcePath: 'docs/sdk/reference/playground.md',
      },
      {
        slug: 'reference/editors',
        title: 'Editors',
        blurb:
          '<ChordEditor>, <SourceEditor>, chordProLanguage, chordProTagTable.',
        sourcePath: 'docs/sdk/reference/editors.md',
      },
      {
        slug: 'reference/layout',
        title: 'Layout primitives',
        blurb: '<SplitLayout>, <RendererPreview>.',
        sourcePath: 'docs/sdk/reference/layout.md',
      },
      {
        slug: 'reference/transpose',
        title: '<Transpose> + useTranspose',
        blurb:
          'Accessible ± / reset control + matching hook for arbitrary UIs.',
        sourcePath: 'docs/sdk/reference/transpose.md',
      },
      {
        slug: 'reference/chord-diagram',
        title: '<ChordDiagram> + useChordDiagram',
        blurb: 'Inline chord-voicing SVG renderer.',
        sourcePath: 'docs/sdk/reference/chord-diagram.md',
      },
      {
        slug: 'reference/pdf-export',
        title: '<PdfExport> + usePdfExport',
        blurb: 'Lazy-loaded PDF export button + hook for custom UIs.',
        sourcePath: 'docs/sdk/reference/pdf-export.md',
      },
      {
        slug: 'reference/chord-source-edit',
        title: 'Chord source-edit helpers',
        blurb:
          'applyChordReposition, lyricsOffsetToSourceColumn — drag-to-edit primitives.',
        sourcePath: 'docs/sdk/reference/chord-source-edit.md',
      },
      {
        slug: 'reference/ireal-components',
        title: 'iReal Pro components',
        blurb: '<IrealEditor>, <IrealPreview>, <IrealPlayground>.',
        sourcePath: 'docs/sdk/reference/ireal-components.md',
      },
      {
        slug: 'reference/ireal-hooks',
        title: 'iReal Pro hooks',
        blurb: 'useIrealParse, useIrealSerialize, useIrealRender.',
        sourcePath: 'docs/sdk/reference/ireal-hooks.md',
      },
      {
        slug: 'reference/ireal-helpers',
        title: 'iReal Pro AST helpers',
        blurb: 'irealChord*ToString, irealCanonicalSymbolText, irealIs*.',
        sourcePath: 'docs/sdk/reference/ireal-helpers.md',
      },
      {
        slug: 'reference/version',
        title: 'version()',
        blurb:
          'Runtime version of the installed @chordsketch/react release.',
        sourcePath: 'docs/sdk/reference/version.md',
      },
    ],
  },
];

const PAGE_BY_SOURCE = new Map();
const PAGE_BY_SLUG = new Map();
for (const group of DOC_GROUPS) {
  for (const page of group.pages) {
    PAGE_BY_SOURCE.set(page.sourcePath, page);
    PAGE_BY_SLUG.set(page.slug, page);
  }
}

export function findPage(slug) {
  return PAGE_BY_SLUG.get(slug) ?? null;
}

export function allPages() {
  const out = [];
  for (const group of DOC_GROUPS) for (const p of group.pages) out.push(p);
  return out;
}

const DANGEROUS_URI_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'mhtml:',
];

function isInvisibleFormatChar(code) {
  return (
    code === 0x00ad ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2060 ||
    code === 0xfeff ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
function isAsciiWhitespace(c) {
  return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}
function isAsciiControl(c) {
  return c < 0x20 || c === 0x7f;
}
function isUnicodeNonAsciiWhitespace(c) {
  return (
    c === 0x000b ||
    c === 0x0085 ||
    c === 0x00a0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}
function normalizeUriForCheck(href) {
  const out = [];
  let started = false;
  for (const ch of href) {
    if (out.length >= 30) break;
    const code = ch.codePointAt(0);
    if (!started) {
      if (isAsciiWhitespace(code) || isUnicodeNonAsciiWhitespace(code)) continue;
      started = true;
    }
    if (isAsciiWhitespace(code) || isAsciiControl(code) || isInvisibleFormatChar(code)) {
      continue;
    }
    out.push(ch);
  }
  return out.join('').toLowerCase();
}
export function isSafeHref(href) {
  if (href === null) return true;
  const n = normalizeUriForCheck(href);
  if (n === '') return true;
  return !DANGEROUS_URI_SCHEMES.some((s) => n.startsWith(s));
}
export function isExternalHttpHref(href) {
  const n = normalizeUriForCheck(href);
  return n.startsWith('http://') || n.startsWith('https://');
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
export function slugifyWithCounter(text, counters) {
  const base = slugify(text);
  const count = counters.get(base) ?? 0;
  counters.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}
function plainText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
function resolveRelative(baseDir, rel) {
  const segments = baseDir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

export function cleanUrlFor(slug, hashSuffix = '') {
  if (slug === '') {
    return hashSuffix === '' ? DOCS_BASE : `${DOCS_BASE}${hashSuffix}`;
  }
  return `${DOCS_BASE}${slug}/${hashSuffix}`;
}

/**
 * Resolve a Markdown link against the source's directory and rewrite
 * it for the static deploy: docs/sdk pages → clean URL, other repo
 * paths → github.com blob URL, absolute / fragment-only → untouched.
 */
export function rewriteHref(href, sourceDir) {
  if (href === '') return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('//')) return href;

  // SPA-era hash routes like `#/reference/chord-sheet` and
  // `#/embed-react` survive in the source markdown for compatibility
  // with the GitHub repo viewer. Translate them to the static deploy's
  // clean URL when the target is a registered slug; leave them as
  // plain in-page anchors otherwise (the browser will scroll to the
  // matching heading id natively).
  if (href.startsWith('#/')) {
    const trimmed = href.slice(2).replace(/\/$/, '');
    const slug = trimmed.split('?')[0];
    if (PAGE_BY_SLUG.has(slug)) return cleanUrlFor(slug);
  }
  if (href.startsWith('#')) return href;

  const hashIdx = href.indexOf('#');
  const pathPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const hashSuffix = hashIdx === -1 ? '' : href.slice(hashIdx);
  const resolved = resolveRelative(sourceDir, pathPart);

  const target = PAGE_BY_SOURCE.get(resolved);
  if (target !== undefined) return cleanUrlFor(target.slug, hashSuffix);
  if (resolved === '') {
    return hashSuffix === '' ? DOCS_BASE : `${DOCS_BASE}${hashSuffix}`;
  }
  return `${REPO_BLOB_BASE}${resolved}${hashSuffix}`;
}

// Shared JSDOM + DOMPurify across calls — both are pure, both
// short-lived enough that re-creating per-call would be wasteful.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const DOMPurify = createDOMPurify(dom.window);
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof dom.window.Element)) return;
  const href = node.getAttribute('href');
  if (href !== null && !isSafeHref(href)) node.removeAttribute('href');
  const src = node.getAttribute('src');
  if (src !== null && !isSafeHref(src)) node.removeAttribute('src');
  if (node.hasAttribute('target')) node.removeAttribute('target');
  if (node.tagName === 'A' && href !== null && isExternalHttpHref(href)) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  }
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['id'],
};

/** Parse Markdown to sanitised HTML; `sourcePath` may be empty for
 *  ad-hoc inputs (no relative-link rewriting then). */
export function renderMarkdown(source, sourcePath = '') {
  const counters = new Map();
  const md = new Marked({ gfm: true, breaks: false });
  const sourceDir = dirOf(sourcePath);
  md.use({
    renderer: {
      heading(token) {
        const innerHtml = this.parser.parseInline(token.tokens);
        const text = plainText(innerHtml);
        const id = slugifyWithCounter(text, counters);
        return `<h${token.depth} id="${escapeAttribute(id)}">${innerHtml}</h${token.depth}>\n`;
      },
      link(token) {
        const innerHtml = this.parser.parseInline(token.tokens);
        const href = rewriteHref(token.href, sourceDir);
        const titleAttr = token.title
          ? ` title="${escapeAttribute(token.title)}"`
          : '';
        return `<a href="${escapeAttribute(href)}"${titleAttr}>${innerHtml}</a>`;
      },
    },
  });
  const html = md.parse(source);
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

const FENCE_RE = /^```[\s\S]*?^```/gm;
const HEADING_RE = /^(#+)\s+(.+)$/gm;
export function extractOutline(source) {
  const stripped = source.replace(FENCE_RE, (block) =>
    block.replace(/[^\n]/g, ''),
  );
  const outline = [];
  const counters = new Map();
  for (const match of stripped.matchAll(HEADING_RE)) {
    const depth = match[1].length;
    const text = match[2].trim();
    const id = slugifyWithCounter(text, counters);
    if (depth === 2 || depth === 3) {
      outline.push({ level: depth, text, id });
    }
  }
  return outline;
}
