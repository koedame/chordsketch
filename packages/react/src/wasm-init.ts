/**
 * The part of a lazily-imported wasm-pack module every hook touches
 * before calling an export.
 */
export interface WasmInitModule {
  /**
   * The browser build's init function — present only there. See
   * {@link initWasm} for why this is `unknown` rather than a signature.
   */
  default?: unknown;
}

/**
 * Initialise a freshly imported wasm-pack module, if it needs it.
 *
 * `wasm-pack --target web` exports its init as `default`, and every
 * other export throws until that promise resolves. `wasm-pack --target
 * nodejs` emits CommonJS that instantiates the module at require time
 * and exports no init at all — under ESM interop `default` is then the
 * module namespace object, so calling it throws `mod.default is not a
 * function`. Since the hooks funnel that through their `error` state,
 * an unconditional call left every consumer running on Node, in SSR, or
 * under jsdom with a permanently failed preview.
 *
 * Calling init only when it is callable keeps the hooks
 * runtime-agnostic. Sister sites: `loadWasm` in
 * `packages/vue/src/wasm-loader.ts` and
 * `packages/svelte/src/wasm-loader.ts`.
 *
 * @internal
 */
export async function initWasm(mod: WasmInitModule): Promise<void> {
  if (typeof mod.default === 'function') {
    await (mod.default as () => Promise<unknown>)();
  }
}
