import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetSharedAudioContextForTests } from '../src/audio-context';
import { KeySignatureButton } from '../src/key-signature-button';
import type { KeyAudioWasmLoader } from '../src/use-key-audio';
import { FakeAudioContext } from './fake-audio-context';

// Web Audio fake: the shared stand-in (`./fake-audio-context`). The
// button test only needs the graph calls not to throw; pitch / timing
// accuracy is covered by the hook's own suite.

// The canonical key the walker now hands the button is the spelled-out
// form (`G major`), per ADR-0035 — the audio core parses it the same way
// it parses `G` / `Gm`.
const scale = vi.fn((key: string): Uint8Array | undefined =>
  key === 'G major' ? new Uint8Array([55, 57, 59, 60, 62, 64, 66, 67]) : undefined,
);
const triad = vi.fn((key: string): Uint8Array | undefined =>
  key === 'G major' ? new Uint8Array([55, 59, 62]) : undefined,
);
const defaultFn = vi.fn(() => Promise.resolve());
const makeLoader = (): KeyAudioWasmLoader => () =>
  Promise.resolve({ default: defaultFn, keyScalePitches: scale, keyTonicTriad: triad });

const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

beforeEach(() => {
  resetSharedAudioContextForTests();
  scale.mockClear();
  triad.mockClear();
  defaultFn.mockClear();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  resetSharedAudioContextForTests();
  if (originalAudioContext === undefined) {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  } else {
    (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
  }
});

describe('<KeySignatureButton>', () => {
  test('renders the whole key chip as one interactive button', () => {
    const { container } = render(
      <KeySignatureButton keyName="G major" className="meta-inline meta-inline--key" />,
    );
    const button = container.querySelector('button.meta-inline--interactive') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // The walker's chip classes are forwarded onto the button root.
    expect(button.classList.contains('meta-inline')).toBe(true);
    expect(button.classList.contains('meta-inline--key')).toBe(true);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Play the G major scale and chord');
    // The readout + label live inside the button so the whole pill is a
    // single click target.
    expect(button.querySelector('.meta-inline__label')?.textContent).toBe('Key:');
    expect(button.querySelector('.meta-inline__value')?.textContent).toBe('G major');
    // The glyph names itself off in interactive mode (button labels it).
    const glyph = button.querySelector('.music-glyph--key');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('role')).toBeNull();
  });

  test('unicode-spells an accidental key in the readout and label', () => {
    const { container } = render(
      <KeySignatureButton keyName="Bb major" className="meta-inline meta-inline--key" />,
    );
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.querySelector('.meta-inline__value')?.textContent).toBe('B♭ major');
    expect(button.getAttribute('aria-label')).toBe('Play the B♭ major scale and chord');
  });

  test('renders an Original → Playing pair and auditions the sounding key', () => {
    const { container } = render(
      <KeySignatureButton
        keyName="G major"
        soundingKey="A major"
        className="meta-inline meta-inline--key meta-inline--key-pair"
      />,
    );
    const button = container.querySelector('button.meta-inline--key-pair') as HTMLButtonElement;
    expect(button).not.toBeNull();
    const groups = button.querySelectorAll('.meta-inline__group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector('.meta-inline__label')?.textContent).toBe('Original:');
    expect(groups[0]?.querySelector('.meta-inline__value')?.textContent).toBe('G major');
    expect(groups[1]?.querySelector('.meta-inline__label')?.textContent).toBe('Playing:');
    expect(groups[1]?.querySelector('.meta-inline__value')?.textContent).toBe('A major');
    // The audition plays what the reader hears — the sounding key.
    expect(button.getAttribute('aria-label')).toBe(
      'Play the A major scale and chord (transposed from G major)',
    );
  });

  test('clicking the chip auditions the key (schedules voices) without errors', async () => {
    const { container } = render(
      <KeySignatureButton
        keyName="G major"
        className="meta-inline meta-inline--key"
        wasmLoader={makeLoader()}
      />,
    );
    // Wait for the lazy wasm preload so the click can resolve pitches
    // synchronously inside the gesture.
    await waitFor(() => expect(defaultFn).toHaveBeenCalled());
    await waitFor(() => Promise.resolve());

    const button = container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(scale).toHaveBeenCalledWith('G major');
    expect(triad).toHaveBeenCalledWith('G major');
  });

  test('clicking the readout text (not just the icon) auditions the key', async () => {
    const { container } = render(
      <KeySignatureButton
        keyName="G major"
        className="meta-inline meta-inline--key"
        wasmLoader={makeLoader()}
      />,
    );
    await waitFor(() => expect(defaultFn).toHaveBeenCalled());
    await waitFor(() => Promise.resolve());

    const readout = container.querySelector('.meta-inline__value') as HTMLElement;
    fireEvent.click(readout);
    expect(scale).toHaveBeenCalledWith('G major');
  });

  test('falls back to a static, non-interactive span when Web Audio is unavailable', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { container } = render(
      <KeySignatureButton keyName="G major" className="meta-inline meta-inline--key" />,
    );
    expect(container.querySelector('button')).toBeNull();
    const chip = container.querySelector('.meta-inline--key') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.tagName).toBe('SPAN');
    // The fallback markup is byte-identical to the walker's pre-#2658
    // span: "Key:" label, value, and a labelled (non-hidden) glyph.
    expect(chip.querySelector('.meta-inline__label')?.textContent).toBe('Key:');
    expect(chip.querySelector('.meta-inline__value')?.textContent).toBe('G major');
    const glyph = chip.querySelector('.music-glyph--key');
    expect(glyph?.getAttribute('role')).toBe('img');
    expect(glyph?.getAttribute('aria-hidden')).toBeNull();
  });

  test('non-interactive pair fallback keeps the Original → Playing markup', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const { container } = render(
      <KeySignatureButton
        keyName="G major"
        soundingKey="A major"
        className="meta-inline meta-inline--key meta-inline--key-pair"
      />,
    );
    const chip = container.querySelector('.meta-inline--key-pair') as HTMLElement;
    expect(chip.tagName).toBe('SPAN');
    const groups = chip.querySelectorAll('.meta-inline__group');
    expect(groups).toHaveLength(2);
    expect(groups[1]?.querySelector('.meta-inline__value')?.textContent).toBe('A major');
  });
});
