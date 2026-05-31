import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChordDiagram } from '../src/chord-diagram';
import { __resetStaleBundleWarnings } from '../src/use-chord-diagram';

/**
 * `<ChordDiagram compact>` plumbing: a stub WASM loader records which
 * export the hook reached for, so we can assert the compact-size path and
 * its graceful degradation without a real WASM build. Mirrors the
 * `chord-diagram-defines` test's approach.
 */
type DiagramCall = {
  fn: 'compact' | 'orientation' | 'defines' | 'plain';
  chord: string;
  orientation: string | null | undefined;
};

/** Loader that exposes the compact export (current @chordsketch/wasm). */
function compactCapableLoader(record: (c: DiagramCall) => void) {
  return async () => ({
    default: async () => undefined,
    chord_diagram_svg: (chord: string) => {
      record({ fn: 'plain', chord, orientation: undefined });
      return '<svg data-stub="plain"></svg>';
    },
    chordDiagramSvgWithDefinesOrientation: (
      chord: string,
      _instrument: string,
      _defines: Array<[string, string]>,
      orientation: string | null | undefined,
    ) => {
      record({ fn: 'orientation', chord, orientation });
      return '<svg data-stub="orientation"></svg>';
    },
    chordDiagramSvgWithDefinesOrientationCompact: (
      chord: string,
      _instrument: string,
      _defines: Array<[string, string]>,
      orientation: string | null | undefined,
    ) => {
      record({ fn: 'compact', chord, orientation });
      return '<svg class="chord-diagram-compact" data-stub="compact"></svg>';
    },
  });
}

/** Older loader WITHOUT the compact export (pre-compact bundle). */
function legacyLoader(record: (c: DiagramCall) => void) {
  return async () => ({
    default: async () => undefined,
    chord_diagram_svg: (chord: string) => {
      record({ fn: 'plain', chord, orientation: undefined });
      return '<svg data-stub="plain"></svg>';
    },
    chordDiagramSvgWithDefinesOrientation: (
      chord: string,
      _instrument: string,
      _defines: Array<[string, string]>,
      orientation: string | null | undefined,
    ) => {
      record({ fn: 'orientation', chord, orientation });
      return '<svg data-stub="orientation"></svg>';
    },
  });
}

describe('<ChordDiagram compact>', () => {
  it('reaches the compact export when the bundle exposes it', async () => {
    __resetStaleBundleWarnings();
    const calls: DiagramCall[] = [];
    render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        compact
        orientation="vertical"
        wasmLoader={compactCapableLoader((c) => calls.push(c))}
      />,
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.fn).toBe('compact');
    expect(calls[0]?.orientation).toBe('vertical');
  });

  it('marks the wrapper with the compact modifier class', async () => {
    __resetStaleBundleWarnings();
    const { container } = render(
      <ChordDiagram chord="Am" instrument="guitar" compact wasmLoader={compactCapableLoader(() => {})} />,
    );
    await waitFor(() =>
      expect(container.querySelector('.chordsketch-diagram--compact')).not.toBeNull(),
    );
  });

  it('gracefully degrades to the regular diagram on a pre-compact bundle', async () => {
    __resetStaleBundleWarnings();
    const calls: DiagramCall[] = [];
    render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        compact
        wasmLoader={legacyLoader((c) => calls.push(c))}
      />,
    );
    // Falls through to the orientation export rather than throwing.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.fn).toBe('orientation');
  });

  it('does not reach the compact export when compact is not requested', async () => {
    __resetStaleBundleWarnings();
    const calls: DiagramCall[] = [];
    render(
      <ChordDiagram chord="Am" instrument="guitar" wasmLoader={compactCapableLoader((c) => calls.push(c))} />,
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.fn).toBe('orientation');
  });
});
