// URI-scheme denylist mirrors `crates/render-html`'s
// `has_dangerous_uri_scheme` and the React JSX walker's
// `isSafeHref` — sister-site parity per
// `.claude/rules/sanitizer-security.md` + `.claude/rules/fix-propagation.md`.
// Any addition or removal MUST land in all three sites in the same PR.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Marked } from 'marked';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { createHighlighter } from 'shiki';

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
        slug: 'reference/chord-pro-preview',
        title: '<ChordProPreview>',
        blurb:
          'Preview pane + format toggle + transpose controls, no source editor (new in v0.3.0).',
        sourcePath: 'docs/sdk/reference/chord-pro-preview.md',
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
  // Covers (a) the canonical BIDI / format-control set that
  // CVE-2021-42574 (Trojan Source) recognises, (b) Unicode
  // variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF) and
  // Mongolian variation selectors (U+180B–U+180D), and (c)
  // language-tag characters (U+E0000–U+E007F). All of these
  // render invisibly and have been used in steganography and
  // prompt-injection vectors against text-processing pipelines.
  // Neutralise them on every path that does not need them — no
  // legitimate ChordPro / docs-source content uses these
  // codepoints.
  return (
    code === 0x00ad ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2060 ||
    code === 0xfeff ||
    (code >= 0x180b && code <= 0x180d) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
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

// DOMPurify config + style-narrowing hook
//
// `style` is added to PURIFY_CONFIG.ADD_ATTR so Shiki's per-token
// `<span style="color:#XXXXXX">` survives sanitisation. DOMPurify
// 3.x treats `style` as a URI-safe attribute (see
// DEFAULT_URI_SAFE_ATTRIBUTES in DOMPurify/src/attrs.ts), which
// means the IS_ALLOWED_URI regex is NOT applied to the CSS value —
// so a `style="background-image:url(/exfil)"` written into an
// authored markdown source would otherwise survive into the
// deployed HTML and fire a GitHub-Pages-origin request from every
// reader's browser.
//
// Defence strategy: fail-closed allowlist of CSS
// property:value patterns Shiki actually emits. Anything else
// (`url(...)`, `image-set(...)`, `image(...)`, CSS hex escapes
// like `url\28...\29` that browsers normalise to `url(...)`,
// `@import` smuggled via inline-style — which browsers ignore
// but the allowlist catches anyway, CSS comments inside the value,
// custom `var(--x)` references with payloads) does not match and
// triggers full-attribute strip. The allowlist matches the full
// known repertoire of Shiki themes (color, font-style,
// font-weight, text-decoration). A future Shiki release adding a
// new declaration will trip the unit tests (which assert legitimate
// output survives) and force a deliberate widening here, not
// silent regression of the security posture.
//
// USE_PROFILES.html intentionally excludes the svg and mathml
// profiles (see DOMPurify/src/tags.ts) so the `<span>` allowance
// does NOT propagate into an SVG/MathML subtree — a future change
// that adds `svg: true` here MUST re-audit the style allowlist.
const SHIKI_STYLE_TAGS = new Set(['PRE', 'CODE', 'SPAN']);
// Match a single CSS declaration in the form `property: value`,
// trimmed. Each branch is one property Shiki may emit; the value
// patterns are deliberately strict (no parens, no backslashes, no
// quotes, no whitespace except inside enumerated keywords). The
// hex-colour widths cover the four CSS-spec lengths (3, 4, 6, 8);
// 5- and 7-digit hex values are CSS-malformed and never emitted by
// any bundled Shiki theme. The `text-decoration` value allows a
// space-separated combination so a token carrying both
// `underline` and `line-through` bits (which Shiki's core renderer
// joins with a space) survives the allowlist.
const HEX_COLOUR_VALUE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})/i;
const TEXT_DECORATION_KW = /(?:underline|none|line-through|overline)/;
const SHIKI_STYLE_DECL_RE = new RegExp(
  `^(?:` +
    `color\\s*:\\s*${HEX_COLOUR_VALUE.source}` +
    `|background-color\\s*:\\s*${HEX_COLOUR_VALUE.source}` +
    `|font-style\\s*:\\s*(?:italic|normal|oblique)` +
    `|font-weight\\s*:\\s*(?:bold|normal|lighter|bolder|[1-9]00)` +
    `|text-decoration\\s*:\\s*${TEXT_DECORATION_KW.source}` +
    `(?:\\s+${TEXT_DECORATION_KW.source})*` +
    `)$`,
  'i',
);
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['id', 'style'],
};

