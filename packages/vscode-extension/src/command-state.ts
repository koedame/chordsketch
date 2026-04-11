/**
 * Module-level singleton state for the ChordSketch command handlers.
 *
 * Extracted from `commands.ts` into a separate, VS Code–free module so the
 * state lifecycle (`resetCommandSingletons`) can be exercised by unit tests
 * with plain Node.js (`--experimental-transform-types`) without requiring the
 * VS Code extension host.
 *
 * All VS Code types are referenced via `import type` so they are erased at
 * compile time and do not introduce a runtime dependency on the `vscode` module.
 */

import type { OutputChannel } from 'vscode';
import type { WasmRenderModule } from './command-utils.js';

/** Shared mutable singleton state for the convertTo command handlers. */
export const commandState: {
  /**
   * Lazily created output channel used to log full error details (WASM load
   * failures, render errors) without cluttering the user-facing notification.
   * Registered in `context.subscriptions` on creation; disposed automatically
   * by VS Code when the extension is deactivated.
   */
  exportOutputChannel: OutputChannel | undefined;

  /**
   * Lazily loaded `@chordsketch/wasm` Node.js CJS build singleton.
   * Cached after the first successful `require()` so the WASM binary is only
   * parsed once per session.
   */
  wasmRenderCache: WasmRenderModule | undefined;
} = {
  exportOutputChannel: undefined,
  wasmRenderCache: undefined,
};

/**
 * Resets all module-level singletons so that a subsequent re-activation within
 * the same VS Code host process (e.g., after `Developer: Restart Extension Host`)
 * creates fresh, properly-subscribed instances rather than reusing a disposed
 * channel or a stale WASM module cache.
 *
 * **Note on `require.cache`**: `commandState.wasmRenderCache` is set to
 * `undefined` so `loadWasmRender` will call `require()` again on next use.
 * However, Node.js's `require.cache` persists across Extension Host restarts
 * within the same VS Code process. This means the subsequent `require()` call
 * returns the in-process cached module rather than re-reading the binary from
 * disk. In practice this is harmless unless a new WASM binary was deployed
 * at the same path between restarts — in that case a full VS Code process
 * restart is required to pick up the new binary.
 *
 * Must be called from `deactivate()` in `extension.ts`.
 */
export function resetCommandSingletons(): void {
  commandState.exportOutputChannel = undefined;
  commandState.wasmRenderCache = undefined;
}
