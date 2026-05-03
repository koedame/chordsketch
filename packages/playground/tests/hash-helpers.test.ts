// Unit tests for the URL-hash helpers in `packages/playground/src/main.ts`.
//
// `parseFormatHash` and `writeFormatHash` are the URL surface for
// the input-format toggle introduced in #2366. A user-visible
// regression — a deep link that does not open the iRealb editor,
// or a toggle that mangles an existing fragment — would only show
// up at runtime in the deployed playground; pinning the contract
// here keeps the round-trip honest.
//
// `main.ts` calls `mountChordSketchUi(...)` at module load time,
// which fails outside a browser-like document because it depends
// on the `@chordsketch/wasm` build artefacts. The helpers are
// therefore re-extracted into `_hash.ts` so they can be unit-
// tested in isolation; the same module is re-imported by
// `main.ts` (sharing the implementation, not duplicating it).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  parseFormatHash,
  writeFormatHash,
  type InputFormat,
} from '../src/_hash';

describe('parseFormatHash', () => {
  test('returns null for an empty hash', () => {
    expect(parseFormatHash('')).toBeNull();
    expect(parseFormatHash('#')).toBeNull();
  });

  test('reads format=chordpro and format=irealb', () => {
    expect(parseFormatHash('#format=chordpro')).toBe('chordpro');
    expect(parseFormatHash('#format=irealb')).toBe('irealb');
    expect(parseFormatHash('format=irealb')).toBe('irealb');
  });

  test('returns null for unknown format values and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseFormatHash('#format=ireal')).toBeNull();
      expect(parseFormatHash('#format=cho')).toBeNull();
      // Two unknown values → two warnings.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('returns null for non-querystring fragments without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseFormatHash('#mySection')).toBeNull();
      expect(parseFormatHash('#some/path')).toBeNull();
      // Bare anchors are not unknown format values; they are
      // simply not query-shaped, so no warning fires.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('preserves other keys and reads format alongside them', () => {
    expect(parseFormatHash('#other=1&format=chordpro')).toBe('chordpro');
    expect(parseFormatHash('#format=irealb&other=2')).toBe('irealb');
  });
});

describe('writeFormatHash', () => {
  let originalHash: string;
  beforeEach(() => {
    originalHash = window.location.hash;
  });
  afterEach(() => {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${originalHash}`);
  });

  test('writes #format=irealb on an empty hash', () => {
    window.history.replaceState(null, '', `${window.location.pathname}`);
    writeFormatHash('irealb');
    expect(window.location.hash).toBe('#format=irealb');
  });

  test('overwrites an existing format value', () => {
    window.history.replaceState(null, '', `${window.location.pathname}#format=chordpro`);
    writeFormatHash('irealb');
    expect(window.location.hash).toBe('#format=irealb');
  });

  test('preserves other query-shaped keys', () => {
    window.history.replaceState(null, '', `${window.location.pathname}#other=1`);
    writeFormatHash('chordpro');
    // `URLSearchParams` round-trip is order-stable for set after
    // get on a parsed body.
    const parsed = new URLSearchParams(window.location.hash.slice(1));
    expect(parsed.get('other')).toBe('1');
    expect(parsed.get('format')).toBe('chordpro');
  });

  test('does NOT mangle a non-querystring fragment into a key', () => {
    window.history.replaceState(null, '', `${window.location.pathname}#mySection`);
    writeFormatHash('irealb');
    // The destructive coercion would have produced `#mySection=&format=irealb`;
    // the helper instead overwrites the fragment whole because it
    // was not query-shaped to start with.
    expect(window.location.hash).toBe('#format=irealb');
    // The `mySection` key MUST NOT survive — that would be the
    // exact silent coercion the helper exists to avoid.
    expect(window.location.hash).not.toContain('mySection');
  });

  test('uses replaceState (no new history entry)', () => {
    const before = window.history.length;
    writeFormatHash('chordpro');
    writeFormatHash('irealb');
    expect(window.history.length).toBe(before);
  });

  test('round-trips with parseFormatHash for both formats', () => {
    for (const value of ['chordpro', 'irealb'] as InputFormat[]) {
      window.history.replaceState(null, '', `${window.location.pathname}`);
      writeFormatHash(value);
      expect(parseFormatHash(window.location.hash)).toBe(value);
    }
  });
});