/** Fail-closed: returns true ONLY when every `;`-separated
 *  declaration in the supplied style value matches the Shiki
 *  property:value allowlist. Empty / whitespace-only values are
 *  treated as legitimate (DOMPurify would have left them as-is). */
function isLegitimateShikiStyle(value) {
  if (value.trim() === '') return true;
  for (const raw of value.split(';')) {
    const decl = raw.trim();
    if (decl === '') continue;
    if (!SHIKI_STYLE_DECL_RE.test(decl)) return false;
  }
  return true;
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
  // `tagName` is uppercase in JSDOM for standard HTML elements
  // (`PRE` / `CODE` / `SPAN`). Custom elements and unknown tags are
  // intentionally outside SHIKI_STYLE_TAGS — their `style` is
  // stripped even if DOMPurify happens to pass the tag through.
  // Even on the three allowed tags, the value is gated through the
  // strict Shiki property:value allowlist; anything else (CSS
  // `url(...)` / `image-set(...)` / hex-escaped parens /
  // unrecognised properties) loses the entire attribute.
  const styleAttr = node.getAttribute('style');
  if (styleAttr !== null) {
    if (
      !SHIKI_STYLE_TAGS.has(node.tagName) ||
      !isLegitimateShikiStyle(styleAttr)
    ) {
      node.removeAttribute('style');
    }
  }
});

// Shiki highlighter. Build-time only per
// [ADR-0025](../../../../docs/adr/0025-build-time-syntax-highlighting-shiki.md);
// the deployed pages carry zero JS beyond the inline hash-redirect
// shim ([ADR-0021](../../../../docs/adr/0021-docs-site-co-located-with-playground.md)).
// The highlighter object is reused across every page render so we
// pay grammar / theme load cost once. The ChordPro grammar is
// sister-site to `syntaxes/chordpro.tmLanguage.json` — the same
// TextMate grammar VS Code (`packages/vscode-extension`, copied via
// esbuild) and the JetBrains plugin
// (`packages/jetbrains-plugin/textmate/chordpro/`) already ship for
// editor highlighting, so on-page docs colour matches what those
// editors render. (The Zed extension uses an independent
// tree-sitter grammar at `packages/tree-sitter-chordpro` — out of
// scope here per ADR-0025.)
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CHORDPRO_GRAMMAR_PATH = resolve(
  REPO_ROOT,
  'syntaxes/chordpro.tmLanguage.json',
);
let CHORDPRO_GRAMMAR;
try {
  CHORDPRO_GRAMMAR = JSON.parse(readFileSync(CHORDPRO_GRAMMAR_PATH, 'utf8'));
} catch (err) {
  throw new Error(
    `Failed to load ChordPro TextMate grammar from ${CHORDPRO_GRAMMAR_PATH}. ` +
      `This grammar is the sister site of the VS Code / JetBrains chordpro ` +
      `language packages; verify the file exists and is valid JSON.`,
    { cause: err },
  );
}
// Languages preloaded into the singleton Shiki highlighter. The
// roster MUST cover every fence header used under `docs/sdk/` —
// `build-docs-static.mjs` enforces this at build time via
// `assertEveryFenceLangIsLoaded` so an undeclared lang fails the
// build instead of silently rendering plain `<pre><code>`.
const SHIKI_LANGS = [
  'bash',
  'json',
  'kotlin',
  'python',
  'ruby',
  'rust',
  'shell',
  'swift',
  'tsx',
  'typescript',
  { ...CHORDPRO_GRAMMAR, name: 'chordpro' },
];
const SHIKI_THEME = 'github-dark';
let HIGHLIGHTER;
try {
  HIGHLIGHTER = await createHighlighter({
    themes: [SHIKI_THEME],
    langs: SHIKI_LANGS,
  });
} catch (err) {
  const langNames = SHIKI_LANGS.map((l) =>
    typeof l === 'string' ? l : (l.name ?? '<unnamed grammar>'),
  ).join(', ');
  throw new Error(
    `Shiki highlighter failed to initialise (theme=${SHIKI_THEME}, ` +
      `langs=[${langNames}]). One of the grammars or the theme may be ` +
      `malformed; check the trace and confirm Shiki version compatibility.`,
    { cause: err },
  );
}
// Aliases for fence headers actually used in the docs corpus.
// Every alias's resolved value MUST appear in SHIKI_LOADED_LANGS
// below; the build-time validator catches drift on the next build.
const SHIKI_LANG_ALIASES = new Map([
  ['ts', 'typescript'],
  ['sh', 'bash'],
  ['shellscript', 'bash'],
]);
const SHIKI_LOADED_LANGS = new Set(HIGHLIGHTER.getLoadedLanguages());

