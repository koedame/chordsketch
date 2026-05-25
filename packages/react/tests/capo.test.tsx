import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { Capo } from '../src/index';

function getSlider(): HTMLInputElement {
  return screen.getByRole('slider', { name: 'Capo' }) as HTMLInputElement;
}

describe('<Capo>', () => {
  test('renders the controlled value as a range slider', () => {
    render(<Capo value={3} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Capo' })).toBeTruthy();
    const slider = getSlider();
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('12');
    expect(slider.value).toBe('3');
  });

  test('changing the slider emits the parsed value in controlled mode', () => {
    const onChange = vi.fn();
    render(<Capo value={0} onChange={onChange} />);
    fireEvent.change(getSlider(), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  test('clamps a programmatic value outside min/max to the bound', () => {
    const onChange = vi.fn();
    render(<Capo value={0} onChange={onChange} min={0} max={5} />);
    fireEvent.change(getSlider(), { target: { value: '9' } });
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  test('source-pair mode reads {capo} from the source string', () => {
    const onSourceChange = vi.fn();
    render(
      <Capo
        source={'{title: Demo}\n{capo: 5}\n[C]Hello'}
        onSourceChange={onSourceChange}
      />,
    );
    expect(getSlider().value).toBe('5');
  });

  test('source-pair mode rewrites the directive on slider change', () => {
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
    expect(getSlider().value).toBe('0');
    fireEvent.change(getSlider(), { target: { value: '1' } });
    expect(screen.getByTestId('src').textContent).toBe(
      '{title: Demo}\n{capo: 1}\n[C]Hello',
    );
    expect(getSlider().value).toBe('1');
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
    fireEvent.change(getSlider(), { target: { value: '3' } });
    expect(onSourceChange).toHaveBeenCalledWith(
      '{title: Demo}\n{capo: 3}\n[C]Hello',
    );
    expect(onCapoChange).toHaveBeenLastCalledWith(3);
  });

  test('honours custom min/max bounds', () => {
    render(<Capo value={3} onChange={vi.fn()} min={0} max={3} />);
    const slider = getSlider();
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('3');
  });

  test('renders ★ markers for each bestPositions entry inside the range', () => {
    render(
      <Capo value={0} onChange={vi.fn()} bestPositions={[0, 5, 7, 99]} />,
    );
    const markers = document.querySelectorAll('.chordsketch-capo__marker');
    expect(markers.length).toBe(3);
    const positions = Array.from(markers).map((m) =>
      m.getAttribute('data-best-capo'),
    );
    expect(positions).toEqual(['0', '5', '7']);
  });

  test('omits the ★ marker block when bestPositions is empty', () => {
    render(<Capo value={0} onChange={vi.fn()} bestPositions={[]} />);
    expect(document.querySelector('.chordsketch-capo__markers')).toBeNull();
  });

  test('rejects NaN, Infinity, and non-integer entries from bestPositions', () => {
    // NaN slips through `pos < min || pos > max` because every NaN
    // comparison evaluates to false. Without the `Number.isInteger`
    // guard the marker span would render with `left: NaN%`. Test
    // the full set of pathological inputs in one shot.
    render(
      <Capo
        value={0}
        onChange={vi.fn()}
        bestPositions={[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 3.5, 4]}
      />,
    );
    const markers = document.querySelectorAll('.chordsketch-capo__marker');
    expect(markers.length).toBe(1);
    expect(markers[0]?.getAttribute('data-best-capo')).toBe('4');
  });

  test('exposes the slider value via the visible readout', () => {
    // The tick rail now labels every step, so a plain `getByText('4')`
    // would match the tick label as well as the `<output>` readout.
    // Target the `<output>` element directly.
    render(<Capo value={4} onChange={vi.fn()} />);
    const out = document.querySelector('.chordsketch-capo__value');
    expect(out?.textContent).toBe('4');
  });

  test('clamps an out-of-range value prop in the readout (display path)', () => {
    // Host passing `value=15` with `max=12`: the native range
    // input clamps the thumb visually, but the `<output>` would
    // otherwise display the raw 15 and disagree with the thumb.
    // Pin the render-time clamp.
    render(<Capo value={15} onChange={vi.fn()} min={0} max={12} />);
    const out = document.querySelector('.chordsketch-capo__value');
    expect(out?.textContent).toBe('12');
  });
});
