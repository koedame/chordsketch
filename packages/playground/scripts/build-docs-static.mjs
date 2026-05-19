// Static-site generator for the docs route.
//
// Runs after `vite build` finishes; reads the canonical Markdown
// sources under `docs/sdk/`, renders each through the shared pipeline
// in `lib/docs-render.mjs`, and writes one static HTML file per page
// into `dist/docs/<slug>/index.html` so every page is reachable at a
// clean URL (e.g. `/chordsketch/docs/embed-react/`) with no
// JavaScript dependency.
//
// The original hash-routed SPA at `dist/docs/index.html` is overwritten
// by the static index here; legacy `#/<slug>` URLs land on the static
// index, which carries a tiny inline shim that redirects to the
// matching clean URL.
//
// Architecture: ADR-0021.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOC_GROUPS,
  DOCS_BASE,
  cleanUrlFor,
  extractOutline,
  renderMarkdown,
} from './lib/docs-render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PLAYGROUND_ROOT = resolve(here, '..');
const REPO_ROOT = resolve(PLAYGROUND_ROOT, '../..');
const DIST_DIR = resolve(PLAYGROUND_ROOT, 'dist');
const DOCS_OUT_DIR = resolve(DIST_DIR, 'docs');

const SITE_BASE = '/chordsketch/';

// Legacy hash URLs (from the SPA era, e.g. shared bookmarks) redirect
// to the matching clean URL on every page load. Inlined so the static
// pages have zero JS asset dependencies.
const HASH_REDIRECT_SHIM = `
(function(){
  var h = window.location.hash;
  if (typeof h !== 'string' || !h.startsWith('#/')) return;
  var slug = h.slice(2).replace(/\\/$/, '').split('?')[0];
  if (!slug) { window.location.replace('${DOCS_BASE}'); return; }
  window.location.replace('${DOCS_BASE}' + slug + '/');
})();`.trim();

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

function findCssAssetUrl() {
  const viteHtml = resolve(DOCS_OUT_DIR, 'index.html');
  if (!existsSync(viteHtml)) {
    throw new Error(
      `Expected Vite to have produced ${viteHtml}; run \`vite build\` first.`,
    );
  }
  const html = readFileSync(viteHtml, 'utf8');
  const m = html.match(/href="([^"]+\.css)"/);
  if (m === null) {
    throw new Error(
      'Could not find a CSS asset href in the Vite-built docs/index.html.',
    );
  }
  return m[1];
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
  <script>${HASH_REDIRECT_SHIM}</script>
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

function main() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(`Missing ${DIST_DIR}; run \`vite build\` first.`);
  }
  const cssHref = findCssAssetUrl();
  let written = 0;
  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
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
      written++;
    }
  }
  console.log(
    `build-docs-static: wrote ${written} static docs pages under ${DOCS_OUT_DIR}.`,
  );
}

main();
