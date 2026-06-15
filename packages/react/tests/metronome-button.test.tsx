import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // The interactive tempo chip is a `<button>` while the `{key}` /
  // `{time}` chips (and this chip's own non-interactive fallback) are
  // `<span>`. A `<button>` defaults to `box-sizing: border-box` and a
  // `<span>` to `content-box`, so without an explicit declaration on
  // `.meta-inline` the `min-height: 1.6rem` + 1px border made the
  // button ~2px shorter than the spans, misaligning the pills (#2624).
  // The fix pins `box-sizing: border-box` on `.meta-inline` itself so
  // every variant computes the same height regardless of element type.
  // Assert it against the stylesheet source — the height delta is a
  // layout property jsdom does not compute, so the DOM-level tests
  // above cannot catch a regression here.
  test('`.meta-inline` pins box-sizing so span and button chips share a height (#2624)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Strip CSS comments first — the explanatory comment inside the
    // rule mentions `{key}` / `{tempo}` / `{time}`, whose braces would
    // otherwise terminate the `[^}]` rule-block match prematurely.
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    // The base `.meta-inline` rule (not a `--variant` modifier) must
    // carry `box-sizing: border-box`. Match the rule block and assert
    // the declaration lives inside it.
    const rule = css.match(/\.chordsketch-sheet__content \.meta-inline \{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('box-sizing: border-box;');
  });

  // While the metronome is playing, the decorative beat-dot LED must
  // stop blinking: it is a discrete per-beat flash on an independent
  // CSS clock that drifts against the real audible tick (the
  // continuous swing / frame pulse stay running — see the stylesheet
  // comment). The animation is a CSS property jsdom does not compute,
  // so assert it against the stylesheet source like the box-sizing
  // test above.
  test('holds the beat-dot LED static while playing', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    // The playing-state rule that targets the beat dot must turn its
    // animation off and rest it at full opacity.
    const rule = css.match(
      /button\.meta-inline--interactive\.is-playing \.music-glyph--metronome__beat \{[^}]*\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('animation: none;');
    expect(rule?.[0]).toContain('opacity: 1;');
  });
});