// HAST `<pre>` properties to keep on Shiki output. Everything else
// — Shiki's inline `style="background-color:..."`, `tabindex`, any
// future string- or symbol-keyed property — is stripped so the
// `.docs-prose pre` CSS rule keeps controlling background, padding,
// and border-radius. Allowlist semantics: future Shiki versions
// adding new wrapper attrs cannot leak into the deployed HTML.
const SHIKI_PRE_KEEP_PROPERTIES = new Set(['class']);
const stripPreWrapper = {
  pre(node) {
    if (!node.properties) {
      // Shiki's hast contract requires every `<pre>` node to carry a
      // `properties` object (so the `class="shiki <theme>"` attribute
      // can land). A missing object means the upstream API changed;
      // failing loudly here is the only way to keep this transformer
      // honest — a silent no-op would let inline `style` regress.
      throw new Error(
        'Shiki HAST <pre> node has no `properties` object; the ' +
          'highlighter API may have changed and `stripPreWrapper` is ' +
          'no longer effective.',
      );
    }
    for (const key of Object.keys(node.properties)) {
      if (!SHIKI_PRE_KEEP_PROPERTIES.has(key)) {
        delete node.properties[key];
      }
    }
    // Object.keys() ignores symbol-keyed properties. Defensive: a
    // future HAST node that smuggles a Symbol-keyed sentinel
    // (private internal state, framework instrumentation, …) would
    // otherwise bypass the allowlist intent — drop those too.
    for (const sym of Object.getOwnPropertySymbols(node.properties)) {
      delete node.properties[sym];
    }
  },
};

/** Returns the canonical Shiki language id for a fence-header
 *  string, or `null` when the lang is unknown / empty. Exposed for
 *  the build-time validator in `build-docs-static.mjs`. */
export function resolveShikiLang(lang) {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  const aliased = SHIKI_LANG_ALIASES.get(lower) ?? lower;
  return SHIKI_LOADED_LANGS.has(aliased) ? aliased : null;
}

/** HTML-escape for text-node content (NOT attribute values; see
 *  `escapeAttribute` for that context). Also filters BIDI overrides
 *  and other invisible-format chars + null bytes so the unknown-lang
 *  fallback path cannot smuggle Trojan-Source style payloads into
 *  the deployed HTML. */
function escapeHtmlText(value) {
  let filtered = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === 0 || isInvisibleFormatChar(code)) continue;
    filtered += ch;
  }
  return filtered
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build-time-only function; the docs corpus's longest fence body
// (an ASCII architecture diagram in `docs/sdk/README.md`, measured
// at 1395 bytes by walking every fence under `docs/sdk/` — see
// ADR-0025 §"Decision" + §"Consequences") sits well under this
// ceiling. Note: that fence carries no info-string lang, so it
// reaches Shiki via the fallback path. The cap turns a runaway
// input (a machine-generated doc file, a mis-rendered binary
// embedded in a fence) into a build error instead of an OOM or
// pathological highlight run.
const MAX_CODE_BLOCK_BYTES = 256 * 1024;

