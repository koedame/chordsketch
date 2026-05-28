// Static-site generator for the docs route. See ADR-0021.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOC_GROUPS,
  DOCS_BASE,
  REGISTERED_SLUGS,
  cleanUrlFor,
  extractOutline,
  renderMarkdown,
  resolveShikiLang,
} from './lib/docs-render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PLAYGROUND_ROOT = resolve(here, '..');
const REPO_ROOT = resolve(PLAYGROUND_ROOT, '../..');
const DIST_DIR = resolve(PLAYGROUND_ROOT, 'dist');
const DOCS_OUT_DIR = resolve(DIST_DIR, 'docs');

const SITE_BASE = '/chordsketch/';
const ASSETS_DIR = resolve(PLAYGROUND_ROOT, 'dist/assets');

// Inlined to keep the static pages zero-JS-asset. The slug allowlist
// is baked in at build time so an attacker-supplied
// `/chordsketch/docs/#/../../evil` cannot push the user out of the
// docs section — unknown slugs fall back to the docs index.
function hashRedirectShim() {
  const allowlist = JSON.stringify(
    REGISTERED_SLUGS.filter((s) => s !== ''),
  );
  return `
(function(){
  var h = window.location.hash;
  if (typeof h !== 'string' || !h.startsWith('#/')) return;
  var slug = h.slice(2).replace(/\\/$/, '').split('?')[0].split('#')[0];
  var ok = ${allowlist};
  if (!slug || ok.indexOf(slug) === -1) {
    window.location.replace('${DOCS_BASE}');
    return;
  }
  window.location.replace('${DOCS_BASE}' + slug + '/');
})();`.trim();
}

