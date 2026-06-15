import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MetronomeButton } from '../src/metronome-button';
import { resetMetronomeSharedStateForTests } from '../src/use-metronome';

// Minimal Web Audio fake — see use-metronome.test.ts for the
// rationale. The button test only needs the graph calls not to
// throw; timing accuracy is covered by the hook's own suite.
class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  createOscillatorCalls = 0;
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
  createOscillator = vi.fn(() => {
    this.createOscillatorCalls += 1;
    return {
      type: '',
      onended: null,
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  });
  createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
}

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  resetMetronomeSharedStateForTests();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  resetMetronomeSharedStateForTests();
  if (originalAudioContext === undefined) {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  } else {
    (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
  }
});

describe('<MetronomeButton>', () => {
  test('renders the whole tempo chip as one interactive button', () => {
    const { container } = render(
      <MetronomeButton bpm={120} bpmRaw="120" className="meta-inline meta-inline--tempo" />,
    );
    const button = container.querySelector('button.meta-inline--interactive') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // The walker's chip classes are forwarded onto the button root, so
    // the entire pill (icon + readout) is a single click target.
    expect(button.classList.contains('meta-inline')).toBe(true);
    expect(button.classList.contains('meta-inline--tempo')).toBe(true);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // The Italian marking is folded into the label so AT still hears
    // it (the button's aria-label overrides the inner readout text).
    expect(button.getAttribute('aria-label')).toBe('Play metronome at 120 BPM, Allegro');
    // The readout lives inside the button (so clicking the text also
    // toggles), and the glyph is hidden from AT (button names itself).
    expect(button.textContent).toContain('120 BPM');
    const glyph = button.querySelector('.music-glyph--metronome');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('role')).toBeNull();
  });

  test('toggles aria-pressed, label, and the playing frame on click', () => {
    const { container } = render(
      <MetronomeButton bpm={120} bpmRaw="120" className="meta-inline meta-inline--tempo" />,
    );
    const button = container.querySelector('button.meta-inline--interactive') as HTMLButtonElement;
    // The beat period is published as a CSS var so the frame pulse
    // tracks the tempo (120 BPM → 0.5 s).
    expect(button.style.getPropertyValue('--cs-metronome-period')).toBe('0.500s');
    expect(button.classList.contains('is-playing')).toBe(false);

    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Stop metronome (120 BPM, Allegro)');
    // `is-playing` is what the stylesheet keys the animated frame on.
    expect(button.classList.contains('is-playing')).toBe(true);

    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Play metronome at 120 BPM, Allegro');
    expect(button.classList.contains('is-playing')).toBe(false);
  });

  test('clicking the readout text (not just the icon) toggles playback', () => {
    const { container } = render(
      <MetronomeButton bpm={120} bpmRaw="120" className="meta-inline meta-inline--tempo" />,
    );
    const button = container.querySelector('button.meta-inline--interactive') as HTMLButtonElement;
    const readout = button.querySelector('.meta-inline__value') as HTMLElement;
    expect(readout).not.toBeNull();
    fireEvent.click(readout);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  test('re-arms the running metronome when the BPM prop changes', () => {
    const { container, rerender } = render(
      <MetronomeButton bpm={120} bpmRaw="120" className="meta-inline meta-inline--tempo" />,
    );
    const button = container.querySelector('button.meta-inline--interactive') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // A live edit to the {tempo} directive re-renders with a new BPM;
    // the label and the pulse period must follow, and it keeps playing.
    rerender(
      <MetronomeButton bpm={90} bpmRaw="90" className="meta-inline meta-inline--tempo" />,
    );
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Stop metronome (90 BPM, Andante)');
    expect(button.style.getPropertyValue('--cs-metronome-period')).toBe('0.667s');
  });

  test('does not auto-start when the BPM prop changes while stopped', () => {
    const { container, rerender } = render(
      <MetronomeButton bpm={120} bpmRaw="120" className="meta-inline meta-inline--tempo" />,
    );
    const button = container.querySelector('button.meta-inline--interactive') as HTMLButtonElement;
    rerender(
      <MetronomeButton bpm={90} bpmRaw="90" className="meta-inline meta-inline--tempo" />,
    );
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Play metronome at 90 BPM, Andante');
  });

  test('falls back to a static, non-interactive chip when Web Audio is unavailable', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { container } = render(
      <MetronomeButton bpm={120} bpmRaw="120" className="meta-inline meta-inline--tempo" />,
    );
    expect(container.querySelector('button')).toBeNull();
    const chip = container.querySelector('.meta-inline--tempo') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toContain('120 BPM');
    // The visible readout carries the tempo, so the glyph is hidden
    // from AT to avoid announcing the BPM twice.
    const glyph = chip.querySelector('.music-glyph--metronome');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('role')).toBeNull();
  });
});
