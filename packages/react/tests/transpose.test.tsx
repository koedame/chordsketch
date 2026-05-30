import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { Transpose, useTranspose } from '../src/index';

function getSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Transpose' }) as HTMLSelectElement;
}

// Text shown on the currently-selected option.
function getSelectedText(): string {
  return getSelect().selectedOptions[0]?.textContent ?? '';
}

describe('useTranspose', () => {
  test('initial defaults to 0', () => {
    const { result } = renderHook(() => useTranspose());
    expect(result.current.value).toBe(0);
  });

  test('initial value is clamped into [min, max]', () => {
    const { result } = renderHook(() => useTranspose({ initial: 999, min: -5, max: 5 }));
    expect(result.current.value).toBe(5);
  });

  test('initial NaN collapses to min', () => {
    const { result } = renderHook(() =>
      useTranspose({ initial: Number.NaN, min: -5, max: 5 }),
    );
    expect(result.current.value).toBe(-5);
  });

  test('increment/decrement step by 1 by default', () => {
    const { result } = renderHook(() => useTranspose());
    act(() => result.current.increment());
    act(() => result.current.increment());
    act(() => result.current.decrement());
    expect(result.current.value).toBe(1);
  });

  test('increment accepts a custom step', () => {
    const { result } = renderHook(() => useTranspose());
    act(() => result.current.increment(3));
    expect(result.current.value).toBe(3);
  });

  test('clamps at the max / min boundary and stays idempotent there', () => {
    const { result } = renderHook(() => useTranspose({ min: 0, max: 2 }));
    act(() => result.current.increment());
    act(() => result.current.increment());
    act(() => result.current.increment()); // clamps
    act(() => result.current.increment()); // still clamped
    expect(result.current.value).toBe(2);
    act(() => result.current.decrement(99));
    expect(result.current.value).toBe(0);
  });

  test('setValue clamps the supplied value', () => {
    const { result } = renderHook(() => useTranspose({ min: -3, max: 3 }));
    act(() => result.current.setValue(10));
    expect(result.current.value).toBe(3);
    act(() => result.current.setValue(-10));
    expect(result.current.value).toBe(-3);
  });

  test('reset returns to the initial value (not zero when initial was non-zero)', () => {
    const { result } = renderHook(() => useTranspose({ initial: 2 }));
    act(() => result.current.increment(5));
    expect(result.current.value).toBe(7);
    act(() => result.current.reset());
    expect(result.current.value).toBe(2);
  });
});

describe('<Transpose>', () => {
  test('renders the controlled value as a select with default ±6 options', () => {
    render(<Transpose value={3} onChange={vi.fn()} />);
    const select = getSelect();
    expect(select.value).toBe('3');
    const options = Array.from(select.options);
    expect(options).toHaveLength(13); // +6..-6 inclusive
    // Highest offset first: + at the top, − at the bottom.
    expect(options[0].value).toBe('6');
    expect(options[options.length - 1].value).toBe('-6');
  });

  test('selected option shows a + sign for positive values', () => {
    render(<Transpose value={3} onChange={vi.fn()} />);
    expect(getSelectedText()).toBe('+3');
  });

  test('selected option drops the + for zero and shows − for negatives', () => {
    const { rerender } = render(<Transpose value={0} onChange={vi.fn()} />);
    expect(getSelectedText()).toBe('0');
    rerender(<Transpose value={-2} onChange={vi.fn()} />);
    expect(getSelectedText()).toBe('-2');
  });

  test('changing the select emits the parsed value', () => {
    const onChange = vi.fn();
    render(<Transpose value={0} onChange={onChange} />);
    fireEvent.change(getSelect(), { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.change(getSelect(), { target: { value: '-3' } });
    expect(onChange).toHaveBeenLastCalledWith(-3);
  });

  test('explicit min/max props widen the option range past the default ±6 cap', () => {
    render(<Transpose value={0} onChange={vi.fn()} min={-11} max={11} />);
    const options = Array.from(getSelect().options);
    expect(options).toHaveLength(23); // +11..-11 inclusive
    expect(options[0].value).toBe('11');
    expect(options[options.length - 1].value).toBe('-11');
  });

  test('forwards unknown props to the wrapper div', () => {
    render(<Transpose value={0} onChange={vi.fn()} data-testid="t" className="custom" />);
    const wrapper = screen.getByTestId('t');
    expect(wrapper.className).toContain('chordsketch-transpose');
    expect(wrapper.className).toContain('custom');
  });

  test('custom formatValue controls the option text', () => {
    render(
      <Transpose
        value={2}
        onChange={vi.fn()}
        formatValue={(v) => `${v} st`}
      />,
    );
    expect(getSelectedText()).toBe('2 st');
  });

  test('clamps an out-of-range value prop so the selection stays in range', () => {
    // Host passes `value=15` with default `max=6`: the render-time
    // clamp pins the selected option to `+6` (the select has no
    // `15` option to land on).
    render(<Transpose value={15} onChange={vi.fn()} />);
    expect(getSelect().value).toBe('6');
    expect(getSelectedText()).toBe('+6');
  });

  test('step=2 generates every-other-semitone options in descending order', () => {
    render(<Transpose value={0} onChange={vi.fn()} min={-6} max={6} step={2} />);
    const values = Array.from(getSelect().options).map((o) => o.value);
    expect(values).toEqual(['6', '4', '2', '0', '-2', '-4', '-6']);
  });

  test('an off-grid value snaps to the nearest rendered option (step=2)', () => {
    // `value=3` is in range but not on the every-2 grid. The select
    // has no `3` option, so the control must snap to the nearest one
    // (`2` or `4`) rather than silently showing `+6` (selectedIndex 0).
    render(<Transpose value={3} onChange={vi.fn()} min={-6} max={6} step={2} />);
    const selected = Number.parseInt(getSelect().value, 10);
    expect([2, 4]).toContain(selected);
    // Whatever it snaps to must be an option that actually exists.
    const values = Array.from(getSelect().options).map((o) => o.value);
    expect(values).toContain(getSelect().value);
  });

  test('renders no options when max < min', () => {
    render(<Transpose value={0} onChange={vi.fn()} min={6} max={-6} />);
    expect(Array.from(getSelect().options)).toHaveLength(0);
  });

  test('changing the select to a programmatic out-of-range value clamps the emitted value', () => {
    // A test driver (or unusual browser automation) may fire a change
    // event with a value that is not among the rendered options.
    // `handleSelectChange` still applies `clamp` before forwarding to
    // `onChange`, so the emitted value always stays within [min, max].
    const onChange = vi.fn();
    render(<Transpose value={0} onChange={onChange} />);
    fireEvent.change(getSelect(), { target: { value: '99' } });
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.change(getSelect(), { target: { value: '-99' } });
    expect(onChange).toHaveBeenLastCalledWith(-6);
  });
});
