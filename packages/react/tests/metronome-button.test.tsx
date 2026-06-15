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
  test('renders an interactive button when Web Audio is supported', () => {
    const { container } = render(<MetronomeButton bpm={120} />);
    const button = container.querySelector('button.meta-inline__metronome-button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('Play metronome at 120 BPM');
    // The decorative glyph is preserved inside the control.
    expect(button?.querySelector('.music-glyph--metronome')).not.toBeNull();
  });

  test('toggles aria-pressed and label on click', () => {
    const { container } = render(<MetronomeButton bpm={120} />);
    const button = container.querySelector(
      'button.meta-inline__metronome-button',
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Stop metronome (120 BPM)');
    expect(button.classList.contains('is-playing')).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Play metronome at 120 BPM');
    expect(button.classList.contains('is-playing')).toBe(false);
  });

  test('re-arms the running metronome when the BPM prop changes', () => {
    const { container, rerender } = render(<MetronomeButton bpm={120} />);
    const button = container.querySelector(
      'button.meta-inline__metronome-button',
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // A live edit to the {tempo} directive re-renders with a new BPM;
    // the label must follow and the metronome must keep playing.
    rerender(<MetronomeButton bpm={90} />);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Stop metronome (90 BPM)');
  });

  test('does not auto-start when the BPM prop changes while stopped', () => {
    const { container, rerender } = render(<MetronomeButton bpm={120} />);
    const button = container.querySelector(
      'button.meta-inline__metronome-button',
    ) as HTMLButtonElement;
    rerender(<MetronomeButton bpm={90} />);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Play metronome at 90 BPM');
  });

  test('falls back to a static glyph when Web Audio is unavailable', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { container } = render(<MetronomeButton bpm={120} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.music-glyph--metronome')).not.toBeNull();
  });
});
