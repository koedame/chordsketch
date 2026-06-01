import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Button } from '../src/button';
import { Badge, Pill } from '../src/badge';
import { Card } from '../src/card';
import { Checkbox, Field, Input, Radio, Segmented, Switch } from '../src/form';

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
});

describe('Form', () => {
  test('Input applies the error class', () => {
    render(<Input error aria-label="Email" />);
    expect(screen.getByLabelText('Email').className).toContain('error');
  });

  test('Checkbox renders a checkbox input and a custom box', () => {
    const { container } = render(<Checkbox label="Show lyrics" defaultChecked />);
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

  test('Radio renders a radio input and a custom box', () => {
    const { container } = render(<Radio label="Option A" name="opt" value="a" />);
    expect(container.querySelector('input[type="radio"]')).not.toBeNull();
    expect(container.querySelector('.box')).not.toBeNull();
  });

  test('Switch renders a checkbox input and a track', () => {
    const { container } = render(<Switch label="Dark mode" />);
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
});
