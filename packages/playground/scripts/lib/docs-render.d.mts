export interface DocPage {
  slug: string;
  title: string;
  blurb: string;
  sourcePath: string;
}

export interface DocGroup {
  label: string;
  pages: readonly DocPage[];
}

export interface OutlineEntry {
  level: 2 | 3;
  text: string;
  id: string;
}

export const DOC_GROUPS: readonly DocGroup[];
export const DOCS_BASE: string;
export const REPO_BLOB_BASE: string;
export const REGISTERED_SLUGS: readonly string[];

export function findPage(slug: string): DocPage | undefined;
export function allPages(): DocPage[];

export function isSafeHref(href: string | null): boolean;
export function isExternalHttpHref(href: string): boolean;

export function slugify(text: string): string;
export function slugifyWithCounter(
  text: string,
  counters: Map<string, number>,
): string;

export function cleanUrlFor(slug: string, hashSuffix?: string): string;
export function rewriteHref(href: string, sourceDir: string): string;

export function renderMarkdown(source: string, sourcePath?: string): string;
export function extractOutline(source: string): OutlineEntry[];

export function highlightCodeBlock(code: string, lang: string): string;
export function resolveShikiLang(lang: string): string | null;
