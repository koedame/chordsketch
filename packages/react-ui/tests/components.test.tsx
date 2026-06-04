import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { version } from '../src/index';
import { Button } from '../src/button';
import { Badge, Pill } from '../src/badge';
import { Card } from '../src/card';
import { Checkbox, Field, Input, Radio, Segmented, Select, Switch, Textarea } from '../src/form';

describe('Button', () => {
  test('composes btn + variant + size classes', () => {
    render(
      <Button variant="primary" size="sm">
        Save
      </Button>,
    );
    const el = screen.getByRole('button', { name: 'Save' });
    expect(el.className).toContain('btn');
    expect(el.className).toContain('btn-primary');
    expect(el.className).toContain('btn-sm');
  });

  test('renders an anchor with href when as="a"', () => {
    render(
      <Button as="a" href="/docs" variant="ghost" size="sm">
        Docs
      </Button>,
    );
    const el = screen.getByRole('link', { name: 'Docs' });
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/docs');
    expect(el.className).toContain('btn-ghost');
  });

  test('renders a spinner and stays disabled when loading', () => {
    render(
      <Button isLoading disabled>
        Saving
      </Button>,
    );
    const el = screen.getByRole('button', { name: 'Saving' });
    expect(el.querySelector('.spinner')).not.toBeNull();
    expect((el as HTMLButtonElement).disabled).toBe(true);
  });

  test('sets aria-busy when loading', () => {
    render(<Button isLoading>Saving</Button>);
    expect(screen.getByRole('button', { name: 'Saving' }).getAttribute('aria-busy')).toBe('true');
  });

  test('sets aria-busy on link variant when loading', () => {
    render(<Button as="a" href="/save" isLoading>Saving</Button>);
    expect(screen.getByRole('link', { name: 'Saving' }).getAttribute('aria-busy')).toBe('true');
  });

  test('defaults to type="button" to avoid accidental form submission', () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole('button', { name: 'Click' }).getAttribute('type')).toBe('button');
  });

  test('adds btn-icon for icon-only buttons', () => {
    render(<Button iconOnly aria-label="Close" />);
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('btn-icon');
  });

  test('renders the spinner inside the anchor variant when loading', () => {
    render(
      <Button as="a" href="/save" isLoading>
        Saving
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Saving' }).querySelector('.spinner')).not.toBeNull();
  });

  test('omits aria-busy when not loading, on both the button and anchor', () => {
    const { rerender } = render(<Button>Idle</Button>);
    expect(screen.getByRole('button', { name: 'Idle' }).hasAttribute('aria-busy')).toBe(false);
    rerender(
      <Button as="a" href="/x">
        Link
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Link' }).hasAttribute('aria-busy')).toBe(false);
  });

  test('forwards an explicit type="submit"', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('type')).toBe('submit');
  });

  test('suppresses navigation and marks aria-disabled on a loading link', () => {
    const onClick = vi.fn();
    render(
      <Button as="a" href="/save" isLoading onClick={onClick}>
        Saving
      </Button>,
    );
    const el = screen.getByRole('link', { name: 'Saving' });
    expect(el.getAttribute('aria-disabled')).toBe('true');
    const notPrevented = fireEvent.click(el);
    expect(notPrevented).toBe(false); // preventDefault() was called
    expect(onClick).not.toHaveBeenCalled();
  });

  test('forwards the caller onClick on a non-loading link', () => {
    const onClick = vi.fn();
    render(
      // preventDefault keeps jsdom from attempting (unimplemented) navigation;
      // the assertion is that the caller's handler runs at all when not loading.
      <Button
        as="a"
        href="/save"
        onClick={(event) => {
          event.preventDefault();
          onClick();
        }}
      >
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('forwards a caller className alongside the generated classes', () => {
    render(<Button className="extra">X</Button>);
    const cls = screen.getByRole('button', { name: 'X' }).className;
    expect(cls).toContain('btn');
    expect(cls).toContain('extra');
  });
});

describe('Badge / Pill', () => {
  test('maps the key-crimson variant to the canonical "badge key crimson-fill" classes', () => {
    render(<Badge variant="key-crimson">Em</Badge>);
    expect(screen.getByText('Em').className).toBe('badge key crimson-fill');
  });

  test('adds the dot modifier', () => {
    render(
      <Badge variant="success" dot>
        Saved
      </Badge>,
    );
    expect(screen.getByText('Saved').className).toContain('dot');
  });

  test('Pill renders the solid modifier', () => {
    render(<Pill solid>All</Pill>);
    expect(screen.getByText('All').className).toContain('solid');
  });

  test('maps the success variant to "badge success"', () => {
    render(<Badge variant="success">Active</Badge>);
    expect(screen.getByText('Active').className).toBe('badge success');
  });

  test('renders a bare badge with no variant class when variant is omitted', () => {
    render(<Badge>label</Badge>);
    expect(screen.getByText('label').className).toBe('badge');
  });

  test('Pill renders without the solid class by default', () => {
    render(<Pill>Jazz</Pill>);
    const cls = screen.getByText('Jazz').className;
    expect(cls).toContain('pill');
    expect(cls).not.toContain('solid');
  });
});

describe('Card', () => {
  test('renders an article with the featured song-card classes', () => {
    render(
      <Card variant="song" featured>
        body
      </Card>,
    );
    const el = screen.getByText('body');
    expect(el.tagName).toBe('ARTICLE');
    expect(el.className).toContain('song-card');
    expect(el.className).toContain('featured');
  });

  test('applies the setlist class for the setlist variant', () => {
    render(<Card variant="setlist">body</Card>);
    expect(screen.getByText('body').className).toContain('setlist');
  });

  test('applies the featured-card class for the featured variant', () => {
    render(<Card variant="featured">body</Card>);
    expect(screen.getByText('body').className).toContain('featured-card');
  });

  test('a plain song card has no featured class and does not leak the prop to the DOM', () => {
    render(<Card variant="song">body</Card>);
    const el = screen.getByText('body');
    expect(el.className).toContain('song-card');
    expect(el.className).not.toContain('featured');
    expect(el.hasAttribute('featured')).toBe(false);
  });
});

describe('Form', () => {
  test('Input applies the error class and aria-invalid when invalid', () => {
    render(<Input invalid aria-label="Email" />);
    const el = screen.getByLabelText('Email');
    expect(el.className).toContain('error');
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  test('Input omits the error class and aria-invalid by default', () => {
    render(<Input aria-label="Name" />);
    const el = screen.getByLabelText('Name');
    expect(el.className).not.toContain('error');
    expect(el.hasAttribute('aria-invalid')).toBe(false);
  });

  test('Textarea renders with the textarea class', () => {
    render(<Textarea aria-label="Notes" />);
    expect(screen.getByLabelText('Notes').className).toContain('textarea');
  });

  test('Select renders with the select class and passes children', () => {
    const { container } = render(
      <Select aria-label="Key">
        <option value="C">C</option>
      </Select>,
    );
    expect(screen.getByLabelText('Key').className).toContain('select');
    expect(container.querySelector('option[value="C"]')).not.toBeNull();
  });

  test('Checkbox renders a .check label with a checkbox input, a custom box, and the label text', () => {
    const { container } = render(<Checkbox label="Show lyrics" defaultChecked />);
    expect(container.querySelector('label.check')?.textContent).toContain('Show lyrics');
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelector('.box')).not.toBeNull();
  });

  test('Field renders error text and hides help', () => {
    const { container } = render(
      <Field label="Email" htmlFor="email" help="Use your work address" error="Invalid email">
        <input id="email" />
      </Field>,
    );
    expect(container.querySelector('.err')?.textContent).toBe('Invalid email');
    expect(container.querySelector('.help')).toBeNull();
  });

  test('Field renders help text when no error', () => {
    const { container } = render(
      <Field label="Email" htmlFor="email" help="Use your work address">
        <input id="email" />
      </Field>,
    );
    expect(container.querySelector('.help')?.textContent).toBe('Use your work address');
    expect(container.querySelector('.err')).toBeNull();
  });

  test('Radio renders a .radio label with a radio input, a custom box, and the label text', () => {
    const { container } = render(<Radio label="Option A" name="opt" value="a" />);
    expect(container.querySelector('label.radio')?.textContent).toContain('Option A');
    expect(container.querySelector('input[type="radio"]')).not.toBeNull();
    expect(container.querySelector('.box')).not.toBeNull();
  });

  test('Switch renders a .switch label with a checkbox input, a track, and the label text', () => {
    const { container } = render(<Switch label="Dark mode" />);
    expect(container.querySelector('label.switch')?.textContent).toContain('Dark mode');
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelector('.track')).not.toBeNull();
  });

  test('Segmented marks the selected option as pressed', () => {
    render(
      <Segmented
        ariaLabel="Format"
        value="cp"
        onValueChange={() => {}}
        options={[
          { label: 'ChordPro', value: 'cp' },
          { label: 'iReal', value: 'ir' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'ChordPro' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'iReal' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('Segmented calls onValueChange with the clicked option value', () => {
    const onValueChange = vi.fn();
    render(
      <Segmented
        ariaLabel="Format"
        value="cp"
        onValueChange={onValueChange}
        options={[
          { label: 'ChordPro', value: 'cp' },
          { label: 'iReal', value: 'ir' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'iReal' }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('ir');
  });
});

describe('package', () => {
  test('exports a semver-shaped version string', () => {
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
