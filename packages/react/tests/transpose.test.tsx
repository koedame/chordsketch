import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { Transpose, useTranspose } from '../src/index';

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
  test('renders current value with a + sign for positive values', () => {
    render(<Transpose value={3} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
  });

  test('renders without a + for zero and a − for negatives', () => {
    const { rerender } = render(<Transpose value={0} onChange={vi.fn()} />);
    expect(screen.getByText('0')).toBeTruthy();
    rerender(<Transpose value={-2} onChange={vi.fn()} />);
    expect(screen.getByText('-2')).toBeTruthy();
  });

  test('clicking + / − fires onChange with the clamped next value', () => {
    const onChange = vi.fn();
    render(<Transpose value={10} onChange={onChange} max={11} min={-11} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transpose up one semitone' }));
    expect(onChange).toHaveBeenLastCalledWith(11);
    fireEvent.click(screen.getByRole('button', { name: 'Transpose down one semitone' }));
    expect(onChange).toHaveBeenLastCalledWith(9);
  });

  test('increment button is disabled at max, decrement button disabled at min', () => {
    const { rerender } = render(<Transpose value={11} onChange={vi.fn()} max={11} min={-11} />);
    const upButton = screen.getByRole('button', { name: 'Transpose up one semitone' });
    expect(upButton.hasAttribute('disabled')).toBe(true);
    rerender(<Transpose value={-11} onChange={vi.fn()} max={11} min={-11} />);
    const downButton = screen.getByRole('button', { name: 'Transpose down one semitone' });
    expect(downButton.hasAttribute('disabled')).toBe(true);
  });

  test('reset button appears only when value is non-zero', () => {
    const { rerender } = render(<Transpose value={0} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Reset transposition to zero' })).toBeNull();
    rerender(<Transpose value={3} onChange={vi.fn()} />);
    const reset = screen.getByRole('button', { name: 'Reset transposition to zero' });
    expect(reset).toBeTruthy();
  });

  test('reset button click fires onChange with 0', () => {
    const onChange = vi.fn();
    render(<Transpose value={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset transposition to zero' }));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  test('resetValue prop emits that value on reset click and updates aria-label', () => {
    const onChange = vi.fn();
    render(<Transpose value={3} onChange={onChange} resetValue={2} />);
    const resetButton = screen.getByRole('button', { name: 'Reset transposition to 2' });
    fireEvent.click(resetButton);
    expect(onChange).toHaveBeenCalledWith(2);
  });

  test('out-of-range resetValue is clamped to [min, max] before onChange fires', () => {
    const onChange = vi.fn();
    render(
      <Transpose
        value={3}
        onChange={onChange}
        resetValue={15}
        min={-11}
        max={11}
      />,
    );
    // The button advertises the clamped value (11) so the
    // on-click payload must match — otherwise the label lies
    // about what clicking does. Regression guard for #2172.
    const resetButton = screen.getByRole('button', { name: 'Reset transposition to 11' });
    fireEvent.click(resetButton);
    expect(onChange).toHaveBeenCalledWith(11);
  });

  test('reset button is hidden when value equals resetValue (not just zero)', () => {
    const { rerender } = render(<Transpose value={2} onChange={vi.fn()} resetValue={2} />);
    expect(screen.queryByRole('button', { name: /Reset transposition/ })).toBeNull();
    rerender(<Transpose value={3} onChange={vi.fn()} resetValue={2} />);
    expect(screen.getByRole('button', { name: 'Reset transposition to 2' })).toBeTruthy();
  });

  test('keyboard 0 emits resetValue when set, and is a no-op at resetValue', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Transpose value={3} onChange={onChange} resetValue={2} />,
    );
    fireEvent.keyDown(screen.getByRole('group'), { key: '0' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    onChange.mockClear();
    rerender(<Transpose value={2} onChange={onChange} resetValue={2} />);
    fireEvent.keyDown(screen.getByRole('group'), { key: '0' });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('keyboard shortcuts: + / - / 0 fire onChange', () => {
    const onChange = vi.fn();
    render(<Transpose value={2} onChange={onChange} />);
    const group = screen.getByRole('group');
    fireEvent.keyDown(group, { key: '+' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(group, { key: '-' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(group, { key: '0' });
    expect(onChange).toHaveBeenLastCalledWith(0);
    // Unrelated keys do not fire onChange.
    onChange.mockClear();
    fireEvent.keyDown(group, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('keyboard 0 on a zero-value input is a no-op (does not spuriously fire onChange)', () => {
    const onChange = vi.fn();
    render(<Transpose value={0} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('group'), { key: '0' });
    expect(onChange).not.toHaveBeenCalled();
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
    expect(screen.getByText('2 st')).toBeTruthy();
  });

  test('aria-labels reflect the actual step size when step != 1', () => {
    render(<Transpose value={0} onChange={vi.fn()} step={2} />);
    expect(screen.getByRole('button', { name: 'Transpose up 2 semitones' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Transpose down 2 semitones' })).toBeTruthy();
  });
});
