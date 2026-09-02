import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';

import {
  TRANSPOSE_DEFAULT_MAX,
  TRANSPOSE_DEFAULT_MIN,
  Transpose,
  useTranspose,
} from '../src/index';
import TransposeBinding from './harness/TransposeBinding.svelte';

afterEach(cleanup);

function optionValues(container: HTMLElement): number[] {
  return [...container.querySelectorAll('option')].map((o) => Number(o.value));
}

function optionLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('option')].map((o) => o.textContent ?? '');
}

describe('useTranspose', () => {
  test('starts at 0 by default', () => {
    expect(useTranspose().value).toBe(0);
  });

  test('clamps the initial value into [min, max]', () => {
    expect(useTranspose({ initial: 999, min: -5, max: 5 }).value).toBe(5);
  });

  test('collapses an initial NaN to min', () => {
    expect(useTranspose({ initial: Number.NaN, min: -5, max: 5 }).value).toBe(-5);
  });

  test('increments and decrements by 1 by default', () => {
    const t = useTranspose();
    t.increment();
    t.increment();
    t.decrement();
    expect(t.value).toBe(1);
  });

  test('accepts a custom step', () => {
    const t = useTranspose();
    t.increment(3);
    expect(t.value).toBe(3);
  });

  test('stays idempotent at the clamp boundary', () => {
    const t = useTranspose({ min: 0, max: 2 });
    t.increment();
    t.increment();
    t.increment();
    t.increment();
    expect(t.value).toBe(2);
    t.decrement(99);
    expect(t.value).toBe(0);
  });

  test('setValue clamps the supplied value', () => {
    const t = useTranspose({ min: -3, max: 3 });
    t.setValue(10);
    expect(t.value).toBe(3);
    t.setValue(-10);
    expect(t.value).toBe(-3);
  });

  test('assigning to value clamps it too, so bind:value cannot escape the range', () => {
    const t = useTranspose({ min: -3, max: 3 });
    t.value = 10;
    expect(t.value).toBe(3);
  });

  test('reset returns to the initial value, not to zero', () => {
    const t = useTranspose({ initial: 2 });
    t.increment(5);
    expect(t.value).toBe(7);
    t.reset();
    expect(t.value).toBe(2);
  });
});

describe('Transpose', () => {
  test('lists every offset from max down to min', () => {
    const { container } = render(Transpose, { props: { value: 0 } });
    const values = optionValues(container);
    expect(values[0]).toBe(TRANSPOSE_DEFAULT_MAX);
    expect(values[values.length - 1]).toBe(TRANSPOSE_DEFAULT_MIN);
    expect(values).toHaveLength(TRANSPOSE_DEFAULT_MAX - TRANSPOSE_DEFAULT_MIN + 1);
  });

  test('honours min / max / step', () => {
    const { container } = render(Transpose, {
      props: { value: 0, min: -4, max: 4, step: 2 },
    });
    expect(optionValues(container)).toEqual([4, 2, 0, -2, -4]);
  });

  test('formats options as signed integers by default', () => {
    const { container } = render(Transpose, { props: { value: 0, min: -1, max: 1 } });
    expect(optionLabels(container)).toEqual(['+1', '0', '-1']);
  });

  test('applies a custom formatValue', () => {
    const { container } = render(Transpose, {
      props: { value: 0, min: 0, max: 1, formatValue: (v: number) => `${v} st` },
    });
    expect(optionLabels(container)).toEqual(['1 st', '0 st']);
  });

  test('writes the selected offset back through bind:value', async () => {
    const { container, getByTestId } = render(TransposeBinding, { props: { value: 0 } });
    await fireEvent.change(container.querySelector('select')!, { target: { value: '3' } });
    expect(getByTestId('bound-value').textContent).toBe('3');
  });

  test('clamps the value it writes back into [min, max]', async () => {
    // A select can only emit values it renders, so the clamp is a
    // guard against a host that injects its own <option>.
    const { container, getByTestId } = render(TransposeBinding, {
      props: { value: 0, min: -2, max: 2 },
    });
    const select = container.querySelector('select')!;
    const rogue = document.createElement('option');
    rogue.value = '9';
    select.appendChild(rogue);
    select.value = '9';
    await fireEvent.change(select);
    expect(getByTestId('bound-value').textContent).toBe('2');
  });

  test('snaps an off-grid value to the nearest rendered option', () => {
    const { container } = render(Transpose, {
      props: { value: 3, min: -4, max: 4, step: 2 },
    });
    expect(container.querySelector('select')!.value).toBe('4');
  });

  test('snaps an out-of-range value to the boundary option', () => {
    const { container } = render(Transpose, { props: { value: 99, min: -2, max: 2 } });
    expect(container.querySelector('select')!.value).toBe('2');
  });

  test('renders an inert, empty select for a non-positive step', () => {
    const { container } = render(Transpose, { props: { value: 0, step: 0 } });
    expect(container.querySelectorAll('option')).toHaveLength(0);
  });

  test('labels the group and the select', () => {
    const { container } = render(Transpose, { props: { value: 0 } });
    const group = container.querySelector('.chordsketch-transpose')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Transpose');
    expect(container.querySelector('select')!.getAttribute('aria-label')).toBe('Transpose');
    expect(container.querySelector('.chordsketch-transpose__label')!.textContent).toBe(
      'Transpose',
    );
  });

  test('label=null hides the visible label but keeps the accessible name', () => {
    const { container } = render(Transpose, { props: { value: 0, label: null } });
    expect(container.querySelector('.chordsketch-transpose__label')).toBeNull();
    expect(container.querySelector('select')!.getAttribute('aria-label')).toBe('Transpose');
  });

  test('an explicit aria-label wins over the label text', () => {
    const { container } = render(Transpose, {
      props: { value: 0, label: 'Key', 'aria-label': 'Transpose the song' },
    });
    expect(container.querySelector('select')!.getAttribute('aria-label')).toBe(
      'Transpose the song',
    );
  });

  test('keeps the host class alongside its own', () => {
    const { container } = render(Transpose, { props: { value: 0, class: 'host-control' } });
    const group = container.querySelector('.chordsketch-transpose')!;
    expect(group.classList.contains('host-control')).toBe(true);
  });
});
