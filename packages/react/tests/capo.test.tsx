import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { Capo } from '../src/index';

describe('<Capo>', () => {
  test('renders the controlled value with the +/− buttons', () => {
    render(<Capo value={3} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Capo' })).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capo down one fret' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capo up one fret' })).toBeTruthy();
  });

  test('clicking +/− emits the clamped next value in controlled mode', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Capo value={0} onChange={onChange} />);
    // − is disabled at min — clicking does nothing.
    const down = screen.getByRole('button', { name: 'Capo down one fret' });
    expect((down as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Capo up one fret' }));
    expect(onChange).toHaveBeenCalledWith(1);

    rerender(<Capo value={12} onChange={onChange} />);
    const up = screen.getByRole('button', { name: 'Capo up one fret' });
    expect((up as HTMLButtonElement).disabled).toBe(true);
  });

  test('reset button is hidden at the reset value and emits 0 when shown', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Capo value={0} onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Reset capo to zero' })).toBeNull();

    rerender(<Capo value={4} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset capo to zero' }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  test('source-pair mode reads {capo} from the source string', () => {
    const onSourceChange = vi.fn();
    render(
      <Capo
        source={'{title: Demo}\n{capo: 5}\n[C]Hello'}
        onSourceChange={onSourceChange}
      />,
    );
    expect(screen.getByText('5')).toBeTruthy();
  });

  test('source-pair mode rewrites the directive on a +/− click', () => {
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
    expect(screen.getByText('0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Capo up one fret' }));
    // The host's source state now contains the inserted directive.
    expect(screen.getByTestId('src').textContent).toBe(
      '{title: Demo}\n{capo: 1}\n[C]Hello',
    );
    // The readout reflects the new value derived from the source.
    expect(screen.getByText('1')).toBeTruthy();
  });

  test('keyboard shortcuts step and reset', () => {
    const onChange = vi.fn();
    render(<Capo value={2} onChange={onChange} />);
    const wrapper = screen.getByRole('group', { name: 'Capo' });
    fireEvent.keyDown(wrapper, { key: '+' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(wrapper, { key: '-' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(wrapper, { key: '0' });
    expect(onChange).toHaveBeenLastCalledWith(0);
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
    fireEvent.click(screen.getByRole('button', { name: 'Capo up one fret' }));
    expect(onSourceChange).toHaveBeenCalledWith(
      '{title: Demo}\n{capo: 3}\n[C]Hello',
    );
    expect(onCapoChange).toHaveBeenLastCalledWith(3);
  });

  test('honours custom min/max bounds', () => {
    const onChange = vi.fn();
    render(<Capo value={3} onChange={onChange} min={0} max={3} />);
    const up = screen.getByRole('button', { name: 'Capo up one fret' });
    expect((up as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up);
    expect(onChange).not.toHaveBeenCalled();
  });
});
