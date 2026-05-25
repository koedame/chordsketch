import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { Transpose, useTranspose } from '../src/index';

function getSlider(): HTMLInputElement {
  return screen.getByRole('slider', { name: 'Transpose' }) as HTMLInputElement;
}

// The tick rail renders the same numerals (e.g. `0`, `+3`) as the
// readout, so plain text queries match more than once. Target the
// `<output>` element directly when asserting on the displayed value.
function getReadoutText(): string {
  const out = document.querySelector('.chordsketch-transpose__value');
  return out?.textContent ?? '';
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
  test('renders the controlled value as a range slider with default ±6 bounds', () => {
    render(<Transpose value={3} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
    const slider = getSlider();
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('-6');
    expect(slider.max).toBe('6');
    expect(slider.value).toBe('3');
  });

  test('renders the readout with a + sign for positive values', () => {
    render(<Transpose value={3} onChange={vi.fn()} />);
    expect(getReadoutText()).toBe('+3');
  });

  test('renders without a + for zero and a − for negatives', () => {
    const { rerender } = render(<Transpose value={0} onChange={vi.fn()} />);
    expect(getReadoutText()).toBe('0');
    rerender(<Transpose value={-2} onChange={vi.fn()} />);
    expect(getReadoutText()).toBe('-2');
  });

  test('changing the slider emits the parsed value', () => {
    const onChange = vi.fn();
    render(<Transpose value={0} onChange={onChange} />);
    fireEvent.change(getSlider(), { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.change(getSlider(), { target: { value: '-3' } });
    expect(onChange).toHaveBeenLastCalledWith(-3);
  });

  test('clamps programmatic values outside min/max to the bound', () => {
    const onChange = vi.fn();
    render(<Transpose value={0} onChange={onChange} />);
    fireEvent.change(getSlider(), { target: { value: '99' } });
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.change(getSlider(), { target: { value: '-99' } });
    expect(onChange).toHaveBeenLastCalledWith(-6);
  });

  test('explicit min/max props widen past the default ±6 cap', () => {
    render(<Transpose value={0} onChange={vi.fn()} min={-11} max={11} />);
    const slider = getSlider();
    expect(slider.min).toBe('-11');
    expect(slider.max).toBe('11');
  });

  test('forwards unknown props to the wrapper div', () => {
    render(<Transpose value={0} onChange={vi.fn()} data-testid="t" className="custom" />);
    const group = screen.getByTestId('t');
    expect(group.className).toContain('chordsketch-transpose');
    expect(group.className).toContain('custom');
  });

  test('custom formatValue controls the indicator text', () => {
    render(
      <Transpose
        value={2}
        onChange={vi.fn()}
        formatValue={(v) => `${v} st`}
      />,
    );
    expect(getReadoutText()).toBe('2 st');
  });

  test('clamps an out-of-range value prop in the readout (display path)', () => {
    // Host passes `value=15` with default `max=6`: the native
    // range input clamps the thumb to `+6` visually, but the
    // `<output>` would otherwise show `+15` and disagree with
    // the thumb. Pin the render-time clamp.
    render(<Transpose value={15} onChange={vi.fn()} />);
    expect(getReadoutText()).toBe('+6');
  });
});
