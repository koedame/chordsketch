import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ChordDiagram, useChordDiagram } from '../src/index';
import type { ChordDiagramWasmLoader } from '../src/use-chord-diagram';

interface StubRenderer {
  default: ReturnType<typeof vi.fn>;
  chord_diagram_svg: ReturnType<typeof vi.fn>;
}

function makeStub(): StubRenderer {
  return {
    default: vi.fn(async () => undefined),
    chord_diagram_svg: vi.fn((chord: string, instrument: string) => {
      if (instrument === 'guitar' && chord === 'Am') {
        return '<svg data-chord="Am" data-instrument="guitar"></svg>';
      }
      if (instrument === 'piano' && chord === 'C') {
        return '<svg data-chord="C" data-instrument="piano"></svg>';
      }
      // Unknown combos return null — voicing database has no match.
      return null;
    }),
  };
}

function makeLoader(stub: StubRenderer): ChordDiagramWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<ChordDiagramWasmLoader>>);
}

describe('<ChordDiagram>', () => {
  test('renders the SVG returned by the WASM lookup', async () => {
    const stub = makeStub();
    const { container } = render(
      <ChordDiagram chord="Am" instrument="guitar" wasmLoader={makeLoader(stub)} />,
    );
    await waitFor(() => {
      const svg = container.querySelector('.chordsketch-diagram svg');
      expect(svg?.getAttribute('data-chord')).toBe('Am');
      expect(svg?.getAttribute('data-instrument')).toBe('guitar');
    });
    expect(stub.chord_diagram_svg).toHaveBeenCalledWith('Am', 'guitar');
  });

  test('defaults instrument to guitar', async () => {
    const stub = makeStub();
    render(<ChordDiagram chord="Am" wasmLoader={makeLoader(stub)} />);
    await waitFor(() => {
      expect(stub.chord_diagram_svg).toHaveBeenCalledWith('Am', 'guitar');
    });
  });

  test('renders the default not-found fallback when the DB has no entry', async () => {
    const stub = makeStub();
    render(
      <ChordDiagram
        chord="ZZZ7sus4"
        instrument="guitar"
        wasmLoader={makeLoader(stub)}
      />,
    );
    await waitFor(() => {
      const note = screen.getByRole('note');
      expect(note.textContent).toContain('ZZZ7sus4');
      expect(note.textContent).toContain('guitar');
    });
  });

  test('accepts a custom notFoundFallback render prop', async () => {
    const stub = makeStub();
    render(
      <ChordDiagram
        chord="ZZZ7sus4"
        instrument="guitar"
        notFoundFallback={(ch, inst) => (
          <section data-testid="nf">{`No ${inst} voicing for ${ch}`}</section>
        )}
        wasmLoader={makeLoader(stub)}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('nf').textContent).toBe('No guitar voicing for ZZZ7sus4');
    });
  });

  test('surfaces WASM errors through the default errorFallback', async () => {
    const stub = makeStub();
    stub.chord_diagram_svg.mockImplementation(() => {
      throw new Error('unknown instrument');
    });
    render(
      <ChordDiagram chord="Am" instrument="guitar" wasmLoader={makeLoader(stub)} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('unknown instrument');
    });
  });

  test('errorFallback={null} silences the error UI', async () => {
    const stub = makeStub();
    stub.chord_diagram_svg.mockImplementation(() => {
      throw new Error('nope');
    });
    render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        errorFallback={null}
        wasmLoader={makeLoader(stub)}
      />,
    );
    // After waitFor finds nothing, assert no alert element.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('piano instrument is routed through the same function', async () => {
    const stub = makeStub();
    const { container } = render(
      <ChordDiagram chord="C" instrument="piano" wasmLoader={makeLoader(stub)} />,
    );
    await waitFor(() => {
      const svg = container.querySelector('.chordsketch-diagram svg');
      expect(svg?.getAttribute('data-instrument')).toBe('piano');
    });
  });

  test('shows the default loading placeholder until the first result resolves', () => {
    // Hold the loader open so the loading state is the commit state.
    const loader: ChordDiagramWasmLoader = () =>
      new Promise<never>(() => {
        /* never resolves */
      });
    render(<ChordDiagram chord="Am" wasmLoader={loader} />);
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
  });
});

describe('useChordDiagram', () => {
  test('re-renders with new SVG when chord prop changes', async () => {
    const stub = makeStub();
    function Harness({ chord }: { chord: string }) {
      const { svg } = useChordDiagram(chord, 'guitar', makeLoader(stub));
      return <pre data-testid="out">{svg ?? 'NONE'}</pre>;
    }
    const { rerender } = render(<Harness chord="Am" />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toContain('data-chord="Am"'));
    rerender(<Harness chord="ZZZ7sus4" />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('NONE'));
  });
});

