import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ChordInspector } from '../src/chord-inspector';
import type { ChordParts } from '../src/chord-source-edit';
import type { ChordStaffWasmLoader, StaffNote } from '../src/use-chord-staff';

const AM7_STAFF: StaffNote[] = [
  { letter: 'A', accidental: 0, octave: 3, midi: 57 },
  { letter: 'C', accidental: 0, octave: 4, midi: 60 },
  { letter: 'E', accidental: 0, octave: 4, midi: 64 },
  { letter: 'G', accidental: 0, octave: 4, midi: 67 },
];

// Deterministic staff loader so the inspector's `<ChordStaff>` never reaches
// for the real (unbuilt) `@chordsketch/wasm` during these unit tests.
const stubStaffLoader: ChordStaffWasmLoader = vi.fn(
  async () =>
    ({
      default: vi.fn(async () => undefined),
      chordStaffNotes: (chord: string) => (chord === 'Am7' ? AM7_STAFF : null),
    }) as unknown as Awaited<ReturnType<ChordStaffWasmLoader>>,
);

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
    staffLoader: stubStaffLoader,
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

  test('renders the constituent-notes staff beneath the chord name', async () => {
    const { container } = setup();
    await waitFor(() => {
      const svg = container.querySelector('.chordsketch-sheet__cins-staff .chordsketch-staff__svg');
      expect(svg).not.toBeNull();
      // One notehead per tone of Am7.
      expect(svg!.querySelectorAll('.chordsketch-staff__notehead')).toHaveLength(
        AM7_STAFF.length,
      );
    });
    expect(stubStaffLoader).toHaveBeenCalled();
  });

  test('omits the staff in the idle state', () => {
    const { container } = setup({ selected: false });
    expect(container.querySelector('.chordsketch-staff')).toBeNull();
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

  test('idle mode (selected=false) renders an edit-only hint, no controls', () => {
    const { container, getByText } = setup({
      selected: false,
      onRemove: undefined,
      onClose: undefined,
    });
    const cins = container.querySelector('.chordsketch-sheet__cins') as HTMLElement;
    expect(cins.getAttribute('data-mode')).toBe('idle');
    expect(getByText('No chord selected')).toBeTruthy();
    expect(container.querySelector('.chordsketch-sheet__cins-idle-hint')).not.toBeNull();
    // Edit-only: idle renders none of the editing controls.
    expect(container.querySelector('.chordsketch-sheet__cins-seg')).toBeNull();
    expect(container.querySelector('button[aria-label="Move chord left"]')).toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins-remove')).toBeNull();
  });

  test('there is no "Insert chord" button — the footer is edit-only (#2648)', () => {
    // Selected state: Remove present, never an Insert button.
    const { container, queryByText } = setup();
    expect(queryByText('Insert chord')).toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins-insert')).toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins-remove')).not.toBeNull();
  });

  test('the gated-editing note is shown in the idle state', () => {
    const { getByText } = setup({
      selected: false,
      onRemove: undefined,
      onClose: undefined,
      note: 'Clear transpose / capo to edit chords.',
    });
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
