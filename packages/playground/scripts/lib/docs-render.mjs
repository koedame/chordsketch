// URI-scheme denylist mirrors `crates/render-html`'s
// `has_dangerous_uri_scheme` and the React JSX walker's
// `isSafeHref` — sister-site parity per
// `.claude/rules/sanitizer-security.md` + `.claude/rules/fix-propagation.md`.
// Any addition or removal MUST land in all three sites in the same PR.

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
        title: '<ChordProEditor>',
        blurb: 'One-component editor + preview + transpose embed (renamed from <Playground> in v0.3.0).',
        sourcePath: 'docs/sdk/reference/playground.md',
      },
      {
        slug: 'reference/editors',
        title: 'Editors',
        blurb:
          '<ChordTextarea>, <ChordSourceArea>, chordProLanguage, chordProTagTable.',
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
        blurb: '<IrealBarGrid>, <IrealPreview>, <IrealProEditor>.',
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

// Slugs land verbatim in URL segments, in `path.resolve(DOCS_OUT_DIR,
// slug, 'index.html')`, and in HTML id lookups. Constraining the
// shape here at module load forecloses path-traversal-shaped slugs
// (e.g. `../foo`) without trusting downstream consumers to validate.
const SLUG_RE = /^(?:|[a-z0-9-]+(?:\/[a-z0-9-]+)*)$/;
const SOURCE_PATH_RE = /^docs\/sdk\/[A-Za-z0-9/_-]+\.md$/;

const PAGE_BY_SOURCE = new Map();
const PAGE_BY_SLUG = new Map();
for (const group of DOC_GROUPS) {
  for (const page of group.pages) {
    if (!SLUG_RE.test(page.slug)) {
      throw new Error(
        `Invalid docs slug ${JSON.stringify(page.slug)} — must match ${SLUG_RE}.`,
      );
    }
    if (!SOURCE_PATH_RE.test(page.sourcePath)) {
      throw new Error(
        `Invalid sourcePath ${JSON.stringify(page.sourcePath)} for slug ${JSON.stringify(page.slug)} — must match ${SOURCE_PATH_RE}.`,
      );
    }
    if (PAGE_BY_SLUG.has(page.slug)) {
      throw new Error(`Duplicate docs slug ${JSON.stringify(page.slug)}.`);
    }
    if (PAGE_BY_SOURCE.has(page.sourcePath)) {
      throw new Error(
        `Duplicate sourcePath ${JSON.stringify(page.sourcePath)}.`,
      );
    }
    PAGE_BY_SOURCE.set(page.sourcePath, page);
    PAGE_BY_SLUG.set(page.slug, page);
  }
}

export function findPage(slug) {
  return PAGE_BY_SLUG.get(slug);
}

export function allPages() {
  const out = [];
  for (const group of DOC_GROUPS) for (const p of group.pages) out.push(p);
  return out;
}

/** Frozen list of every registered slug, used by the inline shim
 *  to refuse navigation to unknown targets. */
export const REGISTERED_SLUGS = Object.freeze([...PAGE_BY_SLUG.keys()]);

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
  let base = slugify(text);
  if (base === '') {
    // Headings containing only non-ASCII characters (e.g. Japanese)
    // collapse to an empty slug under the GitHub-flavoured rule.
    // Emit a deterministic fallback so anchors stay unique instead of
    // colliding on the empty key.
    base = 'heading';
  }
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
// Throws when a relative path escapes the repo root so the build
// surfaces author typos like `../../../../foo.md` instead of
// silently emitting a github.com URL to a non-existent file.
class RelativePathEscapesRoot extends Error {
  constructor(baseDir, rel) {
    super(
      `Relative path "${rel}" from "${baseDir}" climbs above the repo root.`,
    );
    this.name = 'RelativePathEscapesRoot';
  }
}

function resolveRelative(baseDir, rel) {
  const segments = baseDir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) {
        throw new RelativePathEscapesRoot(baseDir, rel);
      }
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
  // Absolute / scheme-qualified / protocol-relative / root-relative:
  // pass through. The protocol-relative test (`//`) MUST run before
  // the root-relative test (`/`) so the longer prefix wins.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('//')) return href;
  if (href.startsWith('/')) return href;

  // Hash routes like `#/reference/chord-sheet` are SSG-only and only
  // make sense when the slug is registered; translate to a clean URL.
  // Unknown `#/<x>` hashes pass through as a literal anchor so the
  // browser still attempts a native fragment scroll.
  if (href.startsWith('#/')) {
    const trimmed = href.slice(2).replace(/\/$/, '');
    const slug = trimmed.split('?')[0];
    if (PAGE_BY_SLUG.has(slug)) return cleanUrlFor(slug);
  }
  if (href.startsWith('#')) return href;

  // Order matters: strip the query string before the hash so a link
  // like `[x](README.md?v=1#heading)` resolves the right basename
  // for `PAGE_BY_SOURCE` lookup. The query is dropped on rewrite
  // since static-deploy URLs have no query-string semantics.
  const queryIdx = href.indexOf('?');
  const hashIdx = href.indexOf('#');
  let pathEnd = href.length;
  if (queryIdx !== -1) pathEnd = Math.min(pathEnd, queryIdx);
  if (hashIdx !== -1) pathEnd = Math.min(pathEnd, hashIdx);
  const pathPart = href.slice(0, pathEnd);
  const hashSuffix = hashIdx === -1 ? '' : href.slice(hashIdx);

  const resolved = resolveRelative(sourceDir, pathPart);

  const target = PAGE_BY_SOURCE.get(resolved);
  if (target !== undefined) return cleanUrlFor(target.slug, hashSuffix);
  if (resolved === '') {
    return hashSuffix === '' ? DOCS_BASE : `${DOCS_BASE}${hashSuffix}`;
  }
  return `${REPO_BLOB_BASE}${resolved}${hashSuffix}`;
}

// Module-scoped: JSDOM + DOMPurify construction is non-trivial and
// both instances are safe to reuse across sanitize() calls (the hook
// reads only the node passed in).
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const DOMPurify = createDOMPurify(dom.window);
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof dom.window.Element)) return;
  const rawHref = node.getAttribute('href');
  const hrefIsSafe = rawHref === null || isSafeHref(rawHref);
  if (!hrefIsSafe) node.removeAttribute('href');
  const src = node.getAttribute('src');
  if (src !== null && !isSafeHref(src)) node.removeAttribute('src');
  if (node.hasAttribute('target')) node.removeAttribute('target');
  // External-link decoration runs ONLY after the scheme guard has
  // accepted the href; otherwise a future denylist change could leak
  // `target="_blank"` onto an anchor whose href was just stripped.
  if (
    node.tagName === 'A' &&
    hrefIsSafe &&
    rawHref !== null &&
    isExternalHttpHref(rawHref)
  ) {
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
