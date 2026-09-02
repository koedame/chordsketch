import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { h } from 'vue';

import { ChordDiagram, useChordDiagram } from '../src/index';
import { __resetStaleBundleWarnings } from '../src/use-chord-diagram';
import { makeDiagramLoader } from './stubs';

const SVG = '<svg role="presentation"><title>Am</title></svg>';

interface DiagramStub {
  default: ReturnType<typeof vi.fn>;
  chord_diagram_svg: ReturnType<typeof vi.fn>;
  chordDiagramSvgWithDefines?: ReturnType<typeof vi.fn>;
  chordDiagramSvgWithDefinesOrientation?: ReturnType<typeof vi.fn>;
  chordDiagramSvgWithDefinesOrientationCompact?: ReturnType<typeof vi.fn>;
}

function makeDiagramStub(overrides: Partial<DiagramStub> = {}): DiagramStub {
  return {
    default: vi.fn(async () => undefined),
    chord_diagram_svg: vi.fn(() => SVG),
    chordDiagramSvgWithDefines: vi.fn(() => SVG),
    chordDiagramSvgWithDefinesOrientation: vi.fn(() => SVG),
    chordDiagramSvgWithDefinesOrientationCompact: vi.fn(() => SVG),
    ...overrides,
  };
}

beforeEach(() => {
  __resetStaleBundleWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChordDiagram', () => {
  test('prefers the orientation-aware export and passes the defines through', async () => {
    const stub = makeDiagramStub();
    const { svg, loading, error } = useChordDiagram(
      'Gsus4',
      { instrument: 'ukulele', defines: [['Gsus4', 'base-fret 1 frets 0 2 3 3']] },
      makeDiagramLoader(stub),
    );
    await flushPromises();

    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
      'Gsus4',
      'ukulele',
      [['Gsus4', 'base-fret 1 frets 0 2 3 3']],
      null,
    );
    expect(svg.value).toBe(SVG);
    expect(loading.value).toBe(false);
    expect(error.value).toBeNull();
  });

  test('an unknown chord is not an error — it resolves to a null svg', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => null),
    });
    const { svg, error } = useChordDiagram('H7', {}, makeDiagramLoader(stub));
    await flushPromises();

    expect(svg.value).toBeNull();
    expect(error.value).toBeNull();
  });

  test('a rejected instrument surfaces as an error and clears the svg', async () => {
    const stub = makeDiagramStub();
    const { svg, error } = useChordDiagram('Am', {}, makeDiagramLoader(stub));
    await flushPromises();
    expect(svg.value).toBe(SVG);

    stub.chordDiagramSvgWithDefinesOrientation!.mockImplementationOnce(() => {
      throw new Error('unknown instrument');
    });
    // A stale diagram next to an instrument-mismatch error would be
    // misleading, so the svg is dropped.
    const second = useChordDiagram('Am', { instrument: 'kazoo' as never }, makeDiagramLoader(stub));
    await flushPromises();
    expect(second.error.value?.message).toBe('unknown instrument');
    expect(second.svg.value).toBeNull();
  });

  test('falls back through the older exports and warns once about the stale bundle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: undefined,
      chordDiagramSvgWithDefinesOrientationCompact: undefined,
    });
    const loader = makeDiagramLoader(stub);

    useChordDiagram('Am', { orientation: 'horizontal' }, loader);
    await flushPromises();
    useChordDiagram('C', { orientation: 'horizontal' }, loader);
    await flushPromises();

    expect(stub.chordDiagramSvgWithDefines).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('chordDiagramSvgWithDefinesOrientation');
  });

  test('falls back to the plain export when the bundle has only that', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefines: undefined,
      chordDiagramSvgWithDefinesOrientation: undefined,
      chordDiagramSvgWithDefinesOrientationCompact: undefined,
    });
    const { svg } = useChordDiagram('Am', {}, makeDiagramLoader(stub));
    await flushPromises();

    expect(stub.chord_diagram_svg).toHaveBeenCalledWith('Am', 'guitar');
    expect(svg.value).toBe(SVG);
  });

  test('degrades to the full-size diagram when the compact export is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stub = makeDiagramStub({ chordDiagramSvgWithDefinesOrientationCompact: undefined });
    useChordDiagram('Am', { compact: true }, makeDiagramLoader(stub));
    await flushPromises();

    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Compact');
  });

  test('drops an over-long orientation before it crosses the wasm ABI', async () => {
    const stub = makeDiagramStub();
    useChordDiagram(
      'Am',
      { orientation: 'h'.repeat(65) as never },
      makeDiagramLoader(stub),
    );
    await flushPromises();

    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
      'Am',
      'guitar',
      [],
      null,
    );
  });

  test('re-runs the lookup when the chord changes', async () => {
    const stub = makeDiagramStub();
    const chord = { value: 'Am' };
    const { svg } = useChordDiagram(() => chord.value, {}, makeDiagramLoader(stub));
    await flushPromises();
    expect(svg.value).toBe(SVG);
    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledTimes(1);
  });
});

describe('ChordDiagram', () => {
  test('injects the renderer SVG and names it for assistive tech', async () => {
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });
    await flushPromises();

    expect(wrapper.find('svg').exists()).toBe(true);
    expect(wrapper.attributes('role')).toBe('img');
    expect(wrapper.attributes('aria-label')).toBe('Am chord diagram (guitar)');
  });

  test('a consumer role overrides the default img role', async () => {
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
      attrs: { role: 'tooltip' },
    });
    await flushPromises();

    expect(wrapper.attributes('role')).toBe('tooltip');
    expect(wrapper.attributes('aria-label')).toBe('Am chord diagram (guitar)');
  });

  test('shows a busy placeholder while the module loads', () => {
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });

    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.get('[role="status"]').text()).toBe('Loading diagram…');
  });

  test('renders the not-found note when the database has no voicing', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => null),
    });
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'H7', instrument: 'ukulele', wasmLoader: makeDiagramLoader(stub) },
    });
    await flushPromises();

    const note = wrapper.get('[role="note"]');
    expect(note.text()).toContain('H7');
    expect(note.text()).toContain('ukulele');
  });

  test('the not-found slot receives the chord and instrument', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => null),
    });
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'H7', wasmLoader: makeDiagramLoader(stub) },
      slots: {
        'not-found': (props: { chord: string; instrument: string }) =>
          h('p', `${props.chord}/${props.instrument}`),
      },
    });
    await flushPromises();

    expect(wrapper.text()).toBe('H7/guitar');
  });

  test('renders an alert when the lookup errors', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => {
        throw new Error('unknown instrument');
      }),
    });
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(stub) },
    });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe('unknown instrument');
    expect(wrapper.find('svg').exists()).toBe(false);
  });

  test('surfaces orientation as a data attribute only when set', async () => {
    const bare = mount(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });
    const horizontal = mount(ChordDiagram, {
      props: {
        chord: 'Am',
        orientation: 'horizontal',
        wasmLoader: makeDiagramLoader(makeDiagramStub()),
      },
    });
    await flushPromises();

    expect(bare.attributes('data-orientation')).toBeUndefined();
    expect(horizontal.attributes('data-orientation')).toBe('horizontal');
  });

  test('carries the compact modifier class when compact is set', async () => {
    const wrapper = mount(ChordDiagram, {
      props: { chord: 'Am', compact: true, wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });
    await flushPromises();

    expect(wrapper.classes()).toContain('chordsketch-diagram--compact');
  });
});
