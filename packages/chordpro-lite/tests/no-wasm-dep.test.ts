import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Policy test for ADR-0060: @chordsketch/chordpro-lite is the helper
// layer a consumer can use before — or instead of — loading the engine.
// It must never acquire a dependency on @chordsketch/wasm or
// @chordsketch/wasm-export, which would defeat the reason it exists.
// The package has no runtime dependencies at all, so this also asserts
// that `dependencies` stays empty.

const here = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(here, '../package.json');

const WASM_PATTERN = /^@chordsketch\/wasm/;
const DEP_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
] as const;

type Manifest = Record<string, Record<string, string> | undefined>;

function manifest(): Manifest {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8')) as Manifest;
}

describe('@chordsketch/chordpro-lite is wasm-free (ADR-0060)', () => {
  test('no @chordsketch/wasm* appears in any dependency field of package.json', () => {
    const pkg = manifest();
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

  test('the package declares no runtime dependencies at all', () => {
    const pkg = manifest();
    expect(Object.keys(pkg['dependencies'] ?? {})).toEqual([]);
    expect(Object.keys(pkg['peerDependencies'] ?? {})).toEqual([]);
    expect(Object.keys(pkg['optionalDependencies'] ?? {})).toEqual([]);
  });
});
