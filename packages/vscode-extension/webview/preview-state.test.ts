/**
 * Unit tests for the pure helpers in `preview-state.ts`.
 *
 * Run with:
 *   npm test
 *   node --experimental-transform-types --test webview/preview-state.test.ts
 *
 * The WebView's `preview.tsx` cannot be exercised directly in this harness
 * because its module top-level calls `acquireVsCodeApi()` and `createRoot()`,
 * neither of which exists outside the VS Code WebView. The pure helpers
 * extracted here are the unit-testable surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  formatError,
  isExtToWebview,
  safeGetState,
  safeGetStateWithDiagnostics,
} from './preview-state.ts';

// --- isExtToWebview ---

test('isExtToWebview: rejects non-object inputs', () => {
  assert.equal(isExtToWebview(null), false);
  assert.equal(isExtToWebview(undefined), false);
  assert.equal(isExtToWebview(42), false);
  assert.equal(isExtToWebview('update'), false);
  assert.equal(isExtToWebview(true), false);
});

test('isExtToWebview: rejects { type: "update" } without text', () => {
  assert.equal(isExtToWebview({ type: 'update' }), false);
});

test('isExtToWebview: rejects { type: "update" } with non-string text', () => {
  assert.equal(isExtToWebview({ type: 'update', text: 42 }), false);
  assert.equal(isExtToWebview({ type: 'update', text: null }), false);
});

test('isExtToWebview: accepts { type: "update", text: "..." }', () => {
  assert.equal(isExtToWebview({ type: 'update', text: '' }), true);
  assert.equal(isExtToWebview({ type: 'update', text: '{title: T}' }), true);
});

test('isExtToWebview: rejects { type: "transpose" } with delta: 2', () => {
  assert.equal(isExtToWebview({ type: 'transpose', delta: 2 }), false);
});

test('isExtToWebview: rejects { type: "transpose" } with delta: 0', () => {
  assert.equal(isExtToWebview({ type: 'transpose', delta: 0 }), false);
});

test('isExtToWebview: rejects { type: "transpose" } with string delta', () => {
  assert.equal(isExtToWebview({ type: 'transpose', delta: '1' }), false);
});

test('isExtToWebview: rejects { type: "transpose" } without delta', () => {
  assert.equal(isExtToWebview({ type: 'transpose' }), false);
});

test('isExtToWebview: accepts { type: "transpose", delta: 1 }', () => {
  assert.equal(isExtToWebview({ type: 'transpose', delta: 1 }), true);
});

test('isExtToWebview: accepts { type: "transpose", delta: -1 }', () => {
  assert.equal(isExtToWebview({ type: 'transpose', delta: -1 }), true);
});

test('isExtToWebview: rejects unknown type', () => {
  assert.equal(isExtToWebview({ type: 'unknown' }), false);
  assert.equal(isExtToWebview({ type: 'ready' }), false);
});

// --- safeGetState ---

test('safeGetState: null input returns {}', () => {
  assert.deepEqual(safeGetState(null), {});
});

test('safeGetState: undefined input returns {}', () => {
  assert.deepEqual(safeGetState(undefined), {});
});

test('safeGetState: non-object input returns {}', () => {
  assert.deepEqual(safeGetState('html'), {});
  assert.deepEqual(safeGetState(42), {});
});

test('safeGetState: valid input passes through', () => {
  const state = {
    transpose: 2,
    documentUri: 'file:///tmp/song.cho',
  };
  assert.deepEqual(safeGetState(state), {
    transpose: 2,
    documentUri: 'file:///tmp/song.cho',
  });
});

test('safeGetState: non-finite transpose is omitted', () => {
  assert.deepEqual(safeGetState({ transpose: Number.NaN }), {});
  assert.deepEqual(safeGetState({ transpose: Number.POSITIVE_INFINITY }), {});
  assert.deepEqual(safeGetState({ transpose: Number.NEGATIVE_INFINITY }), {});
});

test('safeGetState: non-number transpose is omitted', () => {
  assert.deepEqual(safeGetState({ transpose: '2' }), {});
  assert.deepEqual(safeGetState({ transpose: null }), {});
});

test('safeGetState: out-of-range transpose is clamped', () => {
  assert.deepEqual(safeGetState({ transpose: 99 }), { transpose: 11 });
  assert.deepEqual(safeGetState({ transpose: -99 }), { transpose: -11 });
});

test('safeGetState: boundary transpose values preserved', () => {
  assert.deepEqual(safeGetState({ transpose: 11 }), { transpose: 11 });
  assert.deepEqual(safeGetState({ transpose: -11 }), { transpose: -11 });
  assert.deepEqual(safeGetState({ transpose: 0 }), { transpose: 0 });
});

test('safeGetState: empty documentUri is omitted', () => {
  assert.deepEqual(safeGetState({ documentUri: '' }), {});
});

test('safeGetState: non-string documentUri is omitted', () => {
  assert.deepEqual(safeGetState({ documentUri: 42 }), {});
  assert.deepEqual(safeGetState({ documentUri: null }), {});
});

test('safeGetState: extra unknown fields are dropped', () => {
  const state = { transpose: 1, extraField: 'ignored', __proto__: { nope: true } };
  assert.deepEqual(safeGetState(state), { transpose: 1 });
});

// --- safeGetStateWithDiagnostics ---

test('safeGetStateWithDiagnostics: null input is not corrupt', () => {
  const result = safeGetStateWithDiagnostics(null);
  assert.deepEqual(result.state, {});
  assert.equal(result.corrupt, false);
});

test('safeGetStateWithDiagnostics: undefined input is not corrupt', () => {
  const result = safeGetStateWithDiagnostics(undefined);
  assert.deepEqual(result.state, {});
  assert.equal(result.corrupt, false);
});

test('safeGetStateWithDiagnostics: valid input is not corrupt', () => {
  const result = safeGetStateWithDiagnostics({ transpose: 1 });
  assert.deepEqual(result.state, { transpose: 1 });
  assert.equal(result.corrupt, false);
});

test('safeGetStateWithDiagnostics: object with only invalid fields is corrupt', () => {
  const result = safeGetStateWithDiagnostics({
    transpose: Number.NaN,
    documentUri: '',
  });
  assert.deepEqual(result.state, {});
  assert.equal(result.corrupt, true);
});

test('safeGetStateWithDiagnostics: empty object is corrupt', () => {
  const result = safeGetStateWithDiagnostics({});
  assert.deepEqual(result.state, {});
  assert.equal(result.corrupt, true);
});

test('safeGetStateWithDiagnostics: partially valid input is not corrupt', () => {
  const result = safeGetStateWithDiagnostics({
    transpose: 3,
    documentUri: '', // invalid
  });
  assert.deepEqual(result.state, { transpose: 3 });
  assert.equal(result.corrupt, false);
});

// --- clamp ---

test('clamp: value at lower bound is returned unchanged', () => {
  assert.equal(clamp(-11, -11, 11), -11);
});

test('clamp: value at upper bound is returned unchanged', () => {
  assert.equal(clamp(11, -11, 11), 11);
});

test('clamp: mid-range value is returned unchanged', () => {
  assert.equal(clamp(0, -11, 11), 0);
  assert.equal(clamp(5, -11, 11), 5);
});

test('clamp: below lower bound is clamped up', () => {
  assert.equal(clamp(-50, -11, 11), -11);
});

test('clamp: above upper bound is clamped down', () => {
  assert.equal(clamp(50, -11, 11), 11);
});

test('clamp: lower > upper edge case follows Math.min / Math.max', () => {
  // When lo > hi, `Math.max(lo, Math.min(hi, n))` returns `lo` regardless
  // of `n`: the inner `Math.min(hi, n)` is at most `hi`, then the outer
  // `Math.max(lo, ...)` lifts the value back up to `lo`. Documented here
  // for callers that might accidentally pass a degenerate range — the
  // function does not throw, it returns the (now-meaningless) lower
  // bound.
  assert.equal(clamp(5, 10, 0), 10);
  assert.equal(clamp(-50, 10, 0), 10);
  assert.equal(clamp(50, 10, 0), 10);
});

// --- formatError ---

test('formatError: Error instance returns .message', () => {
  const err = new Error('boom');
  assert.equal(formatError(err), 'boom');
});

test('formatError: subclass of Error returns .message', () => {
  class MyError extends Error {}
  const err = new MyError('subclass boom');
  assert.equal(formatError(err), 'subclass boom');
});

test('formatError: string returns String(e)', () => {
  assert.equal(formatError('plain string'), 'plain string');
});

test('formatError: number returns String(e)', () => {
  assert.equal(formatError(42), '42');
});

test('formatError: null returns "null"', () => {
  assert.equal(formatError(null), 'null');
});

test('formatError: undefined returns "undefined"', () => {
  assert.equal(formatError(undefined), 'undefined');
});

test('formatError: plain object falls back to String(e)', () => {
  assert.equal(formatError({ code: 1 }), '[object Object]');
});

test('formatError: object with custom toString uses it', () => {
  const obj = {
    toString() {
      return 'custom-string';
    },
  };
  assert.equal(formatError(obj), 'custom-string');
});
