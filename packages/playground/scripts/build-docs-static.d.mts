import type { DocPage, OutlineEntry } from './lib/docs-render.mjs';

export function findCssAssetUrl(): string;
export function hashRedirectShim(): string;
export function sidebarHtml(activeSlug: string): string;
export function pageHtml(args: {
  page: DocPage;
  contentHtml: string;
  outline: OutlineEntry[];
  cssHref: string;
}): string;

/** Map of `lang` → list of `sourcePath`s that opened a fence with
 *  that header. Used by `assertEveryFenceLangIsLoaded` and exported
 *  for tests. */
export function collectFenceLangs(): Map<string, string[]>;

/** Throws when any fence header in the docs corpus does not
 *  resolve through `resolveShikiLang`. Called from `main` so the
 *  build aborts before any HTML is written. */
export function assertEveryFenceLangIsLoaded(): Map<string, string[]>;
