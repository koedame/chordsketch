import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { h } from 'vue';

import { ChordSheet } from '../src/index';
import { __resetInjectedCss } from '../src/renderer-css';
import { makeRenderLoader, makeRenderStub } from './stubs';

const SOURCE = '{title: Test}\n[C]Hello';

beforeEach(() => {
  __resetInjectedCss();
  document.head.querySelectorAll('style[data-chordsketch-vue]').forEach((el) => el.remove());
});

describe('ChordSheet', () => {
  test('renders the renderer body fragment inside the content wrapper', async () => {
    const stub = makeRenderStub();
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });
    await flushPromises();

    expect(stub.render_html_body).toHaveBeenCalledWith(SOURCE);
    const content = wrapper.get('.chordsketch-sheet__content');
    expect(content.html()).toContain('<article class="song">');
    expect(wrapper.attributes('aria-busy')).toBeUndefined();
  });

  test('injects the renderer stylesheet, scoped to the content wrapper', async () => {
    mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(makeRenderStub()) },
    });
    await flushPromises();

    const style = document.head.querySelector('style[data-chordsketch-vue]');
    expect(style?.textContent).toContain('.chordsketch-sheet__content .chord');
  });

  test('renders plain text inside a <pre> when format is "text"', async () => {
    const stub = makeRenderStub();
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, format: 'text', wasmLoader: makeRenderLoader(stub) },
    });
    await flushPromises();

    expect(wrapper.get('pre.chordsketch-sheet__text').text()).toBe(`TEXT ${SOURCE}`);
    expect(stub.render_html_body).not.toHaveBeenCalled();
    // The text branch carries no renderer stylesheet — it is not HTML.
    expect(document.head.querySelector('style[data-chordsketch-vue]')).toBeNull();
  });

  test('marks itself busy and shows the loading slot until the first render lands', async () => {
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(makeRenderStub()) },
      slots: { loading: () => h('p', 'Rendering…') },
    });

    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.text()).toContain('Rendering…');

    await flushPromises();
    expect(wrapper.attributes('aria-busy')).toBeUndefined();
    expect(wrapper.text()).not.toContain('Rendering…');
  });

  test('forwards transpose and config through the options-aware export', async () => {
    const stub = makeRenderStub();
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, transpose: 2, wasmLoader: makeRenderLoader(stub) },
    });
    await flushPromises();

    expect(stub.render_html_body_with_options).toHaveBeenCalledWith(SOURCE, {
      transpose: 2,
      config: undefined,
    });

    await wrapper.setProps({ transpose: -3, config: 'ukulele' });
    await flushPromises();
    expect(stub.render_html_body_with_options).toHaveBeenLastCalledWith(SOURCE, {
      transpose: -3,
      config: 'ukulele',
    });
  });

  test('re-renders when the source changes', async () => {
    const stub = makeRenderStub();
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });
    await flushPromises();

    await wrapper.setProps({ source: '[G]Bye' });
    await flushPromises();
    expect(stub.render_html_body).toHaveBeenLastCalledWith('[G]Bye');
    expect(wrapper.get('.chordsketch-sheet__content').html()).toContain('[G]Bye');
    // The module is initialised once and reused across renders.
    expect(stub.default).toHaveBeenCalledTimes(1);
  });

  test('surfaces a render error inline and keeps the previous output visible', async () => {
    const stub = makeRenderStub();
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
    });
    await flushPromises();

    stub.render_html_body.mockImplementationOnce(() => {
      throw new Error('unbalanced brace');
    });
    await wrapper.setProps({ source: '{title' });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe('unbalanced brace');
    // A half-typed edit must not blank the preview.
    expect(wrapper.get('.chordsketch-sheet__content').html()).toContain('[C]Hello');
  });

  test('an empty error slot suppresses the inline alert', async () => {
    const stub = makeRenderStub({
      render_html_body: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
      slots: { error: () => [] },
    });
    await flushPromises();

    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  test('the error slot receives the error', async () => {
    const stub = makeRenderStub({
      render_html_body: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const wrapper = mount(ChordSheet, {
      props: { source: SOURCE, wasmLoader: makeRenderLoader(stub) },
      slots: { error: (props: { error: Error }) => h('p', `failed: ${props.error.message}`) },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('failed: boom');
  });
});
