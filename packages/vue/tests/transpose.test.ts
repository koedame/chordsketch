import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';

import {
  TRANSPOSE_DEFAULT_MAX,
  TRANSPOSE_DEFAULT_MIN,
  Transpose,
  useTranspose,
} from '../src/index';

function optionValues(wrapper: ReturnType<typeof mount>): number[] {
  return wrapper.findAll('option').map((o) => Number(o.attributes('value')));
}

describe('useTranspose', () => {
  test('starts at 0 by default', () => {
    expect(useTranspose().value.value).toBe(0);
  });

  test('clamps the initial value into [min, max]', () => {
    expect(useTranspose({ initial: 999, min: -5, max: 5 }).value.value).toBe(5);
  });

  test('collapses an initial NaN to min', () => {
    expect(useTranspose({ initial: Number.NaN, min: -5, max: 5 }).value.value).toBe(-5);
  });

  test('increments and decrements by 1 by default', () => {
    const t = useTranspose();
    t.increment();
    t.increment();
    t.decrement();
    expect(t.value.value).toBe(1);
  });

  test('accepts a custom step', () => {
    const t = useTranspose();
    t.increment(3);
    expect(t.value.value).toBe(3);
  });

  test('stays idempotent at the clamp boundary', () => {
    const t = useTranspose({ min: 0, max: 2 });
    t.increment();
    t.increment();
    t.increment();
    t.increment();
    expect(t.value.value).toBe(2);
    t.decrement(99);
    expect(t.value.value).toBe(0);
  });

  test('setValue clamps the supplied value', () => {
    const t = useTranspose({ min: -3, max: 3 });
    t.setValue(10);
    expect(t.value.value).toBe(3);
    t.setValue(-10);
    expect(t.value.value).toBe(-3);
  });

  test('reset returns to the initial value, not to zero', () => {
    const t = useTranspose({ initial: 2 });
    t.increment(5);
    expect(t.value.value).toBe(7);
    t.reset();
    expect(t.value.value).toBe(2);
  });
});

describe('Transpose', () => {
  test('lists every offset from max down to min', () => {
    const wrapper = mount(Transpose, { props: { modelValue: 0 } });
    const values = optionValues(wrapper);
    expect(values[0]).toBe(TRANSPOSE_DEFAULT_MAX);
    expect(values[values.length - 1]).toBe(TRANSPOSE_DEFAULT_MIN);
    expect(values).toHaveLength(TRANSPOSE_DEFAULT_MAX - TRANSPOSE_DEFAULT_MIN + 1);
  });

  test('honours min / max / step', () => {
    const wrapper = mount(Transpose, {
      props: { modelValue: 0, min: -4, max: 4, step: 2 },
    });
    expect(optionValues(wrapper)).toEqual([4, 2, 0, -2, -4]);
  });

  test('formats options as signed integers by default', () => {
    const wrapper = mount(Transpose, { props: { modelValue: 0, min: -1, max: 1 } });
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual(['+1', '0', '-1']);
  });

  test('applies a custom formatValue', () => {
    const wrapper = mount(Transpose, {
      props: { modelValue: 0, min: 0, max: 1, formatValue: (v: number) => `${v} st` },
    });
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual(['1 st', '0 st']);
  });

  test('emits the selected offset', async () => {
    const wrapper = mount(Transpose, { props: { modelValue: 0 } });
    await wrapper.get('select').setValue('3');
    expect(wrapper.emitted('update:modelValue')).toEqual([[3]]);
  });

  test('clamps an emitted value into [min, max]', async () => {
    // A select can only emit values it renders, so the clamp is a
    // guard against a host that injects its own <option>.
    const wrapper = mount(Transpose, { props: { modelValue: 0, min: -2, max: 2 } });
    const select = wrapper.get('select').element as HTMLSelectElement;
    const rogue = document.createElement('option');
    rogue.value = '9';
    select.appendChild(rogue);
    select.value = '9';
    await wrapper.get('select').trigger('change');
    expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);
  });

  test('snaps an off-grid value to the nearest rendered option', () => {
    const wrapper = mount(Transpose, {
      props: { modelValue: 3, min: -4, max: 4, step: 2 },
    });
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('4');
  });

  test('snaps an out-of-range value to the boundary option', () => {
    const wrapper = mount(Transpose, { props: { modelValue: 99, min: -2, max: 2 } });
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('2');
  });

  test('renders an inert, empty select for a non-positive step', () => {
    const wrapper = mount(Transpose, { props: { modelValue: 0, step: 0 } });
    expect(wrapper.findAll('option')).toHaveLength(0);
  });

  test('labels the group and the select', () => {
    const wrapper = mount(Transpose, { props: { modelValue: 0 } });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.attributes('aria-label')).toBe('Transpose');
    expect(wrapper.get('select').attributes('aria-label')).toBe('Transpose');
    expect(wrapper.get('.chordsketch-transpose__label').text()).toBe('Transpose');
  });

  test('label=null hides the visible label but keeps the accessible name', () => {
    const wrapper = mount(Transpose, { props: { modelValue: 0, label: null } });
    expect(wrapper.find('.chordsketch-transpose__label').exists()).toBe(false);
    expect(wrapper.get('select').attributes('aria-label')).toBe('Transpose');
  });

  test('an explicit aria-label wins over the label text', () => {
    const wrapper = mount(Transpose, {
      props: { modelValue: 0, label: 'Key' },
      attrs: { 'aria-label': 'Transpose the song' },
    });
    expect(wrapper.get('select').attributes('aria-label')).toBe('Transpose the song');
  });
});
