// Markdown → sanitised HTML pipeline used by every docs page.
//
// `marked` parses the Markdown to HTML; `DOMPurify` runs the output
// through a hardened sanitiser before it reaches
// `dangerouslySetInnerHTML`. The Markdown inputs are bundled at
// build time from `docs/sdk/` under our own control, but the
// sanitiser is non-negotiable per
// `.claude/rules/sanitizer-security.md` — every string that lands
// in structured output validates at the boundary, regardless of
// provenance.
//
// The URI-scheme denylist below mirrors `DANGEROUS_URI_SCHEMES` in
// `packages/react/src/chordpro-jsx.tsx` and `has_dangerous_uri_scheme`
// in `crates/render-html/src/lib.rs` — sister-site parity per
// `.claude/rules/fix-propagation.md`. Any addition or removal MUST
// land in all three sites in the same PR.

import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

// Schemes blocked from `href` / `src` attributes.
// - `javascript:` / `vbscript:` — code execution
// - `data:` — content injection
// - `file:` / `blob:` — local file access when HTML is opened as a
//   local file
// - `mhtml:` — MIME HTML (IE-era)
const DANGEROUS_URI_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'mhtml:',
];

// Zero-width / format / bidi-override codepoints that browsers may
// render as invisible inside a URI scheme but which an attacker can
// use to split a blocked scheme name (e.g. `java\u{200B}script:` or
// `java\u{FEFF}script:`). Mirrors `isInvisibleFormatChar` in the
// React JSX walker.
function isInvisibleFormatChar(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x200b || // zero-width space
    code === 0x200c || // zero-width non-joiner
    code === 0x200d || // zero-width joiner
    code === 0x200e || // left-to-right mark
    code === 0x200f || // right-to-left mark
    code === 0x2060 || // word joiner
    code === 0xfeff || // BOM
    (code >= 0x202a && code <= 0x202e) || // bidi embedding/override
    (code >= 0x2066 && code <= 0x2069) // isolate / pop directional
  );
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}
function isAsciiControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}
function isUnicodeNonAsciiWhitespace(code: number): boolean {
  return (
    code === 0x000b ||
    code === 0x0085 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/**
 * Normalize an `href` / `src` value for prefix-checking. Trims
 * leading Unicode whitespace, drops embedded whitespace / control /
 * invisible-format codepoints, and lower-cases the first 30
 * significant codepoints. Returned value is the comparison key used
 * by every `*Href*` helper in this module.
 *
 * Iterates via the string iterator so astral codepoints count as
 * one position against the `take(30)` cap, matching the Rust
 * `chars()` semantics.
 */
function normalizeUriForCheck(href: string): string {
  const out: string[] = [];
  let started = false;
  for (const ch of href) {
    if (out.length >= 30) break;
    const code = ch.codePointAt(0)!;
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

/**
 * True when `href` is safe to keep on a link / image. Returns true
 * for relative paths, fragment-only links, and any scheme not in
 * the denylist. Mirrors `isSafeHref` in
 * `packages/react/src/chordpro-jsx.tsx`.
 */
export function isSafeHref(href: string | null): boolean {
  if (href === null) return true;
  const normalized = normalizeUriForCheck(href);
  if (normalized === '') return true;
  return !DANGEROUS_URI_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/** True when the normalized href targets an external `http(s)` origin. */
export function isExternalHttpHref(href: string): boolean {
  const normalized = normalizeUriForCheck(href);
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

// Hook to strip unsafe URI schemes from `href` / `src` (defence in
// depth with DOMPurify's default `ALLOWED_URI_REGEXP`) and to
// upgrade external `<a>` to `target="_blank" rel="noreferrer noopener"`.
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
  // Strip author-controlled `target` values (e.g. named-frame
  // redress) regardless of source — the hook below re-applies
  // `target="_blank"` only for external HTTP(S) hrefs we have just
  // validated, so author-supplied `target` cannot survive.
  if (node.hasAttribute('target')) {
    node.removeAttribute('target');
  }
  if (node.tagName === 'A' && href !== null && isExternalHttpHref(href)) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  }
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true } as const,
  // Allow `id` on headings so the on-page outline anchors land
  // correctly. `target` is deliberately NOT here — the hook above
  // sets it only on externally-href'd anchors after validating the
  // scheme. Listing it in `ADD_ATTR` would let author-supplied
  // Markdown specify arbitrary `target` values on internal links.
  ADD_ATTR: ['id'],
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

/**
 * GitHub-flavoured slug: lower-case, strip non-alphanumeric except
 * hyphens, collapse whitespace runs to single hyphens. Exposed so
 * unit tests can lock the renderer's slug rules and the
 * `extractOutline` slug rules to the same implementation.
 */
export function slugify(text: string): string {
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

/**
 * Apply the heading-slug duplication rule used by both
 * {@link renderMarkdown} and {@link extractOutline}: the first
 * occurrence keeps the base slug, subsequent occurrences get
 * `-1`, `-2`, … suffixes. Returned slug + counter mutation match
 * GitHub's anchor convention.
 */
export function slugifyWithCounter(text: string, counters: Map<string, number>): string {
  const base = slugify(text);
  const count = counters.get(base) ?? 0;
  counters.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * Repo-relative paths of every docs/sdk page mapped to their SPA
 * slug. The docs source under `docs/sdk/` is intentionally shared
 * with the GitHub repo viewer (per ADR-0021), so internal links
 * are written as relative `.md` paths that work on GitHub. The
 * renderer rewrites them at render time so they resolve under the
 * docs SPA's hash routes too.
 *
 * Kept in lockstep with `DOC_GROUPS` in `pages.ts` — adding a page
 * means adding both an entry there AND a row here. The unit test
 * for `rewriteHref` is the safety net.
 */
const DOCS_SDK_PATH_TO_SLUG: Readonly<Record<string, string>> = {
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

/** Anchor under which non-`docs/sdk/` repo paths land on github.com. */
const REPO_BLOB_BASE = 'https://github.com/koedame/chordsketch/blob/main/';

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Resolve `relative` against `baseDir`, normalising `.` and `..`
 * segments. Both inputs use forward-slash POSIX paths with no
 * leading slash. Returned value drops any leading `./` or `../`
 * that escapes past the repo root (treated as no-op).
 */
function resolveRelative(baseDir: string, relative: string): string {
  const segments = baseDir.split('/').filter(Boolean);
  for (const seg of relative.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

/**
 * Rewrite a Markdown `href` so it resolves under the docs SPA's
 * hash-routed deploy at `/chordsketch/docs/`. Absolute URLs and
 * fragment-only hrefs pass through; relative paths are resolved
 * against `sourceDir` (the directory of the page's Markdown
 * source, e.g. `docs/sdk/tasks`) and then either mapped to the
 * matching SPA slug or rewritten to a `github.com` blob URL so
 * the link still works when clicked from the SPA. Exported so
 * unit tests can lock the rewrite rules without going through
 * the full Markdown pipeline.
 */
export function rewriteHref(href: string, sourceDir: string): string {
  if (href === '') return href;
  // Absolute / scheme-qualified / protocol-relative / fragment-only:
  // leave as-is. The sanitiser hook below handles `javascript:` etc.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('//')) return href;
  if (href.startsWith('#')) return href;

  const hashIdx = href.indexOf('#');
  const pathPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const hashSuffix = hashIdx === -1 ? '' : href.slice(hashIdx);

  const resolved = resolveRelative(sourceDir, pathPart);
  if (resolved in DOCS_SDK_PATH_TO_SLUG) {
    const slug = DOCS_SDK_PATH_TO_SLUG[resolved];
    // The SPA's hash carries either the route or the in-page anchor
    // — not both. For the index page we can emit `#/` + suffix
    // since `#/` is the canonical index route; for non-index pages
    // dropping the suffix is the least-bad option (no docs/sdk page
    // currently links to a specific heading on another docs/sdk
    // page, so the lossy case is unreachable today). Adding such a
    // link in the future means revisiting the routing model.
    if (slug === '') {
      return hashSuffix === '' ? '#/' : hashSuffix;
    }
    return `#/${slug}`;
  }
  if (resolved === '') {
    return hashSuffix === '' ? '#/' : hashSuffix;
  }
  return `${REPO_BLOB_BASE}${resolved}${hashSuffix}`;
}

/** Parse Markdown to sanitised HTML ready for React injection. */
export function renderMarkdown(source: string, sourcePath = ''): string {
  // A fresh `Marked` instance per render keeps the heading-slug
  // counter scoped to one page. Sharing a single configured instance
  // would leak counters across renders (`introduction` on one page
  // would suffix the same heading on another page as
  // `introduction-1`).
  const counters = new Map<string, number>();
  const md = new Marked({ gfm: true, breaks: false });
  const sourceDir = dirOf(sourcePath);
  md.use({
    renderer: {
      heading(token: Tokens.Heading) {
        const innerHtml = this.parser.parseInline(token.tokens);
        const text = plainText(innerHtml);
        const id = slugifyWithCounter(text, counters);
        return `<h${token.depth} id="${escapeAttribute(id)}">${innerHtml}</h${token.depth}>\n`;
      },
      link(token: Tokens.Link) {
        const innerHtml = this.parser.parseInline(token.tokens);
        const href = rewriteHref(token.href, sourceDir);
        const titleAttr = token.title
          ? ` title="${escapeAttribute(token.title)}"`
          : '';
        return `<a href="${escapeAttribute(href)}"${titleAttr}>${innerHtml}</a>`;
      },
    },
  });
  const html = md.parse(source) as string;
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as string;
}

/**
 * Extract h2 / h3 headings for the on-page outline. The id matches
 * the slug the renderer assigns to the same heading, so the
 * outline anchor + the rendered anchor stay in lockstep — both
 * use {@link slugifyWithCounter}.
 */
export interface DocOutlineEntry {
  level: 2 | 3;
  text: string;
  id: string;
}

// Match ALL heading depths (h1-h6) so the slug counter stays in
// sync with `renderMarkdown`'s counter, which increments across
// every heading level using the same slugify key. Only h2 and h3
// entries are pushed to the outline, but h1 / h4-h6 still advance
// the counter so that duplicate-slug disambiguation (e.g.
// `"intro"` → `"intro-1"`) produces the same IDs here as in
// `renderMarkdown`. Without this, a page whose h1 slug collides
// with an h2 slug would give the h2 an id of `"slug-1"` in the
// rendered HTML but an id of `"slug"` in the outline, producing a
// broken anchor link for that outline entry.
//
// Fenced code blocks are stripped first so a `## ` line inside a
// triple-backtick example is not surfaced as an outline entry.
const HEADING_RE = /^(#+)\s+(.+)$/gm;
const FENCE_RE = /^```[\s\S]*?^```/gm;

export function extractOutline(source: string): DocOutlineEntry[] {
  const stripped = source.replace(FENCE_RE, (block) =>
    // Preserve newline count so any subsequent line-based parsing
    // still sees the same line offsets — important if a future
    // caller correlates the outline with source positions.
    block.replace(/[^\n]/g, ''),
  );
  const outline: DocOutlineEntry[] = [];
  const counters = new Map<string, number>();
  for (const match of stripped.matchAll(HEADING_RE)) {
    const hashes = match[1];
    const depth = hashes.length;
    const text = match[2].trim();
    // Always tick the counter so h1 / h4-h6 headings still
    // contribute to the duplicate-slug suffix sequence that
    // `renderMarkdown` applies across every level.
    const id = slugifyWithCounter(text, counters);
    if (depth === 2 || depth === 3) {
      outline.push({ level: depth as 2 | 3, text, id });
    }
  }
  return outline;
}
