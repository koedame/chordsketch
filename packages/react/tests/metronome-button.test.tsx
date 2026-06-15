import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MetronomeButton } from '../src/metronome-button';

// Minimal Web Audio fake — see use-metronome.test.ts for the
// rationale. The button test only needs the graph calls not to
// throw; timing accuracy is covered by the hook's own suite.
class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
  createOscillator = vi.fn(() => ({
    type: '',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  }));
}

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
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

  test('falls back to a static glyph when Web Audio is unavailable', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { container } = render(<MetronomeButton bpm={120} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.music-glyph--metronome')).not.toBeNull();
  });
});
