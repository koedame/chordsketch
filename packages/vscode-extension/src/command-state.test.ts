/**
 * Unit tests for command-state.ts.
 *
 * `command-state.ts` contains no runtime VS Code dependency (all VS Code
 * types are `import type` only), so these tests run with plain Node.js:
 *
 *   node --experimental-transform-types --test src/command-state.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandState, resetCommandSingletons } from './command-state.ts';

// ── resetCommandSingletons ────────────────────────────────────────────────────

test('resetCommandSingletons: exported and callable without throwing when all singletons are undefined', () => {
  // Default state: both fields are undefined. Reset should be a no-op.
  assert.doesNotThrow(() => resetCommandSingletons());
});

test('resetCommandSingletons: clears exportOutputChannel to undefined', () => {
  // Simulate a channel having been created by injecting a truthy value.
  commandState.exportOutputChannel = {} as never;
  resetCommandSingletons();
  assert.equal(commandState.exportOutputChannel, undefined);
});

test('resetCommandSingletons: clears wasmRenderCache to undefined', () => {
  // Simulate a cached WASM module by injecting a truthy value.
  commandState.wasmRenderCache = {} as never;
  resetCommandSingletons();
  assert.equal(commandState.wasmRenderCache, undefined);
});

test('resetCommandSingletons: clears both fields in a single call', () => {
  commandState.exportOutputChannel = {} as never;
  commandState.wasmRenderCache = {} as never;
  resetCommandSingletons();
  assert.equal(commandState.exportOutputChannel, undefined);
  assert.equal(commandState.wasmRenderCache, undefined);
});

test('resetCommandSingletons: callable multiple times without throwing', () => {
  assert.doesNotThrow(() => {
    resetCommandSingletons();
    resetCommandSingletons();
  });
});
