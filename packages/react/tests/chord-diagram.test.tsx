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
