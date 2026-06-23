import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ChordInspector } from '../src/chord-inspector';
import type { ChordParts } from '../src/chord-source-edit';
import type { ChordStaffWasmLoader, StaffNote } from '../src/use-chord-staff';
import { readStylesheetSource } from './stylesheet-source';

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
  test('header shows the chord name; root + triad + 7th controls reflect the parts', () => {
    const { container } = setup();
    expect(container.querySelector('.chordsketch-sheet__cins-name')?.textContent).toBe('Am7');
    // Root A is pressed; accidental natural is pressed.
    const pressedRoot = container.querySelector(
      '.chordsketch-sheet__cins-seg button[aria-pressed="true"]',
    );
    expect(pressedRoot?.textContent).toBe('A');
    // Am7 decomposes to triad=min, 7th=7, no tensions: the matching chips in
    // each group are pressed, and no tension chip is.
    expect(
      container.querySelector('[aria-label="Triad quality"] button[aria-pressed="true"]')
        ?.textContent,
    ).toBe('min');
    expect(
      container.querySelector('[aria-label="Seventh"] button[aria-pressed="true"]')?.textContent,
    ).toBe('7');
    expect(
      container.querySelector('[aria-label="Tensions"] button[aria-pressed="true"]'),
    ).toBeNull();
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

  test('triad / 7th / tension chips compose an explicit suffix', () => {
    // The fixture chord is Am7 → {triad: min, 7th: 7, tensions: []}. Each chip
    // click recomposes from that selection (onChange is a mock, so the suffix
    // prop stays Am7 between clicks).
    const { container, onChange } = setup();
    const click = (groupLabel: string, text: string): void => {
      const btn = Array.from(
        container.querySelectorAll(`[aria-label="${groupLabel}"] button`),
      ).find((b) => b.textContent === text) as HTMLButtonElement;
      fireEvent.click(btn);
    };
    // Adding the 13 tension to Am7 → the explicit m7(13) (never a bare m13).
    click('Tensions', '13');
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'm7(13)',
      bass: '',
    });
    // Switching the triad to major keeps the dominant seventh → A7.
    click('Triad quality', 'maj');
    expect(onChange).toHaveBeenLastCalledWith({ root: 'A', accidental: '', suffix: '7', bass: '' });
    // Switching the seventh to maj7 → AmMaj7.
    click('Seventh', 'maj7');
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'mMaj7',
      bass: '',
    });
  });

  test('the seventh and tension chips disable unavailable options', () => {
    // Am7 → min triad: maj7 is available (mMaj7), but tensions are gone once
    // the seventh is mMaj7; with the dominant 7th the tensions are live.
    const { container } = setup();
    const seventhBtn = (text: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll('[aria-label="Seventh"] button')).find(
        (b) => b.textContent === text,
      ) as HTMLButtonElement;
    // A minor triad admits both 7 and maj7.
    expect(seventhBtn('7').disabled).toBe(false);
    expect(seventhBtn('maj7').disabled).toBe(false);
    // The altered ♭9 tension needs a seventh and a major/minor triad — present
    // here (Am7), so it is enabled.
    const flat9 = Array.from(
      container.querySelectorAll('[aria-label="Tensions"] button'),
    ).find((b) => b.textContent === '♭9') as HTMLButtonElement;
    expect(flat9.disabled).toBe(false);
  });

  test('a tension that is unavailable for the current chord is rendered disabled', () => {
    // Behavioural coverage for a distinct branch from the seventh-present case
    // above: a bare major triad (suffix '', no seventh) cannot take an altered
    // tension — ♭9 / ♯5 require a seventh (isTensionAvailable) — so those chips
    // carry the native `disabled` attribute, while the natural 9 add-tone stays
    // reachable. A disabled chip also exposes a `title` explaining the reason.
    // (The CSS that paints the disabled state is guarded separately by the
    // stylesheet-source test below and the playground e2e — this test guards
    // the availability → disabled-attribute wiring.)
    const { container } = setup({ root: 'G', suffix: '', chordName: 'G' });
    const tension = (text: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll('[aria-label="Tensions"] button')).find(
        (b) => b.textContent === text,
      ) as HTMLButtonElement;
    expect(tension('♭9').disabled).toBe(true);
    expect(tension('♭9').getAttribute('title')).toBe('Not available for the selected chord type');
    expect(tension('♯5').disabled).toBe(true);
    // The natural 9 add-tone is still reachable without a seventh, so it stays
    // enabled — the disabled treatment is selective, not blanket — and carries
    // no "unavailable" tooltip.
    expect(tension('9').disabled).toBe(false);
    expect(tension('9').getAttribute('title')).toBeNull();
  });

  test('styles.css gives disabled chips an inert style and suppresses their hover', () => {
    // The fast guard for the actual style fix (jsdom applies no CSS, so this
    // asserts rule presence in source per the readStylesheetSource pattern).
    // Without the `:disabled` rule a disabled chip would be visually
    // indistinguishable from a pressable one; without the `:not(:disabled)`
    // gate it would still highlight on hover. The deployed-bundle paint is
    // additionally proven by the playground e2e.
    const css = readStylesheetSource();
    // A dedicated :disabled rule exists for the chip, signalling not-allowed.
    const disabledRule = css.match(/\.chordsketch-sheet__cins-chip:disabled\s*\{([^}]*)\}/);
    expect(disabledRule).not.toBeNull();
    expect(disabledRule![1]).toContain('cursor: not-allowed');
    // The chip hover is gated behind :not(:disabled) so disabled chips do not
    // highlight.
    expect(css).toContain('.chordsketch-sheet__cins-chip:hover:not(:disabled)');
    expect(css).not.toMatch(/\.chordsketch-sheet__cins-chip:hover\s*\{/);
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

  test('the bass picker lights up None when there is no slash bass', () => {
    const { container } = setup();
    const bassSeg = container.querySelector(
      '[aria-label="Bass note"]',
    ) as HTMLElement;
    const none = Array.from(bassSeg.querySelectorAll('button')).find(
      (b) => b.textContent === 'None',
    ) as HTMLButtonElement;
    expect(none.getAttribute('aria-pressed')).toBe('true');
    // No note chip is pressed, and the bass accidental chips are inert.
    expect(bassSeg.querySelector('button[aria-pressed="true"]')).toBe(none);
    const accSeg = container.querySelector(
      '[aria-label="Bass accidental"]',
    ) as HTMLElement;
    for (const btn of Array.from(accSeg.querySelectorAll('button'))) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test('the bass picker reflects a plain-note slash bass', () => {
    const { container } = setup({ bass: 'F#', chordName: 'Am7/F#' });
    const bassSeg = container.querySelector('[aria-label="Bass note"]') as HTMLElement;
    expect(
      bassSeg.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toBe('F');
    const accSeg = container.querySelector(
      '[aria-label="Bass accidental"]',
    ) as HTMLElement;
    const sharp = Array.from(accSeg.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Bass sharp',
    ) as HTMLButtonElement;
    expect(sharp.disabled).toBe(false);
    expect(sharp.getAttribute('aria-pressed')).toBe('true');
  });

  test('choosing a bass note emits the full parts with the slash bass', () => {
    const { container, onChange } = setup();
    const bassSeg = container.querySelector('[aria-label="Bass note"]') as HTMLElement;
    const g = Array.from(bassSeg.querySelectorAll('button')).find(
      (b) => b.textContent === 'G',
    ) as HTMLButtonElement;
    fireEvent.click(g);
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'm7',
      bass: 'G',
    } satisfies ChordParts);
  });

  test('switching the bass note keeps the chosen accidental', () => {
    const { container, onChange } = setup({ bass: 'F#', chordName: 'Am7/F#' });
    const bassSeg = container.querySelector('[aria-label="Bass note"]') as HTMLElement;
    const a = Array.from(bassSeg.querySelectorAll('button')).find(
      (b) => b.textContent === 'A',
    ) as HTMLButtonElement;
    fireEvent.click(a);
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'm7',
      bass: 'A#',
    } satisfies ChordParts);
  });

  test('choosing a bass accidental rewrites the bass note', () => {
    const { container, onChange } = setup({ bass: 'G', chordName: 'Am7/G' });
    const accSeg = container.querySelector(
      '[aria-label="Bass accidental"]',
    ) as HTMLElement;
    const flat = Array.from(accSeg.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Bass flat',
    ) as HTMLButtonElement;
    fireEvent.click(flat);
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'm7',
      bass: 'Gb',
    } satisfies ChordParts);
  });

  test('None clears the slash bass', () => {
    const { container, onChange } = setup({ bass: 'G', chordName: 'Am7/G' });
    const bassSeg = container.querySelector('[aria-label="Bass note"]') as HTMLElement;
    const none = Array.from(bassSeg.querySelectorAll('button')).find(
      (b) => b.textContent === 'None',
    ) as HTMLButtonElement;
    fireEvent.click(none);
    expect(onChange).toHaveBeenLastCalledWith({
      root: 'A',
      accidental: '',
      suffix: 'm7',
      bass: '',
    } satisfies ChordParts);
  });

  test('a free-form (non-plain-note) bass leaves the picker chips unpressed', () => {
    // A compound / figured bass the single-note picker cannot model: None is
    // not pressed (a bass IS set), no note chip is pressed, and the accidental
    // chips are inert — the free-form `/ Bass` field carries the literal value.
    const { container } = setup({ bass: 'G7', chordName: 'Am7/G7' });
    const bassSeg = container.querySelector('[aria-label="Bass note"]') as HTMLElement;
    expect(bassSeg.querySelector('button[aria-pressed="true"]')).toBeNull();
    const accSeg = container.querySelector(
      '[aria-label="Bass accidental"]',
    ) as HTMLElement;
    for (const btn of Array.from(accSeg.querySelectorAll('button'))) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
    // The free-form bass input still shows the literal token.
    const bassInput = container.querySelectorAll('.chordsketch-sheet__cins-input')[1];
    expect((bassInput as HTMLInputElement).value).toBe('G7');
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

  test('move control labels name the chord and its step granularity', () => {
    const { container } = setup();
    // The group header names what moves — the chord, not the lyric — so it
    // agrees with the buttons' "Move chord left" / "Move chord right"
    // accessible names. The inline label between the ◀ / ▶ buttons names the
    // step granularity, not the object, so the two labels don't both repeat
    // "Move chord".
    const moveGroup = (
      container.querySelector('.chordsketch-sheet__cins-move') as HTMLElement
    ).parentElement as HTMLElement;
    const header = moveGroup.querySelector(
      '.chordsketch-sheet__cins-label',
    ) as HTMLElement;
    const inline = moveGroup.querySelector(
      '.chordsketch-sheet__cins-movelbl',
    ) as HTMLElement;
    expect(header.textContent).toBe('Move chord');
    expect(inline.textContent).toBe('one step');
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
