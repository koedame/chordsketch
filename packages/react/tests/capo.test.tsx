import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { Capo } from '../src/index';

function getSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Capo' }) as HTMLSelectElement;
}

function bestCapoOptionValues(): string[] {
  return Array.from(document.querySelectorAll('option[data-best-capo]')).map((o) =>
    o.getAttribute('data-best-capo') ?? '',
  );
}

describe('<Capo>', () => {
  test('renders the controlled value as a select with 0..12 options', () => {
    render(<Capo value={3} onChange={vi.fn()} />);
    const select = getSelect();
    expect(select.value).toBe('3');
    const options = Array.from(select.options);
    expect(options).toHaveLength(13); // 12..0 inclusive
    // Highest fret first: 12 at the top, 0 at the bottom.
    expect(options[0].value).toBe('12');
    expect(options[options.length - 1].value).toBe('0');
  });

  test('changing the select emits the parsed value in controlled mode', () => {
    const onChange = vi.fn();
    render(<Capo value={0} onChange={onChange} />);
    fireEvent.change(getSelect(), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  test('source-pair mode reads {capo} from the source string', () => {
    const onSourceChange = vi.fn();
    render(
      <Capo
        source={'{title: Demo}\n{capo: 5}\n[C]Hello'}
        onSourceChange={onSourceChange}
      />,
    );
    expect(getSelect().value).toBe('5');
  });

  test('source-pair mode rewrites the directive on select change', () => {
    function Host(): JSX.Element {
      const [source, setSource] = useState('{title: Demo}\n[C]Hello');
      return (
        <>
          <Capo source={source} onSourceChange={setSource} />
          <pre data-testid="src">{source}</pre>
        </>
      );
    }

    render(<Host />);
    expect(getSelect().value).toBe('0');
    fireEvent.change(getSelect(), { target: { value: '1' } });
    expect(screen.getByTestId('src').textContent).toBe(
      '{title: Demo}\n{capo: 1}\n[C]Hello',
    );
    expect(getSelect().value).toBe('1');
  });

  test('source-pair mode fires onCapoChange alongside onSourceChange', () => {
    const onSourceChange = vi.fn();
    const onCapoChange = vi.fn();
    render(
      <Capo
        source={'{title: Demo}\n{capo: 2}\n[C]Hello'}
        onSourceChange={onSourceChange}
        onCapoChange={onCapoChange}
      />,
    );
    fireEvent.change(getSelect(), { target: { value: '3' } });
    expect(onSourceChange).toHaveBeenCalledWith(
      '{title: Demo}\n{capo: 3}\n[C]Hello',
    );
    expect(onCapoChange).toHaveBeenLastCalledWith(3);
  });

  test('honours custom min/max bounds in the option range', () => {
    render(<Capo value={3} onChange={vi.fn()} min={0} max={3} />);
    const options = Array.from(getSelect().options);
    expect(options).toHaveLength(4); // 3..0 inclusive
    expect(options[0].value).toBe('3');
    expect(options[options.length - 1].value).toBe('0');
  });

  test('flags ★ on each bestPositions option inside the range', () => {
    render(
      <Capo value={0} onChange={vi.fn()} bestPositions={[0, 5, 7, 99]} />,
    );
    // Options render highest-first, so the flagged ones appear in
    // descending DOM order.
    expect(bestCapoOptionValues()).toEqual(['7', '5', '0']);
    // The ★ glyph is appended to the flagged option's visible text.
    const opt5 = Array.from(getSelect().options).find((o) => o.value === '5');
    expect(opt5?.textContent).toContain('★');
  });

  test('flags no option when bestPositions is empty', () => {
    render(<Capo value={0} onChange={vi.fn()} bestPositions={[]} />);
    expect(bestCapoOptionValues()).toEqual([]);
    expect(document.querySelector('.chordsketch-capo__sr-only')).toBeNull();
  });

  test('rejects NaN, Infinity, and non-integer entries from bestPositions', () => {
    // NaN slips through `pos < min || pos > max` because every NaN
    // comparison evaluates to false. Without the `Number.isInteger`
    // guard a `data-best-capo="NaN"` option would render. Test the
    // full set of pathological inputs in one shot.
    render(
      <Capo
        value={0}
        onChange={vi.fn()}
        bestPositions={[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 3.5, 4]}
      />,
    );
    expect(bestCapoOptionValues()).toEqual(['4']);
  });

  test('reflects the controlled value as the select value', () => {
    render(<Capo value={4} onChange={vi.fn()} />);
    expect(getSelect().value).toBe('4');
  });

  test('clamps an out-of-range value prop so the selection stays in range', () => {
    // Host passing `value=15` with `max=12`: the render-time clamp
    // pins the selection to `12` (no `15` option exists to land on).
    render(<Capo value={15} onChange={vi.fn()} min={0} max={12} />);
    expect(getSelect().value).toBe('12');
  });

  test('step=2 generates every-other-fret options in descending order', () => {
    render(<Capo value={0} onChange={vi.fn()} min={0} max={12} step={2} />);
    const values = Array.from(getSelect().options).map((o) => o.value);
    expect(values).toEqual(['12', '10', '8', '6', '4', '2', '0']);
  });

  test('an off-grid value snaps to the nearest rendered option (step=2)', () => {
    // `value=3` is in range but off the every-2 grid; snap to 2 or 4
    // rather than silently showing the first option.
    render(<Capo value={3} onChange={vi.fn()} min={0} max={12} step={2} />);
    const selected = Number.parseInt(getSelect().value, 10);
    expect([2, 4]).toContain(selected);
    const values = Array.from(getSelect().options).map((o) => o.value);
    expect(values).toContain(getSelect().value);
  });

  test('an unambiguously-nearest option is selected when value is off-grid (step=3)', () => {
    // options are 12,9,6,3,0; value=5 is distance 1 from 6 and 2 from
    // 3 — must snap to 6, not the first option.
    render(<Capo value={5} onChange={vi.fn()} min={0} max={12} step={3} />);
    expect(getSelect().value).toBe('6');
  });

  test('source-pair mode snaps an off-grid {capo} directive to the nearest option', () => {
    render(
      <Capo
        source={'{title: Demo}\n{capo: 3}\n[C]Hello'}
        onSourceChange={vi.fn()}
        step={2}
      />,
    );
    const selected = Number.parseInt(getSelect().value, 10);
    expect([2, 4]).toContain(selected);
    const values = Array.from(getSelect().options).map((o) => o.value);
    expect(values).toContain(getSelect().value);
  });

  test('each flagged option carries data-best-capo equal to its own value', () => {
    render(<Capo value={0} onChange={vi.fn()} bestPositions={[5, 7]} />);
    const flagged = Array.from(document.querySelectorAll('option[data-best-capo]'));
    expect(flagged.length).toBe(2);
    for (const opt of flagged) {
      expect(opt.getAttribute('data-best-capo')).toBe(opt.getAttribute('value'));
    }
  });

  test('renders no options when max < min', () => {
    render(<Capo value={0} onChange={vi.fn()} min={12} max={0} />);
    expect(Array.from(getSelect().options)).toHaveLength(0);
  });

  test('sr-only description is plural when multiple best positions are flagged', () => {
    render(<Capo value={0} onChange={vi.fn()} bestPositions={[3, 5]} />);
    expect(
      document.querySelector('.chordsketch-capo__sr-only')?.textContent,
    ).toContain('positions');
  });

  test('sr-only description is singular when exactly one best position is flagged', () => {
    render(<Capo value={0} onChange={vi.fn()} bestPositions={[5]} />);
    const text = document.querySelector('.chordsketch-capo__sr-only')?.textContent ?? '';
    expect(text).toContain('position');
    expect(text).not.toContain('positions');
  });

  test('custom formatValue combines with the ★ suffix on a flagged option', () => {
    render(
      <Capo
        value={0}
        onChange={vi.fn()}
        bestPositions={[5]}
        formatValue={(v) => `Fret ${v}`}
      />,
    );
    const opt5 = Array.from(getSelect().options).find((o) => o.value === '5');
    expect(opt5?.textContent).toBe('Fret 5 ★');
  });
});
