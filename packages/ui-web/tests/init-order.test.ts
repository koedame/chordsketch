// Init-order regression suite for the contract documented on
// `Renderers.init` and `EditorFactory`: the mount-time editor
// factory MUST run after `renderers.init()` resolves, so a factory
// is free to call into wasm-backed helpers from the same renderer
// bundle (`parseIrealb` in the iRealb bar-grid editor, future
// tree-sitter / wasm grammars in alternative ChordPro editors)
// during construction.
//
// Pre-#2397 the mount path called `createEditor` synchronously and
// only awaited init afterward. The iRealb factory threw a
// `__wbindgen_free` undefined TypeError because `parseIrealb` was
// invoked against an uninitialised wasm module, which silently
// prevented the editor from mounting in the playground and the
// desktop app — neither suite caught it because both ui-web's
// existing tests and `ui-irealb-editor`'s suite use synchronous
// stubs that never observe the race.
//
// These assertions are intentionally adversarial: every helper
// here is structured to fail fast if the historical order ever
// returns. A green run of this file is part of the contract.

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

describe('mountChordSketchUi init order', () => {
  test('createEditor runs only after renderers.init() resolves', async () => {
    const renderers = makeSlowInitRenderers();
    let initFlagAtFactory: boolean | null = null;
    const factory: EditorFactory = (options) => {
      // The contract under test: by the time the factory is
      // invoked, `renderers.init()` must have resolved.
      initFlagAtFactory = renderers.initFlag.done;
      return makeMinimalAdapter(options.initialValue);
    };

    const root = mountRoot();
    const mountPromise = mountChordSketchUi(root, {
      renderers,
      createEditor: factory,
      initialChordPro: 'seed',
    });

    // Yield several microtasks so any non-awaited synchronous
    // factory call would have already fired. The factory MUST
    // still be unobserved at this point.
    await Promise.resolve();
    await Promise.resolve();
    expect(initFlagAtFactory).toBeNull();

    renderers.resolveInit();

    const handle = await mountPromise;
    expect(initFlagAtFactory).toBe(true);
    handle.destroy();
  });

  test('factory may safely call a renderer helper during construction', async () => {
    // Stand-in for `wasm.parseIrealb`: a method on `renderers` that
    // throws unless `init()` has resolved. Pre-#2397 the iRealb
    // factory tripped this exact pattern against the real wasm
    // bundle.
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
      // The factory exercises the renderer helper synchronously —
      // exactly the shape the iRealb adapter follows with
      // `wasm.parseIrealb`. With the contract honoured this is a
      // no-throw call; without it the entire mount rejects.
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
    // Symmetric guarantee: a failing init must NOT degrade to
    // calling the factory anyway. Pre-#2397 the factory would have
    // run regardless because the mount sequence ignored init's
    // outcome until later in the function.
    const initError = new Error('wasm fetch failed');
    const renderers: Renderers = {
      init: vi.fn(() => Promise.reject(initError)),
      renderHtml: vi.fn(() => ''),
      renderText: vi.fn(() => ''),
      renderPdf: vi.fn(() => new Uint8Array()),
    };

    const factory = vi.fn<EditorFactory>(() => makeMinimalAdapter(''));

    const root = mountRoot();
    await expect(
      mountChordSketchUi(root, { renderers, createEditor: factory }),
    ).rejects.toBe(initError);

    expect(factory).not.toHaveBeenCalled();
  });
});
