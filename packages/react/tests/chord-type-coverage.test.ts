// Cross-language guard for `.claude/rules/chord-diagram-coverage.md`.
//
// The editor's producible canonical suffix set (`enumerateEditorSuffixes()`,
// derived from the structured triad × seventh × tension controls — ADR-0037)
// and the Rust chord-diagram coverage test (`PALETTE_SUFFIXES` in
// `crates/chordpro/src/voicings.rs`) are a documented sister pair: the Rust
// test proves every suffix in its list yields a playable diagram on every
// instrument and root, so the editor's diagram coverage is 100% only as long
// as the two sets are exactly equal.
//
// This test fails if the editor gains or loses a producible suffix without the
// matching change to the Rust coverage list — catching the exact drift the
// rule warns about (a new chord type shipping with no diagram, or a stale
// coverage entry the editor no longer produces).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { enumerateEditorSuffixes } from '../src/chord-source-edit';

const VOICINGS_REL = 'crates/chordpro/src/voicings.rs';

/** Resolves the absolute path to the Rust voicings source by walking up from
 * the current working directory until the workspace root is found. */
function voicingsPath(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, VOICINGS_REL);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate ${VOICINGS_REL} above ${process.cwd()}`);
    }
    dir = parent;
  }
}

/** Extracts the quoted entries of the Rust `PALETTE_SUFFIXES` slice literal. */
function rustPaletteSuffixes(): Set<string> {
  const source = readFileSync(voicingsPath(), 'utf8');
  const match = source.match(/const PALETTE_SUFFIXES:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error('could not locate PALETTE_SUFFIXES in voicings.rs');
  }
  const suffixes = new Set<string>();
  // Each entry is a double-quoted string literal; "" is the bare-major suffix.
  for (const lit of match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    suffixes.add(lit[1]);
  }
  return suffixes;
}

describe('chord-type palette diagram coverage', () => {
  test('every editor-producible suffix is in the Rust coverage list', () => {
    const rust = rustPaletteSuffixes();
    const missing = enumerateEditorSuffixes().filter((text) => !rust.has(text));
    expect(
      missing,
      `These editor-producible suffixes are not covered by PALETTE_SUFFIXES in ` +
        `crates/chordpro/src/voicings.rs. Add them there (and confirm the ` +
        `chord-diagram coverage test passes) per ` +
        `.claude/rules/chord-diagram-coverage.md: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  test('the Rust coverage list has no stale suffixes the editor cannot produce', () => {
    // Keeps the two lists exactly aligned: a suffix the editor stops producing
    // should also leave the Rust list, so it does not silently rot.
    const rust = rustPaletteSuffixes();
    const producible = new Set(enumerateEditorSuffixes());
    const stale = [...rust].filter((text) => !producible.has(text));
    expect(
      stale,
      `These PALETTE_SUFFIXES entries are no longer producible by the editor; ` +
        `remove them from crates/chordpro/src/voicings.rs: ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });
});
