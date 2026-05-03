// Init-order regression suite for `mountChordSketchUi`: the editor
// factory must run after `renderers.init()` resolves so factories
// can call wasm-backed helpers from their constructor. See #2397
// and the `Renderers.init` JSDoc.

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  mountChordSketchUi,
  type EditorAdapter,
  type EditorFactory,
  type Renderers,
} from '../src/index';

interface SlowInitRenderers extends Renderers {
  /** Resolve the pending `init()` promise. */
  resolveInit: () => void;
  /** True after the resolver has fired and the microtask has flushed. */
  initFlag: { done: boolean };
}

/**
 * Build a renderer set whose `init()` returns a promise the test
 * decides when to settle. Used to prove the mount path is actually
 * waiting on init rather than racing it.
 */
function makeSlowInitRenderers(): SlowInitRenderers {
  let resolve: () => void = () => undefined;
  const flag = { done: false };
  const initPromise = new Promise<void>((r) => {
    resolve = () => {
      flag.done = true;
      r();
    };
  });
  return {
    init: vi.fn(() => initPromise),
    renderHtml: vi.fn(() => '<div class="song">HTML</div>'),
    renderText: vi.fn(() => 'TEXT'),
    renderPdf: vi.fn(() => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    resolveInit: () => resolve(),
    initFlag: flag,
  };
}

const mounted: HTMLElement[] = [];
function mountRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mounted.push(root);
  return root;
}

afterEach(() => {
  while (mounted.length > 0) {
    const root = mounted.pop();
    root?.remove();
  }
});

function makeMinimalAdapter(value: string): EditorAdapter {
  const element = document.createElement('div');
  return {
    element,
    getValue: () => value,
    setValue: () => undefined,
    onChange: () => () => undefined,
    destroy: () => undefined,
  };
}

/**
 * Yield long enough that any non-awaited synchronous code path
 * would have completed. Stronger than `await Promise.resolve()`
 * (which only flushes one microtask checkpoint) — a `setTimeout(0)`
 * round-trip drains microtasks AND the macrotask queue, so the
 * test still fails if a future refactor inserts another
 * `await` in `mountChordSketchUi` ahead of the factory call.
 */
function flushTask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('mountChordSketchUi init order', () => {
  test('createEditor runs only after renderers.init() resolves', async () => {
    const renderers = makeSlowInitRenderers();
    // Monotonic tick captured at init-resolution and factory-call
    // sites. Asserting `initTick < factoryTick` survives any future
    // internal `await` in `mountChordSketchUi` ahead of the factory
    // call — a single boolean would silently re-pass once a refactor
    // moved the factory call later but kept it before init.
    let nextTick = 0;
    let initTick: number | null = null;
    let factoryTick: number | null = null;
    const realResolve = renderers.resolveInit;
    renderers.resolveInit = (): void => {
      initTick = nextTick++;
      realResolve();
    };
    const factory: EditorFactory = (options) => {
      factoryTick = nextTick++;
      return makeMinimalAdapter(options.initialValue);
    };

    const root = mountRoot();
    const mountPromise = mountChordSketchUi(root, {
      renderers,
      createEditor: factory,
      initialChordPro: 'seed',
    });

    await flushTask();
    expect(factoryTick).toBeNull();

    renderers.resolveInit();

    const handle = await mountPromise;
    if (initTick === null || factoryTick === null) {
      throw new Error('init or factory never observed');
    }
    expect(initTick).toBeLessThan(factoryTick);
    handle.destroy();
  });

  test('factory may safely call a renderer helper during construction', async () => {
    // Stand-in for `wasm.parseIrealb`: a renderer method that
    // throws unless `init()` has resolved.
    const renderers = makeSlowInitRenderers();
    const renderHtmlImpl = renderers.renderHtml;
    renderers.renderHtml = vi.fn((input: string, options) => {
      if (!renderers.initFlag.done) {
        throw new TypeError(
          'renderHtml called before renderers.init() resolved',
        );
      }
      return renderHtmlImpl(input, options);
    });

    const factory: EditorFactory = (options) => {
      renderers.renderHtml(options.initialValue);
      return makeMinimalAdapter(options.initialValue);
    };

    const root = mountRoot();
    const mountPromise = mountChordSketchUi(root, {
      renderers,
      createEditor: factory,
      initialChordPro: 'seed',
    });

    renderers.resolveInit();
    const handle = await mountPromise;
    expect(renderers.renderHtml).toHaveBeenCalled();
    handle.destroy();
  });

  test('init() rejection propagates without ever invoking the factory', async () => {
    const initError = new Error('wasm fetch failed');
    const renderers: Renderers = {
      init: vi.fn(() => Promise.reject(initError)),
      renderHtml: vi.fn(() => ''),
      renderText: vi.fn(() => ''),
      renderPdf: vi.fn(() => new Uint8Array()),
    };

    const factory = vi.fn((): EditorAdapter => makeMinimalAdapter(''));

    const root = mountRoot();
    await expect(
      mountChordSketchUi(root, { renderers, createEditor: factory }),
    ).rejects.toBe(initError);

    expect(factory).not.toHaveBeenCalled();
  });
});
