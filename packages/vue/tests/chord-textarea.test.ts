import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

import { ChordTextarea } from '../src/index';
import { __resetInjectedCss } from '../src/renderer-css';
import { makeRenderLoader, makeRenderStub } from './stubs';

beforeEach(() => {
  __resetInjectedCss();
  document.head.querySelectorAll('style[data-chordsketch-vue]').forEach((el) => el.remove());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountTextarea(props: Record<string, unknown> = {}) {
  return mount(ChordTextarea, {
    props: {
      debounceMs: 0,
      previewFormat: 'text',
      wasmLoader: makeRenderLoader(makeRenderStub()),
      ...props,
    },
  });
}

describe('ChordTextarea', () => {
  test('renders the editor and the preview pane', async () => {
    const wrapper = mountTextarea({ modelValue: '[C]Hello' });
    await flushPromises();

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('[C]Hello');
    expect(wrapper.get('.chordsketch-textarea__preview').text()).toBe('TEXT+0 [C]Hello');
  });

  test('emits update:modelValue on every keystroke', async () => {
    const wrapper = mountTextarea({ modelValue: '' });
    await wrapper.get('textarea').setValue('[G]');
    expect(wrapper.emitted('update:modelValue')).toEqual([['[G]']]);
  });

  test('controlled mode follows the parent value', async () => {
    const wrapper = mountTextarea({ modelValue: 'parent' });
    await wrapper.get('textarea').setValue('typed');
    // The edit is reported, not adopted — the parent owns the value.
    expect(wrapper.emitted('update:modelValue')).toEqual([['typed']]);

    await wrapper.setProps({ modelValue: 'from parent' });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('from parent');
  });

  test('uncontrolled mode seeds from defaultValue and keeps its own state', async () => {
    const wrapper = mountTextarea({ defaultValue: 'seed' });
    await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('seed');

    await wrapper.get('textarea').setValue('typed');
    await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('typed');
    expect(wrapper.emitted('update:modelValue')).toEqual([['typed']]);
    expect(wrapper.get('.chordsketch-textarea__preview').text()).toBe('TEXT+0 typed');
  });

  test('debounces the preview behind the editor', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountTextarea({ defaultValue: 'a', debounceMs: 250 });
      await flushPromises();
      await wrapper.get('textarea').setValue('ab');
      await flushPromises();
      // Still showing the pre-edit render.
      expect(wrapper.get('.chordsketch-textarea__preview').text()).toBe('TEXT+0 a');

      vi.advanceTimersByTime(250);
      await flushPromises();
      expect(wrapper.get('.chordsketch-textarea__preview').text()).toBe('TEXT+0 ab');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Ctrl/Cmd + Arrow emits the next transpose value', async () => {
    const wrapper = mountTextarea({
      defaultValue: '',
      transpose: 0,
      'onUpdate:transpose': () => undefined,
    });
    await wrapper.get('textarea').trigger('keydown', { key: 'ArrowUp', ctrlKey: true });
    await wrapper.get('textarea').trigger('keydown', { key: 'ArrowDown', metaKey: true });

    expect(wrapper.emitted('update:transpose')).toEqual([[1], [-1]]);
  });

  test('the shortcut clamps at the bounds and stops emitting there', async () => {
    const wrapper = mountTextarea({
      defaultValue: '',
      transpose: 2,
      transposeMin: -2,
      transposeMax: 2,
      'onUpdate:transpose': () => undefined,
    });
    await wrapper.get('textarea').trigger('keydown', { key: 'ArrowUp', ctrlKey: true });
    expect(wrapper.emitted('update:transpose')).toBeUndefined();
  });

  test('inverted bounds are swapped, with a dev warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapper = mountTextarea({
      defaultValue: '',
      transpose: 0,
      transposeMin: 5,
      transposeMax: -5,
      'onUpdate:transpose': () => undefined,
    });
    await wrapper.get('textarea').trigger('keydown', { key: 'ArrowUp', ctrlKey: true });

    expect(wrapper.emitted('update:transpose')).toEqual([[1]]);
    expect(error.mock.calls[0][0]).toContain('transposeMin');
  });

  test('without a transpose listener the keystroke is left to the browser', async () => {
    const wrapper = mountTextarea({ defaultValue: '', transpose: 0 });
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, cancelable: true });
    wrapper.get('textarea').element.dispatchEvent(event);
    await nextTick();

    // Suppressing the browser's own paragraph navigation for a host
    // that never asked for the shortcut would be a regression.
    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.emitted('update:transpose')).toBeUndefined();
  });

  test('forwards transpose and config to the preview, clamped', async () => {
    const stub = makeRenderStub();
    const wrapper = mount(ChordTextarea, {
      props: {
        modelValue: '[C]',
        debounceMs: 0,
        previewFormat: 'text',
        transpose: 99,
        transposeMax: 5,
        config: 'guitar',
        wasmLoader: makeRenderLoader(stub),
      },
    });
    await flushPromises();

    expect(stub.render_text_with_options).toHaveBeenCalledWith('[C]', {
      transpose: 5,
      config: 'guitar',
    });
    expect(wrapper.get('.chordsketch-textarea__preview').text()).toBe('TEXT+5 [C]');
  });

  test('readOnly marks the textarea read-only', async () => {
    const wrapper = mountTextarea({ modelValue: '', readOnly: true });
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined();
  });

  test('labels the textarea and disables the browser form assists', () => {
    const wrapper = mountTextarea({ modelValue: '' });
    const textarea = wrapper.get('textarea');
    expect(textarea.attributes('aria-label')).toBe('ChordPro editor');
    expect(textarea.attributes('placeholder')).toBe('Enter ChordPro source here…');
    expect(textarea.attributes('spellcheck')).toBe('false');
    expect(textarea.attributes('autocorrect')).toBe('off');
    expect(textarea.attributes('autocapitalize')).toBe('off');
    expect(textarea.attributes('autocomplete')).toBe('off');
  });

  test('warns when a caller flips between controlled and uncontrolled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapper = mountTextarea({ modelValue: 'controlled' });
    await wrapper.setProps({ modelValue: undefined });
    await nextTick();

    expect(error.mock.calls.some((c) => String(c[0]).includes('uncontrolled'))).toBe(true);
  });

  test('forwards the loading and error slots to the preview', async () => {
    const stub = makeRenderStub({
      render_text_with_options: vi.fn(() => {
        throw new Error('bad source');
      }),
    });
    const wrapper = mount(ChordTextarea, {
      props: {
        modelValue: '{',
        debounceMs: 0,
        previewFormat: 'text',
        wasmLoader: makeRenderLoader(stub),
      },
      slots: { error: (props: { error: Error }) => `preview failed: ${props.error.message}` },
    });
    await flushPromises();

    expect(wrapper.get('.chordsketch-textarea__preview').text()).toContain(
      'preview failed: bad source',
    );
  });
});
