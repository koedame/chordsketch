import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Policy test for ADR-0029: @chordsketch/react-ui is the wasm-free
// design-system primitive layer. It must never acquire a dependency on
// @chordsketch/wasm or @chordsketch/wasm-export — that coupling would
// break every consumer that cannot (or does not want to) load wasm.
// This asserts the invariant at the manifest level so a stray dependency
// edit fails loudly instead of silently regressing the package.

const here = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(here, '../package.json');

const WASM_PATTERN = /^@chordsketch\/wasm/;
const DEP_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
] as const;

describe('@chordsketch/react-ui is wasm-free (ADR-0029)', () => {
  test('no @chordsketch/wasm* appears in any dependency field of package.json', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const violations: string[] = [];
    for (const field of DEP_FIELDS) {
      const deps = pkg[field] ?? {};
      for (const name of Object.keys(deps)) {
        if (WASM_PATTERN.test(name)) {
          violations.push(`${field}.${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
