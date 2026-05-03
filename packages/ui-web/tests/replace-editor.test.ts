// Tests for `ChordSketchUiHandle.replaceEditor` and the
// `MountOptions.headerControls` slot — both shipped in #2366 to
// support the playground's ChordPro / iRealb format toggle.
//
// The contract under test:
// 1. `replaceEditor(factory)` calls `destroy()` on the outgoing
//    adapter, builds a new one with the previous `getValue()`
//    forwarded as `initialValue`, re-attaches the change handler,
//    and triggers an immediate render (not the debounced path).
// 2. The post-swap editor's `onChange` events propagate to
//    `MountOptions.onChordProChange` exactly as the mount-time
//    adapter's would — i.e. the host's dirty-tracking continues
//    to work across the swap.
// 3. `headerControls` elements are mounted into the controls bar
//    in order, after the built-in format / transpose clusters.
// 4. A pending debounced render queued by the outgoing adapter is
//    cancelled before tear-down so a stale closure doesn't fire
//    against the new adapter (which would render the carried-over
//    value through the wrong renderer pathway).

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  mountChordSketchUi,
  type EditorAdapter,
  type EditorFactory,
  type Renderers,
} from '../src/index';

function makeRenderers(overrides: Partial<Renderers> = {}): Renderers {
  return {
    init: vi.fn(() => Promise.resolve()),
    renderHtml: vi.fn(() => '<div class="song">HTML</div>'),
    renderText: vi.fn(() => 'TEXT'),
    renderPdf: vi.fn(() => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    ...overrides,
  };
}

interface RecordingAdapter extends EditorAdapter {
  destroyed: boolean;
  initialValueSeen: string;
  onChangeAttached: number;
}

interface RecordingFactory {
  factory: EditorFactory;
  /** Most recent adapter built by the factory. */
  current: () => RecordingAdapter | null;
  /** Total adapters ever built. */
  buildCount: () => number;
}

/**
 * Build a factory that records every adapter it constructs. Used to
 * assert that `replaceEditor` tears down the previous adapter and
 * forwards the carried-over value as `initialValue` to the next.
 */
function makeRecordingFactory(): RecordingFactory {
  const adapters: RecordingAdapter[] = [];
  const factory: EditorFactory = (options) => {
    let value = options.initialValue;
    const listeners = new Set<(value: string) => void>();
    const element = document.createElement('div');
    element.dataset.adapterId = String(adapters.length);
    const adapter: RecordingAdapter = {
      element,
      destroyed: false,
      initialValueSeen: options.initialValue,
      onChangeAttached: 0,
      getValue: () => value,
      setValue: (v: string) => {
        value = v;
      },
      onChange(handler) {
        adapter.onChangeAttached += 1;
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      destroy() {
        adapter.destroyed = true;
        listeners.clear();
      },
    };
    // Expose a backdoor to simulate user input — the test fires
    // listeners directly rather than dispatching DOM events because
    // we own the adapter implementation.
    (adapter as unknown as { fire: (v: string) => void }).fire = (v) => {
      value = v;
      for (const handler of listeners) handler(v);
    };
    adapters.push(adapter);
    return adapter;
  };
  return {
    factory,
    current: () => adapters[adapters.length - 1] ?? null,
    buildCount: () => adapters.length,
  };
}

const mounted: HTMLElement[] = [];
function mountRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mounted.push(root);
  return root;
}

/**
 * Drive a recording adapter's `fire` backdoor that simulates a
 * user-typed input. The double cast widens the test-only field
 * onto the public adapter shape; collected here so callers do not
 * repeat the pattern at every call site.
 */
function fireOn(adapter: RecordingAdapter | null, value: string): void {
  if (adapter === null) throw new Error('no recording adapter to fire on');
  (adapter as unknown as { fire: (v: string) => void }).fire(value);
}

afterEach(() => {
  while (mounted.length > 0) {
    const root = mounted.pop();
    root?.remove();
  }
});

describe('replaceEditor', () => {
  test('destroys the outgoing adapter and forwards getValue() as initialValue', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: 'seed-A',
      createEditor: a.factory,
    });
    const before = a.current();
    expect(before?.initialValueSeen).toBe('seed-A');

    // Simulate user typing — when the swap fires we should carry
    // 'edited-A' across, not the original 'seed-A'.
    fireOn(before, 'edited-A');

    handle.replaceEditor(b.factory);

    expect(before?.destroyed).toBe(true);
    expect(b.buildCount()).toBe(1);
    expect(b.current()?.initialValueSeen).toBe('edited-A');

    handle.destroy();
  });

  test('post-swap user edits propagate to onChordProChange (re-attached handler)', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const onChordProChange = vi.fn();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: 'pre-swap',
      createEditor: a.factory,
      onChordProChange,
    });
    handle.replaceEditor(b.factory);

    // The replaceEditor swap itself MUST NOT fire onChordProChange
    // — it is a host-driven load, not a user edit. Mirrors
    // setChordPro's contract (line 196 of index.ts).
    expect(onChordProChange).not.toHaveBeenCalled();

    // Simulate a user edit on the new adapter — should propagate.
    fireOn(b.current(), 'post-swap-edit');
    expect(onChordProChange).toHaveBeenCalledTimes(1);
    expect(onChordProChange).toHaveBeenCalledWith('post-swap-edit');

    // The new adapter should have had `onChange` attached exactly
    // once — no duplicate subscriptions left over from the swap.
    expect(b.current()?.onChangeAttached).toBe(1);

    handle.destroy();
  });

  test('triggers an immediate render against the carried-over value', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: 'initial',
      createEditor: a.factory,
    });
    fireOn(a.current(), 'mid-edit');
    vi.clearAllMocks();

    handle.replaceEditor(b.factory);

    // Immediate (non-debounced) render against the carried-over
    // value. The HTML format is the default selected by
    // `buildDom`, so renderHtml is the path under test.
    expect(renderers.renderHtml).toHaveBeenCalledTimes(1);
    expect(renderers.renderHtml).toHaveBeenCalledWith('mid-edit');

    handle.destroy();
  });

  test('cancels a pending debounced render queued by the outgoing adapter', async () => {
    vi.useFakeTimers();
    try {
      const renderers = makeRenderers();
      const a = makeRecordingFactory();
      const b = makeRecordingFactory();
      const root = mountRoot();

      const handle = await mountChordSketchUi(root, {
        renderers,
        initialChordPro: 'seed',
        createEditor: a.factory,
      });
      vi.clearAllMocks();

      // Queue a debounced render via the outgoing adapter. The
      // 300 ms timer is not yet expired.
      fireOn(a.current(), 'queued');
      expect(renderers.renderHtml).not.toHaveBeenCalled();

      handle.replaceEditor(b.factory);

      // The replaceEditor flow runs an immediate render (one
      // call). Advancing past the original debounce window MUST
      // NOT trigger a second render — the queued timer should
      // have been cancelled by replaceEditor's tear-down path.
      expect(renderers.renderHtml).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      expect(renderers.renderHtml).toHaveBeenCalledTimes(1);

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('clears the editor pane DOM between swaps so adapters do not stack', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '',
      createEditor: a.factory,
    });
    const editorPane = root.querySelector('#editor-pane');
    if (!(editorPane instanceof HTMLElement)) {
      throw new Error('editor-pane not mounted');
    }
    expect(editorPane.children.length).toBe(1);
    const beforeElement = editorPane.firstElementChild;
    expect(beforeElement).toBe(a.current()?.element);

    handle.replaceEditor(b.factory);

    // Exactly one editor element after swap — the previous
    // adapter's DOM was removed before the new one was appended.
    expect(editorPane.children.length).toBe(1);
    expect(editorPane.firstElementChild).toBe(b.current()?.element);
    expect(editorPane.firstElementChild).not.toBe(beforeElement);

    handle.destroy();
  });

  test('after destroy(), replaceEditor is a no-op', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '',
      createEditor: a.factory,
    });
    handle.destroy();

    handle.replaceEditor(b.factory);
    expect(b.buildCount()).toBe(0);
  });

  test('factory throw leaves the previous editor intact and surfaces the error', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: 'survives',
      createEditor: a.factory,
    });
    fireOn(a.current(), 'mid-edit');
    vi.clearAllMocks();

    const throwingFactory: EditorFactory = () => {
      throw new Error('boom');
    };
    handle.replaceEditor(throwingFactory);

    // Previous adapter survives — not destroyed, still in pane,
    // still backing getChordPro / getValue.
    expect(a.current()?.destroyed).toBe(false);
    const editorPane = root.querySelector('#editor-pane');
    if (!(editorPane instanceof HTMLElement)) {
      throw new Error('editor-pane not mounted');
    }
    expect(editorPane.firstElementChild).toBe(a.current()?.element);
    expect(handle.getChordPro()).toBe('mid-edit');
    // Error is surfaced via the preview pane's error region.
    const errorDiv = root.querySelector('#error');
    if (!(errorDiv instanceof HTMLElement)) {
      throw new Error('error region not mounted');
    }
    expect(errorDiv.classList.contains('hidden')).toBe(false);
    expect(errorDiv.textContent).toContain('boom');
    // No render fired on the failed swap — the preview reflects
    // whatever the previous adapter had drawn.
    expect(renderers.renderHtml).not.toHaveBeenCalled();

    // The user can still edit on the surviving adapter (subscriber
    // chain wasn't torn down).
    const onEdit = vi.fn();
    const before = a.current();
    if (!before) throw new Error('current adapter null');
    before.onChange(onEdit);
    fireOn(before, 'post-throw-edit');
    expect(onEdit).toHaveBeenCalledWith('post-throw-edit');

    handle.destroy();
  });

  test('focus is restored when the outgoing editor had focus', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '',
      createEditor: a.factory,
    });
    // Make the recording adapter focusable + give it focus —
    // jsdom honours `tabIndex = 0` + `focus()` on a plain <div>.
    const beforeEl = a.current()?.element as HTMLElement;
    beforeEl.tabIndex = 0;
    beforeEl.focus();
    expect(document.activeElement).toBe(beforeEl);
    // Augment factory `b` so the post-swap adapter exposes a real
    // focus method that lands on its element.
    handle.replaceEditor((options) => {
      const adapter = b.factory(options);
      const el = adapter.element as HTMLElement;
      el.tabIndex = 0;
      adapter.focus = () => el.focus();
      return adapter;
    });
    expect(document.activeElement).toBe(b.current()?.element);

    handle.destroy();
  });

  test('focus is NOT moved when the outgoing editor did not have focus', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '',
      createEditor: a.factory,
    });
    // Focus lives outside the editor pane (e.g. on the format
    // select). The swap must not steal it.
    const formatSelect = root.querySelector('#format');
    if (!(formatSelect instanceof HTMLSelectElement)) {
      throw new Error('format select not mounted');
    }
    formatSelect.focus();
    expect(document.activeElement).toBe(formatSelect);

    let focusCalls = 0;
    handle.replaceEditor((options) => {
      const adapter = b.factory(options);
      adapter.focus = () => {
        focusCalls += 1;
      };
      return adapter;
    });

    expect(focusCalls).toBe(0);
    expect(document.activeElement).toBe(formatSelect);

    handle.destroy();
  });

  test('getChordPro reads from the post-swap adapter', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: 'A-content',
      createEditor: a.factory,
    });
    handle.replaceEditor(b.factory);
    fireOn(b.current(), 'B-content');

    expect(handle.getChordPro()).toBe('B-content');

    handle.destroy();
  });

  test('consecutive swaps (A→B→C) destroy each outgoing adapter and carry values forward', async () => {
    const renderers = makeRenderers();
    const a = makeRecordingFactory();
    const b = makeRecordingFactory();
    const c = makeRecordingFactory();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: 'value-A',
      createEditor: a.factory,
    });

    // First swap A→B: A is destroyed, B receives A's edited value.
    fireOn(a.current(), 'value-A-edited');
    handle.replaceEditor(b.factory);
    expect(a.current()?.destroyed).toBe(true);
    expect(b.buildCount()).toBe(1);
    expect(b.current()?.initialValueSeen).toBe('value-A-edited');

    // Second swap B→C: B is destroyed, C receives B's edited value.
    fireOn(b.current(), 'value-B-edited');
    handle.replaceEditor(c.factory);
    expect(b.current()?.destroyed).toBe(true);
    expect(c.buildCount()).toBe(1);
    expect(c.current()?.initialValueSeen).toBe('value-B-edited');

    // Each adapter must have been subscribed via onChange exactly once —
    // accumulated subscriptions would mean a prior swap leaked its handler.
    expect(b.current()?.onChangeAttached).toBe(1);
    expect(c.current()?.onChangeAttached).toBe(1);

    // getChordPro must read from the live (C) adapter.
    expect(handle.getChordPro()).toBe('value-B-edited');

    handle.destroy();
  });
});

