import { fireEvent, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ChordInspector } from '../src/chord-inspector';
import type { ChordParts } from '../src/chord-source-edit';

function setup(overrides: Partial<Parameters<typeof ChordInspector>[0]> = {}) {
  const onChange = vi.fn();
  const onNudge = vi.fn();
  const onRemove = vi.fn();
  const onClose = vi.fn();
  const props = {
    chordName: 'Am7',
    root: 'A',
    accidental: '' as const,
    suffix: 'm7',
    bass: '',
    canLeft: true,
    canRight: true,
    onChange,
    onNudge,
    onRemove,
    onClose,
    ...overrides,
  };
  const utils = render(<ChordInspector {...props} />);
  return { ...utils, onChange, onNudge, onRemove, onClose };
}

describe('<ChordInspector>', () => {
  test('header shows the chord name and root/accidental/type reflect the parts', () => {
    const { container } = setup();
    expect(container.querySelector('.chordsketch-sheet__cins-name')?.textContent).toBe('Am7');
    // Root A is pressed; accidental natural is pressed; type m7 chip pressed.
    const pressedRoot = container.querySelector(
      '.chordsketch-sheet__cins-seg button[aria-pressed="true"]',
    );
    expect(pressedRoot?.textContent).toBe('A');
    const pressedChip = container.querySelector(
      '.chordsketch-sheet__cins-chip[aria-pressed="true"]',
    );
    expect(pressedChip?.textContent).toBe('m7');
  });

  test('changing the root emits the full parts with the new root', () => {
    const { container, onChange } = setup();
    const segs = container.querySelectorAll('.chordsketch-sheet__cins-seg');
    const dButton = Array.from(segs[0].querySelectorAll('button')).find(
      (b) => b.textContent === 'D',
    ) as HTMLButtonElement;
    fireEvent.click(dButton);
    expect(onChange).toHaveBeenCalledWith({ root: 'D', accidental: '', suffix: 'm7', bass: '' });
  });

  test('choosing an accidental emits the mapped character', () => {
    const { container, onChange } = setup();
    const accSeg = container.querySelectorAll('.chordsketch-sheet__cins-seg')[1];
    const flat = Array.from(accSeg.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Flat',
    ) as HTMLButtonElement;
    fireEvent.click(flat);
    expect(onChange).toHaveBeenCalledWith({ root: 'A', accidental: 'b', suffix: 'm7', bass: '' });
  });

  test('a type chip sets the suffix to the preset text', () => {
    const { container, onChange } = setup();
    const chips = container.querySelectorAll('.chordsketch-sheet__cins-chip');
    const maj7 = Array.from(chips).find((c) => c.textContent === 'maj7') as HTMLButtonElement;
    fireEvent.click(maj7);
    expect(onChange).toHaveBeenCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'maj7',
      bass: '',
    });
  });

  test('typing in the suffix / bass inputs emits the edited value', () => {
    const { container, onChange } = setup();
    const inputs = container.querySelectorAll('.chordsketch-sheet__cins-input');
    fireEvent.change(inputs[0], { target: { value: 'sus4' } });
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'sus4',
      bass: '',
    });
    fireEvent.change(inputs[1], { target: { value: 'G' } });
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'm7',
      bass: 'G',
    } satisfies ChordParts);
  });

  test('move buttons call onNudge and respect the bound flags', () => {
    const { container, onNudge } = setup({ canLeft: false });
    const left = container.querySelector('button[aria-label="Move chord left"]') as HTMLButtonElement;
    const right = container.querySelector(
      'button[aria-label="Move chord right"]',
    ) as HTMLButtonElement;
    expect(left.disabled).toBe(true);
    fireEvent.click(right);
    expect(onNudge).toHaveBeenCalledWith(1);
  });

  test('Escape closes; the close button closes; Remove fires onRemove', () => {
    const { container, onClose, onRemove } = setup();
    fireEvent.keyDown(container.querySelector('.chordsketch-sheet__cins') as HTMLElement, {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.chordsketch-sheet__cins-remove') as HTMLElement);
    expect(onRemove).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.chordsketch-sheet__cins-close') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('omitting onRemove hides the Remove button', () => {
    const { container } = setup({ onRemove: undefined });
    expect(container.querySelector('.chordsketch-sheet__cins-remove')).toBeNull();
  });

  test('there is no longer a "Done" button (#2644)', () => {
    const { queryByText } = setup();
    expect(queryByText('Done')).toBeNull();
  });

  test('idle mode (selected=false): "New chord" header, move/remove disabled', () => {
    const { container, getByText } = setup({
      selected: false,
      onRemove: undefined,
      onClose: undefined,
    });
    const cins = container.querySelector('.chordsketch-sheet__cins') as HTMLElement;
    expect(cins.getAttribute('data-mode')).toBe('idle');
    expect(getByText('New chord')).toBeTruthy();
    // Move buttons are disabled regardless of canLeft/canRight in idle.
    const left = container.querySelector('button[aria-label="Move chord left"]') as HTMLButtonElement;
    const right = container.querySelector(
      'button[aria-label="Move chord right"]',
    ) as HTMLButtonElement;
    expect(left.disabled).toBe(true);
    expect(right.disabled).toBe(true);
    // No Remove in idle (nothing selected to remove).
    expect(container.querySelector('.chordsketch-sheet__cins-remove')).toBeNull();
  });

  test('Insert button fires onInsert; absent when onInsert is omitted', () => {
    const onInsert = vi.fn();
    const { container, rerender } = setup({ onInsert });
    const insert = container.querySelector('.chordsketch-sheet__cins-insert') as HTMLButtonElement;
    expect(insert).not.toBeNull();
    fireEvent.click(insert);
    expect(onInsert).toHaveBeenCalledTimes(1);

    rerender(
      <ChordInspector
        chordName="Am7"
        root="A"
        accidental=""
        suffix="m7"
        bass=""
        canLeft
        canRight
        onChange={vi.fn()}
        onNudge={vi.fn()}
      />,
    );
    expect(container.querySelector('.chordsketch-sheet__cins-insert')).toBeNull();
  });

  test('note is rendered when provided (e.g. transpose-gated state)', () => {
    const { getByText } = setup({ note: 'Clear transpose / capo to edit chords.' });
    expect(getByText('Clear transpose / capo to edit chords.')).toBeTruthy();
  });

  test('without onClose there is no close button and Escape is a no-op', () => {
    const onClose = vi.fn();
    const { container } = setup({ onClose: undefined });
    expect(container.querySelector('.chordsketch-sheet__cins-close')).toBeNull();
    fireEvent.keyDown(container.querySelector('.chordsketch-sheet__cins') as HTMLElement, {
      key: 'Escape',
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
