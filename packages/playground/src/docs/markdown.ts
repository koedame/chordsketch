// Markdown → sanitised HTML pipeline used by every docs page.
//
// `marked` parses the Markdown to HTML; `DOMPurify` runs the output
// through a hardened sanitiser before it reaches
// `dangerouslySetInnerHTML`. The Markdown inputs are bundled at
// build time from `docs/sdk/` under our own control, but the
// sanitiser is non-negotiable per
// `.claude/rules/sanitizer-security.md` — every string that lands
// in structured output validates at the boundary, regardless of
// provenance. The cost is one ~7 KB gzipped dependency for a
// defence-in-depth guarantee that survives a future contributor
// inadvertently pasting untrusted content into the docs source.

import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

const ALLOWED_URI_SCHEMES = ['http', 'https', 'mailto'];
const URI_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

function isSafeHref(value: string | null): boolean {
  if (value === null) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('?')
  ) {
    return true;
  }
  const match = URI_SCHEME_RE.exec(trimmed);
  if (match === null) return true;
  const scheme = match[1].toLowerCase();
  return ALLOWED_URI_SCHEMES.includes(scheme);
}

// Hook to drop unsafe URI schemes from `href` / `src` even though
// they would be filtered by DOMPurify's default `ALLOWED_URI_REGEXP`.
// Belt-and-braces: matches the sister-site discipline of
// `crates/render-html`'s `has_dangerous_uri_scheme` and the React
// JSX walker's `isSafeHref`.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return;
  const href = node.getAttribute('href');
  if (href !== null && !isSafeHref(href)) {
    node.removeAttribute('href');
  }
  const src = node.getAttribute('src');
  if (src !== null && !isSafeHref(src)) {
    node.removeAttribute('src');
  }
  if (node.tagName === 'A' && href !== null) {
    const isExternal =
      href.startsWith('http://') || href.startsWith('https://');
    if (isExternal) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noreferrer noopener');
    }
  }
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true } as const,
  ADD_ATTR: ['target', 'id'],
};

/**
 * Strip-tags helper for the heading text passed to the renderer:
 * Markdown allows inline markup inside a heading (`## My **bold**`),
 * which `marked` has already converted to HTML at the renderer
 * boundary. The slug needs the visible text, not the inline tags.
 */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Parse Markdown to sanitised HTML ready for React injection. */
export function renderMarkdown(source: string): string {
  // A fresh `Marked` instance per render keeps the heading-slug
  // counter scoped to one page. Sharing a single configured instance
  // would leak counters across renders (`introduction` on one page
  // would suffix the same heading on another page as
  // `introduction-1`).
  const counters = new Map<string, number>();
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      heading(token: Tokens.Heading) {
        const innerHtml = this.parser.parseInline(token.tokens);
        const text = plainText(innerHtml);
        const base = slugify(text);
        const count = counters.get(base) ?? 0;
        counters.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        return `<h${token.depth} id="${escapeAttribute(id)}">${innerHtml}</h${token.depth}>\n`;
      },
    },
  });
  const html = md.parse(source) as string;
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as string;
}

/** Extract the first H1 from a Markdown source for nav titles. */
export function extractTitle(source: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(source);
  if (match === null) return fallback;
  return match[1].trim();
}

/**
 * Extract h2 / h3 headings for the on-page outline. The id matches
 * the slug the renderer assigns to the same heading, so the
 * outline anchor + the rendered anchor stay in lockstep.
 */
export interface DocOutlineEntry {
  level: 2 | 3;
  text: string;
  id: string;
}

const HEADING_RE = /^(##{1,2})\s+(.+)$/gm;

export function extractOutline(source: string): DocOutlineEntry[] {
  const outline: DocOutlineEntry[] = [];
  const seen = new Map<string, number>();
  for (const match of source.matchAll(HEADING_RE)) {
    const hashes = match[1];
    const level = hashes.length === 2 ? 2 : 3;
    const text = match[2].trim();
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    outline.push({ level: level as 2 | 3, text, id });
  }
  return outline;
}
