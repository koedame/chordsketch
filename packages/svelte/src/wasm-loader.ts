/**
 * Shared lazy-load plumbing for the WebAssembly modules the
 * rune helpers drive.
 *
 * Every consumer needs the module *initialised*, and `init()` is only
 * idempotent once it has resolved — two callers that race before the
 * first init completes would each instantiate the module. Since one
 * `<ChordSheet>` alone drives two call sites (the render helper
 * and the renderer-stylesheet injection), that race is the normal
 * case, not a corner case. Caching the init *promise* per loader
 * collapses them onto one instantiation.
 *
 * The cache is keyed on the loader's identity, so the production
 * default (a module-level constant, shared by every component) inits
 * once per page, while a test that passes its own stub loader gets
 * its own entry and cannot observe another test's module.
 */

/**
 * The part of a wasm-pack module the loaders touch.
 *
 * `default` is the browser build's init function (`wasm-pack
 * --target web` exports one). The Node build (`--target nodejs`) is
 * CommonJS and instantiates the module at require time, so its
 * interop `default` is the module namespace object rather than a
 * function — hence the loose type and the `typeof` check in
 * {@link loadWasm}.
 */
interface WasmModule {
  default?: unknown;
}

const initialised = new WeakMap<object, Promise<unknown>>();

/**
 * Load and initialise a wasm module, reusing the in-flight or
 * completed init for the same `loader`. A rejected load is evicted so
 * the next call retries instead of re-throwing the same boot error
 * forever.
 */
export function loadWasm<T extends WasmModule>(loader: () => Promise<T>): Promise<T> {
  const cached = initialised.get(loader) as Promise<T> | undefined;
  if (cached !== undefined) return cached;

  const pending = (async () => {
    const mod = await loader();
    // Required on the browser build; absent on the Node build, which
    // has already instantiated the module by the time the import
    // resolves. Calling it only when it is callable keeps the
    // composables runtime-agnostic instead of throwing
    // `mod.default is not a function` under Node / jsdom.
    if (typeof mod.default === 'function') {
      await (mod.default as () => Promise<unknown>)();
    }
    return mod;
  })();
  pending.catch(() => {
    if (initialised.get(loader) === pending) initialised.delete(loader);
  });
  initialised.set(loader, pending);
  return pending;
}

/**
 * Lazy import of `@chordsketch/wasm` — the lean bundle carrying the
 * parser plus the text / HTML / SVG surface. Declared once so every
 * helper's default loader is the *same* function, and therefore
 * shares one initialisation.
 *
 * @internal
 */
export function defaultWasmLoader<T>(): Promise<T> {
  return import('@chordsketch/wasm') as unknown as Promise<T>;
}

/**
 * Lazy import of `@chordsketch/wasm-export` — the heavy bundle that
 * owns the PDF renderer. Kept separate from
 * {@link defaultWasmLoader} so a consumer that never exports never
 * downloads it.
 *
 * @internal
 */
export function defaultWasmExportLoader<T>(): Promise<T> {
  return import('@chordsketch/wasm-export') as unknown as Promise<T>;
}