// Orientation pass-through (#2572) — the React surface adds two optional
// props that should ultimately reach the wasm `chord_diagram_svg_*`
// exports. We assert at the boundary rather than rendering the real SVG
// because the stub renderer fully captures the contract.
describe('<ChordDiagram> orientation pass-through (#2572)', () => {
  function makeOrientationStub() {
    return {
      default: vi.fn(async () => undefined),
      chord_diagram_svg: vi.fn(() => '<svg data-mode="legacy"></svg>'),
      chordDiagramSvgWithDefines: vi.fn(() => '<svg data-mode="defines"></svg>'),
      chordDiagramSvgWithDefinesOrientation: vi.fn(
        (
          _chord: string,
          _instrument: string,
          _defines: unknown,
          orientation: string | null | undefined,
        ) =>
          `<svg data-mode="oriented" data-orientation="${orientation ?? 'null'}"></svg>`,
      ),
    };
  }

  test('passes orientation="horizontal" through to the wasm export', async () => {
    const stub = makeOrientationStub();
    const { container } = render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        orientation="horizontal"
        wasmLoader={makeLoader(stub as unknown as StubRenderer)}
      />,
    );
    await waitFor(() => {
      const svg = container.querySelector('.chordsketch-diagram svg');
      expect(svg?.getAttribute('data-mode')).toBe('oriented');
      expect(svg?.getAttribute('data-orientation')).toBe('horizontal');
    });
    expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
      'Am',
      'guitar',
      [],
      'horizontal',
    );
    expect(stub.chordDiagramSvgWithDefines).not.toHaveBeenCalled();
  });

  test('falls back to the defines-only export when the orientation export is absent', async () => {
    // Older wasm bundles (pre-#2572) only ship
    // `chordDiagramSvgWithDefines`. The hook must degrade gracefully so
    // hosts pinning an older wasm bundle keep rendering — just without
    // orientation honoured. Build the stub directly without the
    // orientation field so the runtime structural check
    // `renderer.chordDiagramSvgWithDefinesOrientation` returns falsy
    // (this avoids `delete` on a non-optional field, which the
    // package's strict TS config rejects with TS2790).
    const noOrientation = {
      default: vi.fn(async () => undefined),
      chord_diagram_svg: vi.fn(() => '<svg data-mode="legacy"></svg>'),
      chordDiagramSvgWithDefines: vi.fn(() => '<svg data-mode="defines"></svg>'),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      render(
        <ChordDiagram
          chord="Am"
          instrument="guitar"
          orientation="horizontal"
          wasmLoader={makeLoader(noOrientation as unknown as StubRenderer)}
        />,
      );
      await waitFor(() => {
        expect(noOrientation.chordDiagramSvgWithDefines).toHaveBeenCalledWith(
          'Am',
          'guitar',
          [],
        );
      });
      // The stale-bundle warning must fire exactly once so a chord-grid
      // mounting N <ChordDiagram>s does not flood the console with N
      // copies of the same message.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(
        /does not expose chordDiagramSvgWithDefinesOrientation/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('does not warn when caller omits orientation (legacy callsite)', async () => {
    const noOrientation = {
      default: vi.fn(async () => undefined),
      chord_diagram_svg: vi.fn(() => '<svg data-mode="legacy"></svg>'),
      chordDiagramSvgWithDefines: vi.fn(() => '<svg data-mode="defines"></svg>'),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      render(
        <ChordDiagram
          chord="Am"
          instrument="guitar"
          wasmLoader={makeLoader(noOrientation as unknown as StubRenderer)}
        />,
      );
      await waitFor(() => {
        expect(noOrientation.chordDiagramSvgWithDefines).toHaveBeenCalled();
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('passes orientation="vertical" through explicitly', async () => {
    // Locks in the contract that orientation="vertical" routes through
    // the orientation-aware export with the literal "vertical" string,
    // not through the legacy export with no argument. Catches a
    // refactor that interprets `undefined` and `"vertical"` as the
    // same thing and drops the call to the orientation export.
    const stub = makeOrientationStub();
    render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        orientation="vertical"
        wasmLoader={makeLoader(stub as unknown as StubRenderer)}
      />,
    );
    await waitFor(() => {
      expect(stub.chordDiagramSvgWithDefinesOrientation).toHaveBeenCalledWith(
        'Am',
        'guitar',
        [],
        'vertical',
      );
    });
  });
});
