// Sister-site behaviour parity with `@chordsketch/react`'s
// `chord-source-edit.ts`. The helpers in `capo-edit.ts` are a
// deliberate copy (see the file header for the rationale); this
// test pins the observable behaviour so a future tweak in the
// React package fails CI here if not propagated.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPO_MAX, CAPO_MIN, readCapo, setCapoInSource } from './capo-edit.ts';

test('CAPO_MIN / CAPO_MAX match the playground toolbar range', () => {
  assert.equal(CAPO_MIN, 0);
  assert.equal(CAPO_MAX, 12);
});

test('readCapo returns 0 for missing / negative / non-numeric directive', () => {
  assert.equal(readCapo(''), 0);
  assert.equal(readCapo('{title: Demo}\n[C]Hello'), 0);
  assert.equal(readCapo('{capo: -3}\n[C]Hello'), 0);
  assert.equal(readCapo('{capo: }\n[C]Hello'), 0);
});

test('readCapo parses + clamps positive values into [0, 12]', () => {
  assert.equal(readCapo('{capo: 5}\nlyrics'), 5);
  assert.equal(readCapo('{capo: 99}\nlyrics'), CAPO_MAX);
});

test('setCapoInSource updates an existing directive in place', () => {
  assert.equal(
    setCapoInSource('{title: Demo}\n{capo: 2}\n[C]Hello', 5),
    '{title: Demo}\n{capo: 5}\n[C]Hello',
  );
});

test('setCapoInSource(0) removes the directive (including trailing newline)', () => {
  assert.equal(
    setCapoInSource('{title: Demo}\n{capo: 2}\n[C]Hello', 0),
    '{title: Demo}\n[C]Hello',
  );
});

test('setCapoInSource inserts after the metadata anchor when no directive exists', () => {
  assert.equal(
    setCapoInSource('{title: Demo}\n{key: G}\n[C]Hello', 4),
    '{title: Demo}\n{key: G}\n{capo: 4}\n[C]Hello',
  );
});

test('setCapoInSource inserts at start when no anchor exists', () => {
  assert.equal(setCapoInSource('[C]Hello', 3), '{capo: 3}\n[C]Hello');
});

test('setCapoInSource clamps capo into [CAPO_MIN, CAPO_MAX] before writing', () => {
  assert.equal(setCapoInSource('[C]Hi', 99), '{capo: 12}\n[C]Hi');
  assert.equal(setCapoInSource('[C]Hi', -5), '[C]Hi');
});

test('round-trip: setCapoInSource then readCapo returns the input', () => {
  const source = '{title: Demo}\n{key: D}\n[C]Hello';
  for (const value of [0, 1, 5, 7, 12]) {
    assert.equal(readCapo(setCapoInSource(source, value)), value);
  }
});
