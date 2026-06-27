import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ChordDiagram, useChordDiagram } from '../src/index';
import {
  __resetStaleBundleWarnings,
  __resetStalePitchesWarnings,
  type ChordDiagramWasmLoader,
} from '../src/use-chord-diagram';

interface StubRenderer {
  default: ReturnType<typeof vi.fn>;
  chord_diagram_svg: ReturnType<typeof vi.fn>;
  diagramPitches?: ReturnType<typeof vi.fn>;
}

// Open Am on guitar (x02210): A2 E3 A3 C4 E4 — the per-string voicing the
// diagram draws, distinct from the name-based block voicing.
const AM_GUITAR_PITCHES = [45, 52, 57, 60, 64];

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
    diagramPitches: vi.fn((chord: string, instrument: string) => {
      if (instrument === 'guitar' && chord === 'Am') {
        return new Uint8Array(AM_GUITAR_PITCHES);
      }
      if (instrument === 'piano' && chord === 'C') {
        return new Uint8Array([60, 64, 67]);
      }
      return null;
    }),
  };
}

function makeLoader(stub: StubRenderer): ChordDiagramWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<ChordDiagramWasmLoader>>);
}

describe('<ChordDiagram>', () => {
  beforeEach(() => {
    __resetStalePitchesWarnings();
  });

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

  // ---- Chord audio (#2686) ---------------------------------------

  test('chordAudio on: the diagram becomes a play button that sounds its chord', async () => {
    const stub = makeStub();
    const play = vi.fn();
    const { container } = render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        chordAudio={{ enabled: true, play }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    let wrapper!: HTMLElement;
    await waitFor(() => {
      wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
      expect(wrapper).not.toBeNull();
      // The SVG actually resolved, so this is the svg branch.
      expect(wrapper.querySelector('svg')).not.toBeNull();
    });
    // Interactive button semantics replace the static role="img".
    expect(wrapper.getAttribute('role')).toBe('button');
    expect(wrapper.getAttribute('aria-label')).toBe('Play chord Am (guitar)');
    expect(wrapper.getAttribute('data-chord')).toBe('Am');
    expect(wrapper.tabIndex).toBe(0);

    fireEvent.click(wrapper);
    expect(play).toHaveBeenCalledWith('Am');

    // Enter / Space activate from the keyboard; an unrelated key does not.
    fireEvent.keyDown(wrapper, { key: 'Enter' });
    fireEvent.keyDown(wrapper, { key: ' ' });
    fireEvent.keyDown(wrapper, { key: 'x' });
    expect(play).toHaveBeenCalledTimes(3);
  });

  test('chordAudio with playPitches: clicking sounds the diagram voicing, not the name (#2736)', async () => {
    const stub = makeStub();
    const play = vi.fn();
    const playPitches = vi.fn();
    const { container } = render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        chordAudio={{ enabled: true, play, playPitches }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    let wrapper!: HTMLElement;
    await waitFor(() => {
      wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.querySelector('svg')).not.toBeNull();
    });
    // The diagram voicing was resolved from the same lookup that drew the SVG.
    expect(stub.diagramPitches).toHaveBeenCalledWith('Am', 'guitar', []);

    fireEvent.click(wrapper);
    // It sounds the drawn shape's per-string pitches — NOT the name-based
    // block voicing.
    expect(playPitches).toHaveBeenCalledWith(AM_GUITAR_PITCHES);
    expect(play).not.toHaveBeenCalled();

    fireEvent.keyDown(wrapper, { key: 'Enter' });
    expect(playPitches).toHaveBeenCalledTimes(2);
  });

  test('chordAudio with playPitches but a stale bundle (no diagramPitches): falls back to the name voicing', async () => {
    const stub = makeStub();
    delete stub.diagramPitches; // simulate an @chordsketch/wasm bundle predating #2736
    const play = vi.fn();
    const playPitches = vi.fn();
    const { container } = render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        chordAudio={{ enabled: true, play, playPitches }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    let wrapper!: HTMLElement;
    await waitFor(() => {
      wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.querySelector('svg')).not.toBeNull();
    });
    fireEvent.click(wrapper);
    // No diagram pitches available → fall back to the chord-name block voicing.
    expect(play).toHaveBeenCalledWith('Am');
    expect(playPitches).not.toHaveBeenCalled();
  });

  test('chordAudio keyboard diagram: clicking sounds the highlighted keys (#2736)', async () => {
    const stub = makeStub();
    const play = vi.fn();
    const playPitches = vi.fn();
    const { container } = render(
      <ChordDiagram
        chord="C"
        instrument="piano"
        chordAudio={{ enabled: true, play, playPitches }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    let wrapper!: HTMLElement;
    await waitFor(() => {
      wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.querySelector('svg')).not.toBeNull();
    });
    fireEvent.click(wrapper);
    expect(playPitches).toHaveBeenCalledWith([60, 64, 67]);
    expect(play).not.toHaveBeenCalled();
  });

  test('chordAudio off / absent: the diagram stays a static role="img" figure', async () => {
    const stub = makeStub();
    const play = vi.fn();
    const off = render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        chordAudio={{ enabled: false, play }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    await waitFor(() => {
      expect(off.container.querySelector('.chordsketch-diagram svg')).not.toBeNull();
    });
    const offWrapper = off.container.querySelector('.chordsketch-diagram') as HTMLElement;
    expect(offWrapper.classList.contains('chordsketch-diagram--audio')).toBe(false);
    expect(offWrapper.getAttribute('role')).toBe('img');
    fireEvent.click(offWrapper);
    expect(play).not.toHaveBeenCalled();

    const absent = render(
      <ChordDiagram chord="Am" instrument="guitar" wasmLoader={makeLoader(stub)} />,
    );
    await waitFor(() => {
      expect(absent.container.querySelector('.chordsketch-diagram svg')).not.toBeNull();
    });
    expect(
      absent.container.querySelector('.chordsketch-diagram')?.getAttribute('role'),
    ).toBe('img');
  });

  test('chordAudio on: a not-found chord still plays (the name fallback is the play target)', async () => {
    const stub = makeStub();
    const play = vi.fn();
    const { container } = render(
      <ChordDiagram
        chord="ZZZ7sus4"
        instrument="guitar"
        chordAudio={{ enabled: true, play }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    let wrapper!: HTMLElement;
    await waitFor(() => {
      // Not-found branch: no svg, but still an audio button.
      wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.querySelector('svg')).toBeNull();
    });
    expect(wrapper.getAttribute('role')).toBe('button');
    fireEvent.click(wrapper);
    expect(play).toHaveBeenCalledWith('ZZZ7sus4');
  });

  test('chordAudio on: no ringing class is left stuck under prefers-reduced-motion', async () => {
    // Regression guard mirroring the chord-name path: `animation: none`
    // under reduced motion stops `animationend` from firing, so the pulse
    // class must never be added in the first place.
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    try {
      const stub = makeStub();
      const play = vi.fn();
      const { container } = render(
        <ChordDiagram
          chord="Am"
          instrument="guitar"
          chordAudio={{ enabled: true, play }}
          wasmLoader={makeLoader(stub)}
        />,
      );
      let wrapper!: HTMLElement;
      await waitFor(() => {
        wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
        expect(wrapper).not.toBeNull();
      });
      fireEvent.click(wrapper);
      expect(play).toHaveBeenCalledWith('Am');
      expect(wrapper.classList.contains('chordsketch-diagram--ringing')).toBe(false);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('chordAudio on: a still-loading diagram is already a play target', () => {
    // Hold the loader open so the loading state is the commit state.
    const loader: ChordDiagramWasmLoader = () =>
      new Promise<never>(() => {
        /* never resolves */
      });
    const play = vi.fn();
    const { container } = render(
      <ChordDiagram chord="Am" instrument="guitar" chordAudio={{ enabled: true, play }} wasmLoader={loader} />,
    );
    const wrapper = container.querySelector('.chordsketch-diagram--audio') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.getAttribute('aria-busy')).toBe('true');
    expect(wrapper.getAttribute('role')).toBe('button');
    fireEvent.click(wrapper);
    expect(play).toHaveBeenCalledWith('Am');
  });

  test('chordAudio on: the error branch is NOT a play affordance (no audio class / role / handler)', async () => {
    const stub = makeStub();
    stub.chord_diagram_svg.mockImplementation(() => {
      throw new Error('boom');
    });
    const play = vi.fn();
    const { container } = render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        chordAudio={{ enabled: true, play }}
        wasmLoader={makeLoader(stub)}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('boom');
    });
    const wrapper = container.querySelector('.chordsketch-diagram') as HTMLElement;
    // The failed diagram must not paint a clickable affordance it cannot honour.
    expect(wrapper.classList.contains('chordsketch-diagram--audio')).toBe(false);
    expect(wrapper.getAttribute('role')).toBeNull();
    fireEvent.click(wrapper);
    expect(play).not.toHaveBeenCalled();
  });

  test('audio off: an explicit consumer role survives once the SVG resolves', async () => {
    // Regression guard for the role-respect fix: the hover popover passes
    // role="tooltip"; the svg branch must not clobber it with role="img"
    // when the diagram loads. The descriptive aria-label is preserved so
    // an aria-describedby reference still resolves to a meaningful name.
    const stub = makeStub();
    const { container } = render(
      <ChordDiagram chord="Am" instrument="guitar" role="tooltip" wasmLoader={makeLoader(stub)} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chordsketch-diagram svg')).not.toBeNull();
    });
    const wrapper = container.querySelector('.chordsketch-diagram') as HTMLElement;
    expect(wrapper.getAttribute('role')).toBe('tooltip');
    expect(wrapper.getAttribute('aria-label')).toBe('Am chord diagram (guitar)');
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
  // The stale-bundle warning latch lives at module scope so a chord grid
  // mounting N <ChordDiagram>s logs the message exactly once. Reset it
  // between tests so an earlier test's warning does not suppress a later
  // test's assertion that the warning fires.
  beforeEach(() => {
    __resetStaleBundleWarnings();
  });

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

  test('stale-bundle warning fires exactly once across N mounted <ChordDiagram>s', async () => {
    // Per-instance latches let a chord grid render N copies of the same
    // warning — pin the module-singleton contract here so a regression to
    // a per-`useRef` latch would surface a noisy console.
    const noOrientation = {
      default: vi.fn(async () => undefined),
      chord_diagram_svg: vi.fn(() => '<svg data-mode="legacy"></svg>'),
      chordDiagramSvgWithDefines: vi.fn(() => '<svg data-mode="defines"></svg>'),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Mount five independent <ChordDiagram>s, each with its own hook
      // instance. Each uses a fresh stub renderer so the wasm-load step
      // never races on a shared module ref.
      render(
        <>
          {['Am', 'C', 'D', 'E', 'G'].map((chord) => (
            <ChordDiagram
              key={chord}
              chord={chord}
              instrument="guitar"
              orientation="horizontal"
              wasmLoader={makeLoader(noOrientation as unknown as StubRenderer)}
            />
          ))}
        </>,
      );
      await waitFor(() => {
        expect(noOrientation.chordDiagramSvgWithDefines.mock.calls.length).toBe(5);
      });
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

  test('rejects the removed horizontalStringOrder prop at the type layer (ADR-0026)', () => {
    // ADR-0026 pins horizontal mode to reader-view; the
    // `horizontalStringOrder` prop the pre-merge iteration shipped is
    // gone. The @ts-expect-error directive fails the test if the prop
    // ever comes back without an explicit type update — a regression
    // path that would otherwise quietly resurrect player-view through
    // the React surface.
    const stub = makeOrientationStub();
    render(
      <ChordDiagram
        chord="Am"
        instrument="guitar"
        orientation="horizontal"
        // @ts-expect-error -- horizontalStringOrder is intentionally not a prop (ADR-0026).
        horizontalStringOrder="player"
        wasmLoader={makeLoader(stub as unknown as StubRenderer)}
      />,
    );
    // Runtime: any unknown extra prop is silently ignored by React, so
    // there is nothing to assert here beyond the TS gate above. The
    // test failing to compile is the actual contract being pinned.
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
