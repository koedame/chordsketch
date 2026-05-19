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
