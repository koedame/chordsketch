import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChordDiagram, useChordDiagram } from '../src/index';
import { __resetStaleBundleWarnings } from '../src/use-chord-diagram.svelte';
import { inEffectRoot, reactiveBox } from './runes.svelte';
import DiagramSnippets from './harness/DiagramSnippets.svelte';
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

const roots: Array<() => void> = [];

/** Run a helper in an effect root that is torn down after the test. */
function lookup(...args: Parameters<typeof useChordDiagram>) {
  const root = inEffectRoot(() => useChordDiagram(...args));
  roots.push(root.destroy);
  return root.value;
}

beforeEach(() => {
  __resetStaleBundleWarnings();
});

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  cleanup();
  vi.restoreAllMocks();
});

describe('useChordDiagram', () => {
  test('prefers the orientation-aware export and passes the defines through', async () => {
    const stub = makeDiagramStub();
    const diagram = lookup(
      'Gsus4',
      { instrument: 'ukulele', defines: [['Gsus4', 'base-fret 1 frets 0 2 3 3']] },
      makeDiagramLoader(stub),
    );

    await waitFor(() => expect(diagram.svg).toBe(SVG));
    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
      'Gsus4',
      'ukulele',
      [['Gsus4', 'base-fret 1 frets 0 2 3 3']],
      null,
    );
    expect(diagram.loading).toBe(false);
    expect(diagram.error).toBeNull();
  });

  test('an unknown chord is not an error — it resolves to a null svg', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => null),
    });
    const diagram = lookup('H7', {}, makeDiagramLoader(stub));

    await waitFor(() => expect(diagram.loading).toBe(false));
    expect(diagram.svg).toBeNull();
    expect(diagram.error).toBeNull();
  });

  test('a rejected instrument surfaces as an error and clears the svg', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => {
        throw new Error('unknown instrument');
      }),
    });
    const diagram = lookup('Am', { instrument: 'kazoo' as never }, makeDiagramLoader(stub));

    await waitFor(() => expect(diagram.error?.message).toBe('unknown instrument'));
    // A stale diagram next to an instrument-mismatch error would be
    // misleading, so the svg is dropped.
    expect(diagram.svg).toBeNull();
  });

  test('falls back through the older exports and warns once about the stale bundle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: undefined,
      chordDiagramSvgWithDefinesOrientationCompact: undefined,
    });
    const loader = makeDiagramLoader(stub);

    const first = lookup('Am', { orientation: 'horizontal' }, loader);
    await waitFor(() => expect(first.svg).toBe(SVG));
    const second = lookup('C', { orientation: 'horizontal' }, loader);
    await waitFor(() => expect(second.svg).toBe(SVG));

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
    const diagram = lookup('Am', {}, makeDiagramLoader(stub));

    await waitFor(() => expect(diagram.svg).toBe(SVG));
    expect(stub.chord_diagram_svg).toHaveBeenCalledWith('Am', 'guitar');
  });

  test('degrades to the full-size diagram when the compact export is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stub = makeDiagramStub({ chordDiagramSvgWithDefinesOrientationCompact: undefined });
    const diagram = lookup('Am', { compact: true }, makeDiagramLoader(stub));

    await waitFor(() => expect(diagram.svg).toBe(SVG));
    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('compact');
  });

  test('drops an over-long orientation before it crosses the wasm ABI', async () => {
    const stub = makeDiagramStub();
    const diagram = lookup(
      'Am',
      { orientation: 'h'.repeat(65) as never },
      makeDiagramLoader(stub),
    );

    await waitFor(() => expect(diagram.svg).toBe(SVG));
    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
      'Am',
      'guitar',
      [],
      null,
    );
  });

  test('re-runs the lookup when the chord getter changes', async () => {
    const stub = makeDiagramStub();
    const chord = reactiveBox('Am');
    const diagram = lookup(() => chord.value, {}, makeDiagramLoader(stub));

    await waitFor(() =>
      expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
        'Am',
        'guitar',
        [],
        null,
      ),
    );

    chord.value = 'C';
    await waitFor(() =>
      expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenLastCalledWith(
        'C',
        'guitar',
        [],
        null,
      ),
    );
    expect(diagram.svg).toBe(SVG);
  });
});

describe('ChordDiagram', () => {
  test('injects the renderer SVG and names it for assistive tech', async () => {
    const { container } = render(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const wrapper = container.querySelector('.chordsketch-diagram')!;
    expect(wrapper.getAttribute('role')).toBe('img');
    expect(wrapper.getAttribute('aria-label')).toBe('Am chord diagram (guitar)');
  });

  test('a host role overrides the default img role', async () => {
    const { container } = render(ChordDiagram, {
      props: { chord: 'Am', role: 'tooltip', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const wrapper = container.querySelector('.chordsketch-diagram')!;
    expect(wrapper.getAttribute('role')).toBe('tooltip');
    expect(wrapper.getAttribute('aria-label')).toBe('Am chord diagram (guitar)');
  });

  test('shows a busy placeholder while the module loads', () => {
    const { container } = render(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });

    expect(container.querySelector('.chordsketch-diagram')!.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(container.querySelector('[role="status"]')!.textContent?.trim()).toBe(
      'Loading diagram…',
    );
  });

  test('renders the not-found note when the database has no voicing', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => null),
    });
    const { container } = render(ChordDiagram, {
      props: { chord: 'H7', instrument: 'ukulele', wasmLoader: makeDiagramLoader(stub) },
    });

    await waitFor(() => expect(container.querySelector('[role="note"]')).not.toBeNull());
    const note = container.querySelector('[role="note"]')!;
    expect(note.textContent).toContain('H7');
    expect(note.textContent).toContain('ukulele');
  });

  test('the notFound snippet receives the chord and instrument', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => null),
    });
    const { container } = render(DiagramSnippets, {
      props: { chord: 'H7', wasmLoader: makeDiagramLoader(stub) },
    });

    await waitFor(() => expect(container.textContent?.trim()).toBe('H7/guitar'));
  });

  test('renders an alert when the lookup errors', async () => {
    const stub = makeDiagramStub({
      chordDiagramSvgWithDefinesOrientation: vi.fn(() => {
        throw new Error('unknown instrument');
      }),
    });
    const { container } = render(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(stub) },
    });

    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('unknown instrument'),
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  test('surfaces orientation as a data attribute only when set', async () => {
    const bare = render(ChordDiagram, {
      props: { chord: 'Am', wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });
    const horizontal = render(ChordDiagram, {
      props: {
        chord: 'Am',
        orientation: 'horizontal',
        wasmLoader: makeDiagramLoader(makeDiagramStub()),
      },
    });

    await waitFor(() => expect(horizontal.container.querySelector('svg')).not.toBeNull());
    expect(
      bare.container.querySelector('.chordsketch-diagram')!.getAttribute('data-orientation'),
    ).toBeNull();
    expect(
      horizontal.container
        .querySelector('.chordsketch-diagram')!
        .getAttribute('data-orientation'),
    ).toBe('horizontal');
  });

  test('carries the compact modifier class when compact is set', async () => {
    const { container } = render(ChordDiagram, {
      props: { chord: 'Am', compact: true, wasmLoader: makeDiagramLoader(makeDiagramStub()) },
    });

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    expect(
      container.querySelector('.chordsketch-diagram')!.classList.contains(
        'chordsketch-diagram--compact',
      ),
    ).toBe(true);
  });
});
