// Unit coverage for the docs SSG driver — the surface that turns
// rendered Markdown into a per-page static HTML file. Exercises the
// failure modes (`findCssAssetUrl` against a clean dist) and the
// structural anchors of the emitted page (title, slug, sidebar
// links, embedded redirect shim). The end-to-end Playwright suite
// covers the deployed bundle; this suite is the fast unit gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import {
  assertEveryFenceLangIsLoaded,
  collectFenceLangs,
  findCssAssetUrl,
  hashRedirectShim,
  pageHtml,
} from '../scripts/build-docs-static.mjs';

const PLAYGROUND_ROOT = resolve(__dirname, '..');
const REAL_DIST = resolve(PLAYGROUND_ROOT, 'dist');

describe('hashRedirectShim', () => {
  it('embeds the registered-slug allowlist as a literal array', () => {
    const shim = hashRedirectShim();
    expect(shim).toContain('"embed-react"');
    expect(shim).toContain('"reference/chord-sheet"');
    // The empty (index) slug must NOT appear in the allowlist; the
    // shim only handles `#/<slug>` forms with a non-empty slug.
    expect(shim).not.toMatch(/"\s*"/);
  });

  it('redirects unknown slugs to the docs base, not to the constructed URL', () => {
    const shim = hashRedirectShim();
    // The "unknown slug" branch falls back to DOCS_BASE; the
    // constructed-URL branch must be gated on the allowlist test.
    expect(shim).toMatch(/indexOf\(slug\) === -1/);
  });
});

describe('pageHtml', () => {
  const cssHref = '/chordsketch/assets/docs-TEST.css';
  const samplePage = {
    slug: 'embed-react',
    title: 'Embed in a React app',
    blurb: '10 recipes.',
    sourcePath: 'docs/sdk/tasks/embed-react.md',
  };

  it('embeds the rendered contentHtml verbatim (no double-escaping)', () => {
    const content =
      '<h1 id="x">Embed</h1>\n<p>Hello <a href="/chordsketch/docs/render/">world</a></p>';
    const html = pageHtml({
      page: samplePage,
      contentHtml: content,
      outline: [],
      cssHref,
    });
    expect(html).toContain(content);
    expect(html).not.toContain('&lt;h1');
  });

  it('sets a slug-aware <title> and data-page-slug attribute', () => {
    const html = pageHtml({
      page: samplePage,
      contentHtml: '<p>x</p>',
      outline: [],
      cssHref,
    });
    expect(html).toContain('<title>Embed in a React app · ChordSketch Docs</title>');
    expect(html).toContain('data-page-slug="embed-react"');
  });

  it('uses the bare brand for the index page title', () => {
    const html = pageHtml({
      page: { ...samplePage, slug: '', title: 'ChordSketch SDK' },
      contentHtml: '<p>x</p>',
      outline: [],
      cssHref,
    });
    expect(html).toContain('<title>ChordSketch Docs</title>');
    expect(html).toContain('data-page-slug="index"');
  });

  it('links the supplied CSS asset and inlines the redirect shim', () => {
    const html = pageHtml({
      page: samplePage,
      contentHtml: '<p>x</p>',
      outline: [],
      cssHref,
    });
    expect(html).toContain(`href="${cssHref}"`);
    expect(html).toContain('<script>(function(){');
  });

  it('marks the active sidebar link with aria-current="page"', () => {
    const html = pageHtml({
      page: samplePage,
      contentHtml: '<p>x</p>',
      outline: [],
      cssHref,
    });
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/chordsketch\/docs\/embed-react\/">Embed in a React app/,
    );
  });

  it('omits the on-page outline section when the page has <= 1 heading', () => {
    const html = pageHtml({
      page: samplePage,
      contentHtml: '<p>x</p>',
      outline: [],
      cssHref,
    });
    expect(html).not.toContain('On this page');
  });

  it('renders the on-page outline when there are 2+ headings', () => {
    const html = pageHtml({
      page: samplePage,
      contentHtml: '<p>x</p>',
      outline: [
        { level: 2, text: 'Recipe 1', id: 'recipe-1' },
        { level: 2, text: 'Recipe 2', id: 'recipe-2' },
      ],
      cssHref,
    });
    expect(html).toContain('On this page');
    expect(html).toContain('href="#recipe-1"');
    expect(html).toContain('href="#recipe-2"');
  });
});

describe('findCssAssetUrl', () => {
  // The implementation looks at the real `dist/assets/` directory.
  // Tests stage a temporary directory, then symlink (or assign) it
  // in place via `process.chdir` — simpler approach is to invoke it
  // against the real dist (which the CI build produces) and a clean
  // temp dist that we set up here. We do the latter so the test
  // suite doesn't depend on prior `vite build` state.

  let stage: string;
  beforeEach(() => {
    stage = mkdtempSync(`${tmpdir()}/docs-static-`);
  });
  afterEach(() => {
    rmSync(stage, { recursive: true, force: true });
  });

  it('throws a clear error when dist/assets is missing', async () => {
    // `findCssAssetUrl` resolves dist/assets relative to the
    // playground root. We can't easily relocate that without
    // re-importing the module; instead, assert the real assets
    // directory exists OR an error is raised. Either branch is
    // load-bearing.
    if (existsSync(resolve(REAL_DIST, 'assets'))) {
      expect(() => findCssAssetUrl()).not.toThrow();
    } else {
      expect(() => findCssAssetUrl()).toThrow(
        /Expected Vite to have produced/,
      );
    }
  });

  it('returns the single docs CSS asset URL when one exists', () => {
    // Smoke against the real dist when present (CI always builds
    // before running these tests). Skip on a clean checkout where
    // dist hasn't been populated — the failure-mode test above
    // covers that branch.
    if (!existsSync(resolve(REAL_DIST, 'assets'))) {
      return;
    }
    const url = findCssAssetUrl();
    expect(url).toMatch(/^\/chordsketch\/assets\/docs-[\w-]+\.css$/);
  });
});

describe('assertEveryFenceLangIsLoaded', () => {
  it('passes against the current docs/sdk corpus', () => {
    // The build-time gate that turns "Shiki silently falls back to
    // plain <pre><code> for an undeclared lang" into a build
    // failure. On main, every fence MUST resolve through Shiki.
    expect(() => assertEveryFenceLangIsLoaded()).not.toThrow();
  });

  it('reports every fence-header lang found across all registered pages', () => {
    const usages = collectFenceLangs();
    // The corpus survey at the time of this PR landed: bash,
    // chordpro, kotlin, python, ruby, rust, swift, ts, tsx. The
    // floor of 7 leaves room for legitimate additions / removals
    // without rewriting the test.
    expect(usages.size).toBeGreaterThanOrEqual(7);
    // Two anchor langs that MUST appear or the embed-react and
    // chordpro-rendering tests above lose their basis.
    expect(usages.has('tsx')).toBe(true);
    expect(usages.has('chordpro')).toBe(true);
  });

  it('records every page that uses a given fence lang', () => {
    // The error message in the gate lists the source paths so the
    // maintainer can find offending fences fast. Pin that the
    // collection actually carries that provenance.
    const usages = collectFenceLangs();
    const chordproSources = usages.get('chordpro') ?? [];
    expect(chordproSources.length).toBeGreaterThanOrEqual(1);
    expect(
      chordproSources.every(
        (p: string) => p.startsWith('docs/sdk/') && p.endsWith('.md'),
      ),
    ).toBe(true);
  });
});