function escapeText(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function sidebarHtml(activeSlug) {
  const groups = DOC_GROUPS.map((group) => {
    const items = group.pages
      .map((page) => {
        const isActive = page.slug === activeSlug;
        const href = cleanUrlFor(page.slug);
        const cls = isActive ? 'docs-nav-link is-active' : 'docs-nav-link';
        const curr = isActive ? ' aria-current="page"' : '';
        return `<li><a class="${cls}"${curr} href="${href}">${escapeText(page.title)}</a></li>`;
      })
      .join('');
    return `<section class="docs-nav-group"><h2 class="docs-nav-group-label">${escapeText(group.label)}</h2><ul class="docs-nav-list">${items}</ul></section>`;
  }).join('');
  return `<nav class="docs-nav">${groups}</nav>`;
}

function outlineHtml(outline) {
  if (outline.length <= 1) return '';
  const items = outline
    .map(
      (entry) =>
        `<li class="${entry.level === 3 ? 'is-level-3' : 'is-level-2'}"><a class="docs-outline-link" href="#${escapeAttribute(entry.id)}">${escapeText(entry.text)}</a></li>`,
    )
    .join('');
  return `<nav class="docs-outline" aria-label="On this page"><h2 class="docs-outline-label">On this page</h2><ul class="docs-outline-list">${items}</ul></nav>`;
}

function topbarHtml() {
  return `<header class="docs-topbar">
  <a class="docs-brand" href="${SITE_BASE}">
    <span class="docs-brand-mark" aria-hidden="true"></span>
    <span class="docs-brand-text">ChordSketch <span class="docs-brand-section">Docs</span></span>
  </a>
  <nav class="docs-topnav" aria-label="Site sections">
    <a class="docs-topnav-link" href="${SITE_BASE}">Home</a>
    <a class="docs-topnav-link" href="${SITE_BASE}chordpro/">ChordPro</a>
    <a class="docs-topnav-link" href="${SITE_BASE}irealpro/">iReal Pro</a>
    <a class="docs-topnav-link is-current" href="${DOCS_BASE}" aria-current="page">Docs</a>
    <a class="docs-topnav-link" href="https://github.com/koedame/chordsketch" target="_blank" rel="noreferrer noopener">GitHub</a>
  </nav>
</header>`;
}

// Vite content-hashes the docs CSS at build time and we can't predict
// the hash. Scan the assets directory for the docs entry's CSS rather
// than regex-parsing the just-built HTML — the regex would silently
// pick the wrong file if a future plugin injects another stylesheet
// link ahead of the docs entry's.
function findCssAssetUrl() {
  if (!existsSync(ASSETS_DIR)) {
    throw new Error(
      `Expected Vite to have produced ${ASSETS_DIR}; run \`vite build\` first.`,
    );
  }
  const candidates = readdirSync(ASSETS_DIR).filter(
    (f) => f.startsWith('docs-') && f.endsWith('.css'),
  );
  if (candidates.length === 0) {
    throw new Error(
      `No docs-*.css file under ${ASSETS_DIR}; Vite did not emit the docs entry's CSS.`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple docs-*.css candidates under ${ASSETS_DIR} (${candidates.join(', ')}); ambiguous.`,
    );
  }
  return `${SITE_BASE}assets/${candidates[0]}`;
}

function pageHtml({ page, contentHtml, outline, cssHref }) {
  const titleText =
    page.slug === '' ? 'ChordSketch Docs' : `${page.title} · ChordSketch Docs`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="${SITE_BASE}favicon.svg" />
  <title>${escapeText(titleText)}</title>
  <meta name="description" content="${escapeAttribute(page.blurb)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" />
  <link rel="stylesheet" href="${cssHref}" />
  <script>${hashRedirectShim()}</script>
</head>
<body>
  <div class="docs-shell">
    ${topbarHtml()}
    <div class="docs-body">
      <aside class="docs-sidebar" aria-label="Documentation navigation">
        ${sidebarHtml(page.slug)}
        ${outlineHtml(outline)}
      </aside>
      <main class="docs-content" id="docs-content">
        <article class="docs-article" data-page-slug="${page.slug === '' ? 'index' : escapeAttribute(page.slug)}">
          <div class="docs-prose">${contentHtml}</div>
        </article>
      </main>
    </div>
  </div>
</body>
</html>
`;
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function renderOnePage({ page, cssHref }) {
  const sourceFile = resolve(REPO_ROOT, page.sourcePath);
  const source = readFileSync(sourceFile, 'utf8');
  const contentHtml = renderMarkdown(source, page.sourcePath);
  const outline = extractOutline(source);
  const html = pageHtml({ page, contentHtml, outline, cssHref });
  const outFile =
    page.slug === ''
      ? resolve(DOCS_OUT_DIR, 'index.html')
      : resolve(DOCS_OUT_DIR, page.slug, 'index.html');
  ensureDir(dirname(outFile));
  writeFileSync(outFile, html);
  return outFile;
}

// CommonMark fence opening: 0–3 leading spaces, then a run of 3+
// backticks OR 3+ tildes, then an optional info-string starting
// with the lang. Horizontal whitespace (`[ \t]*`) between the fence
// chars and the lang is allowed — but NOT newlines, otherwise a
// closing fence followed by prose like ` ```\n\nReturns a song. `
// would consume the newlines via `\s*` and match `Returns` as a
// fence lang. Closing fences (no info string) are excluded by the
// `([A-Za-z0-9_+\-]+)` capture requiring at least one identifier
// character. The `m` flag anchors `^` at line start; the
// character-class `+` is linear in input length (no ReDoS surface).
const FENCE_OPEN_RE =
  /^ {0,3}(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+\-]+)/gm;

/**
 * Walk every registered docs page, collect every fence-header lang,
 * and return a `lang → sourcePath[]` map. Both backtick and tilde
 * fences are matched per CommonMark §4.5 (Fenced code blocks).
 */
export function collectFenceLangs() {
  const usages = new Map(); // lang → [sourcePath, ...]
  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
      const sourceFile = resolve(REPO_ROOT, page.sourcePath);
      const source = readFileSync(sourceFile, 'utf8');
      for (const match of source.matchAll(FENCE_OPEN_RE)) {
        const lang = match[1];
        const list = usages.get(lang) ?? [];
        if (!list.includes(page.sourcePath)) list.push(page.sourcePath);
        usages.set(lang, list);
      }
    }
  }
  return usages;
}

/**
 * Throws when the supplied `lang → sourcePath[]` map contains any
 * fence header that does not resolve through `resolveShikiLang`.
 * Split out from `assertEveryFenceLangIsLoaded` so unit tests can
 * exercise the negative branch (mutation E in the round-1 review:
 * collapsing the predicate to `if (false)` had no failing test on
 * the live corpus).
 */
export function validateFenceLangs(usages) {
  const missing = [];
  for (const [lang, sources] of usages) {
    if (resolveShikiLang(lang) === null) {
      missing.push({ lang, sources });
    }
  }
  if (missing.length > 0) {
    const lines = missing
      .map(
        ({ lang, sources }) =>
          `  - \`\`\`${lang}\`\`\` used in: ${sources.join(', ')}`,
      )
      .join('\n');
    throw new Error(
      `build-docs-static: ${missing.length} fence language(s) used in ` +
        `docs/sdk/ are not loaded by Shiki:\n${lines}\n\n` +
        `Add the lang to SHIKI_LANGS (or to SHIKI_LANG_ALIASES with a ` +
        `loaded target) in packages/playground/scripts/lib/docs-render.mjs.`,
    );
  }
}

/**
 * Build-time gate: scan every page, then validate every collected
 * fence lang. Called from `main` so the build aborts before any
 * HTML is written. Turns "silent fallback to plain `<pre><code>`"
 * into a loud build failure.
 */
export function assertEveryFenceLangIsLoaded() {
  const usages = collectFenceLangs();
  validateFenceLangs(usages);
  return usages;
}

function main() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(`Missing ${DIST_DIR}; run \`vite build\` first.`);
  }
  // Fail-fast: if any docs page introduces a fence header Shiki
  // doesn't know about, the build aborts before we write any HTML.
  assertEveryFenceLangIsLoaded();
  const cssHref = findCssAssetUrl();
  let written = 0;
  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
      try {
        renderOnePage({ page, cssHref });
        written++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `build-docs-static: failed rendering slug=${JSON.stringify(page.slug)} sourcePath=${JSON.stringify(page.sourcePath)}: ${message}`,
          { cause: err },
        );
      }
    }
  }
  console.log(
    `build-docs-static: wrote ${written} static docs pages under ${DOCS_OUT_DIR}.`,
  );
}

// Only run when invoked directly as a script. Tests import the
// helpers below without triggering a build.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Exported only for the vitest suite so the failure modes
// (`findCssAssetUrl` on a missing dist, etc.) can be exercised
// without spawning a second `vite build`.
export { findCssAssetUrl, hashRedirectShim, pageHtml, sidebarHtml };