describe('headerControls slot', () => {
  test('appends host elements to the controls bar in order', async () => {
    const renderers = makeRenderers();
    const a = document.createElement('button');
    a.id = 'host-button-a';
    a.textContent = 'A';
    const b = document.createElement('label');
    b.id = 'host-label-b';
    b.textContent = 'B';
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '',
      headerControls: [a, b],
    });

    const controls = root.querySelector('.controls');
    if (!(controls instanceof HTMLElement)) {
      throw new Error('controls bar not mounted');
    }
    // The injected elements must come after the built-in format
    // select and transpose group, in declaration order.
    const children = Array.from(controls.children);
    const aIdx = children.indexOf(a);
    const bIdx = children.indexOf(b);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    // Built-in clusters precede the host controls.
    const transposeGroup = controls.querySelector('.transpose-group');
    expect(transposeGroup).not.toBeNull();
    const transposeIdx = children.indexOf(transposeGroup as Element);
    expect(transposeIdx).toBeLessThan(aIdx);

    handle.destroy();
  });

  test('dedupes the same element passed twice and warns', async () => {
    const renderers = makeRenderers();
    const a = document.createElement('button');
    a.id = 'host-button-dup';
    a.textContent = 'A';
    const root = mountRoot();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handle = await mountChordSketchUi(root, {
        renderers,
        initialChordPro: '',
        headerControls: [a, a],
      });

      const controls = root.querySelector('.controls');
      if (!(controls instanceof HTMLElement)) {
        throw new Error('controls bar not mounted');
      }
      // Element appears exactly once even though it was passed twice.
      const matches = controls.querySelectorAll('#host-button-dup');
      expect(matches.length).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);

      handle.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  test('omitting headerControls leaves the controls bar at its built-in shape', async () => {
    const renderers = makeRenderers();
    const root = mountRoot();

    const handle = await mountChordSketchUi(root, {
      renderers,
      initialChordPro: '',
    });
    const controls = root.querySelector('.controls');
    if (!(controls instanceof HTMLElement)) {
      throw new Error('controls bar not mounted');
    }
    // Two children: format <label> and transpose group.
    expect(controls.children.length).toBe(2);

    handle.destroy();
  });
});