/**
 * Build-time syntax highlight for a single Markdown code fence.
 * Falls back to a sanitised `<pre><code>` for unknown languages
 * (also see `assertEveryFenceLangIsLoaded` in `build-docs-static.mjs`
 * which prevents that fallback from being silent on the deployed
 * corpus).
 *
 * Inputs come from in-repo markdown files, but the function is
 * exported and could be reused. The size cap is the only validation
 * — `code` is forwarded to Shiki and may legitimately contain any
 * Unicode; the fallback path additionally strips invisible-format
 * characters to neutralise Trojan-Source payloads.
 *
 * @param {string} code The fence body.
 * @param {string} lang The fence header (e.g. "tsx", "chordpro", "").
 * @returns {string} HTML — either `<pre class="shiki ..."><code>…</code></pre>`
 *                   or `<pre><code>…</code></pre>` for unknown langs.
 * @throws {Error} when `code` exceeds `MAX_CODE_BLOCK_BYTES`.
 */
export function highlightCodeBlock(code, lang) {
  // Semantics: input MUST be `<= MAX_CODE_BLOCK_BYTES`. Inputs of
  // exactly the cap size are accepted; the first rejected size is
  // `MAX_CODE_BLOCK_BYTES + 1`. The boundary is pinned by a unit
  // test on both sides so a mutation flipping `>` ↔ `>=` is caught.
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BLOCK_BYTES) {
    throw new Error(
      `highlightCodeBlock input exceeds ${MAX_CODE_BLOCK_BYTES} bytes; ` +
        `inputs come from in-repo markdown fences which should never be ` +
        `this large. Either split the fence or raise MAX_CODE_BLOCK_BYTES.`,
    );
  }
  const resolved = resolveShikiLang(lang);
  if (resolved === null) {
    return `<pre><code>${escapeHtmlText(code)}</code></pre>`;
  }
  return HIGHLIGHTER.codeToHtml(code, {
    lang: resolved,
    theme: SHIKI_THEME,
    transformers: [stripPreWrapper],
  });
}

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
      code(token) {
        return highlightCodeBlock(token.text, token.lang ?? '');
      },
    },
  });
  const html = md.parse(source);
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

// Strip CommonMark fenced code blocks before heading extraction.
// Sister-site to `FENCE_OPEN_RE` in `build-docs-static.mjs`: any
// fence shape that the build-time validator treats as a code block
// MUST also be excised here, otherwise a `##  heading` line
// embedded inside the fence body would silently appear in the
// on-page outline with a broken anchor (the heading does not reach
// the rendered HTML, so the link 404-scrolls).
//
// CommonMark §4.5 requires the closing fence to (a) use the same
// character (backtick or tilde) as the opening fence and (b) be at
// least as long. Two regexes — one per character — express (a)
// without backreference acrobatics across characters; within each
// regex a backreference to the opening-run capture plus `\1*`
// expresses (b) — the closing run is at least the opening length
// plus zero-or-more additional fence chars. Both opening and
// closing fences allow 0–3 leading spaces and a trailing run of
// spaces/tabs (but not newlines).
const BACKTICK_FENCE_RE =
  /^ {0,3}(`{3,})[\s\S]*?^ {0,3}\1`*[^\S\n]*$/gm;
const TILDE_FENCE_RE =
  /^ {0,3}(~{3,})[\s\S]*?^ {0,3}\1~*[^\S\n]*$/gm;
const HEADING_RE = /^(#+)\s+(.+)$/gm;
export function extractOutline(source) {
  let stripped = source.replace(BACKTICK_FENCE_RE, (block) =>
    block.replace(/[^\n]/g, ''),
  );
  stripped = stripped.replace(TILDE_FENCE_RE, (block) =>
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
