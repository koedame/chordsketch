import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const stylesheetPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/styles.css',
);

/**
 * Read `src/styles.css` as a string for rule-presence assertions.
 *
 * jsdom does not apply CSS, so tests that need to assert a stylesheet
 * rule exists (or, in regression guards, does NOT exist) read the
 * source directly rather than computing styles on a rendered node.
 *
 * Comments are stripped by default: an explanatory comment's braces
 * (e.g. `{key}` / `{tempo}`) would otherwise terminate a `[^}]`
 * rule-block match prematurely. Pass `{ stripComments: false }` when a
 * test matches against keyframe / declaration text that cannot collide
 * with comment braces and wants the verbatim source.
 */
export function readStylesheetSource(
  options: { stripComments?: boolean } = {},
): string {
  const css = readFileSync(stylesheetPath, 'utf8');
  return options.stripComments === false
    ? css
    : css.replace(/\/\*[\s\S]*?\*\//g, '');
}
