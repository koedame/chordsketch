import type { ChordRenderOptions, ChordWasmLoader } from './use-chord-render';
import { defaultWasmLoader, loadWasm } from './wasm-loader';

/**
 * Wrapper class `<ChordSheet format="html">` puts around the
 * renderer's body fragment, and the scope every rule of the
 * renderer stylesheet is rewritten under. Shared with the
 * component so the two cannot drift.
 */
export const SHEET_CONTENT_CLASS = 'chordsketch-sheet__content';

// At-rules whose body holds nested style rules (as opposed to
// declarations or keyframe selectors). Only these recurse — a
// `@keyframes` / `@font-face` body must pass through untouched or
// its keyframe selectors would be rewritten into invalid rules.
const NESTED_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope']);

// Selectors that address the document root in the renderer's
// standalone-document stylesheet. Inside a page they must become
// the scope element itself rather than a descendant of it.
const ROOT_SELECTORS = new Set(['body', 'html', ':root']);

/** Index just past a quoted string starting at `start`. */
function skipQuoted(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    if (css[i] === '\\') {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Index just past a `/* … *\/` comment starting at `start`. */
function skipComment(css: string, start: number): number {
  const end = css.indexOf('*/', start + 2);
  return end === -1 ? css.length : end + 2;
}

/**
 * Split `css` into its top-level `<prelude> { <body> }` blocks.
 * Brace counting ignores braces inside strings and comments, so a
 * declaration such as `content: "}"` does not truncate a rule.
 * Text after the last closing brace (trailing whitespace) is
 * dropped — the renderer stylesheet has no bodyless statements.
 */
function topLevelBlocks(css: string): Array<{ prelude: string; body: string }> {
  const blocks: Array<{ prelude: string; body: string }> = [];
  let i = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let depth = 0;

  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(css, i);
    } else if (ch === '/' && css[i + 1] === '*') {
      i = skipComment(css, i);
    } else if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
      i++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        blocks.push({
          prelude: css.slice(preludeStart, bodyStart - 1),
          body: css.slice(bodyStart, i),
        });
        preludeStart = i + 1;
      }
      i++;
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Drop comments from a rule prelude. A comment sitting between two
 * rules ends up attached to the following prelude, where it would be
 * carried into the rewritten selector and break the rule.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      i = skipComment(text, i);
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Split a selector list on its top-level commas. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const ch = list[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(list, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Rewrite every selector in `css` so it only matches inside
 * `scope`, and return the result.
 *
 * The renderer's stylesheet (`render_html_css`) is written for a
 * standalone document: it styles `body`, `h1`, `section`, `img`
 * and other bare element selectors. Injecting it as-is would
 * repaint the host page, so `<ChordSheet>` scopes it to its own
 * wrapper first. Document-root selectors collapse onto the scope
 * element itself; everything else becomes a descendant of it.
 *
 * ```ts
 * scopeCss('body { margin: 0 } .chord { color: red }', '.sheet');
 * // => '.sheet { margin: 0 }\n.sheet .chord { color: red }'
 * ```
 */
export function scopeCss(css: string, scope: string): string {
  return topLevelBlocks(css)
    .map(({ prelude, body }) => {
      const head = stripComments(prelude).trim();
      if (head.startsWith('@')) {
        const name = head.slice(1).split(/[\s({]/, 1)[0].toLowerCase();
        return NESTED_AT_RULES.has(name)
          ? `${head} { ${scopeCss(body, scope)} }`
          : `${head} {${body}}`;
      }
      const selectors = splitSelectors(head)
        .map((sel) => (ROOT_SELECTORS.has(sel) ? scope : `${scope} ${sel}`))
        .join(', ');
      return `${selectors} {${body}}`;
    })
    .join('\n');
}

// Stylesheets already appended to the document, keyed by their
// (scoped) text. Two `<ChordSheet>`s rendering the same config
// share one `<style>` element; a config that changes the
// stylesheet (`settings.wraplines`) appends a second one. The
// elements live for the document's lifetime — they are page-level
// styles, not per-instance ones, and re-adding them on every mount
// would churn the CSSOM.
const injected = new Set<string>();

/** @internal Test-only — forget which stylesheets were injected. */
export function __resetInjectedCss(): void {
  injected.clear();
}

/**
 * Append `css` to `document.head` unless an identical stylesheet is
 * already there. No-ops when there is no document (SSR).
 */
export function injectCss(css: string): void {
  if (typeof document === 'undefined') return;
  if (injected.has(css)) return;
  injected.add(css);
  const style = document.createElement('style');
  style.setAttribute('data-chordsketch-vue', 'renderer-css');
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Load the renderer stylesheet that matches `options`, scope it to
 * `scope`, and inject it once.
 *
 * Resolves without injecting anything when the loaded
 * `@chordsketch/wasm` bundle exposes no stylesheet export, or when
 * the load fails — a missing stylesheet leaves the fragment
 * unstyled, which is a degraded but working preview, and the
 * render error itself is already surfaced by
 * {@link useChordRender}.
 */
export async function ensureRendererCss(
  options: ChordRenderOptions,
  loader: ChordWasmLoader = defaultWasmLoader,
  scope = `.${SHEET_CONTENT_CLASS}`,
): Promise<void> {
  try {
    const mod = await loadWasm(loader);
    const css =
      options.config !== undefined && mod.render_html_css_with_options
        ? mod.render_html_css_with_options(options)
        : mod.render_html_css?.();
    if (typeof css === 'string' && css.length > 0) {
      injectCss(scopeCss(css, scope));
    }
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}
