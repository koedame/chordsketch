// Hash-router parsing rules for the docs SPA.
//
// `parseHashSlug` is invoked on cold load + every `hashchange`, so
// the tolerance clauses are the difference between a deep link
// landing on the right page and silently dropping to the index.

import { describe, expect, it } from 'vitest';

import { hrefForSlug, parseHashSlug } from '../src/docs/router';

describe('parseHashSlug', () => {
  it('returns the empty slug for empty / index-like hashes', () => {
    for (const hash of ['', '#', '#/', '#/index']) {
      expect(parseHashSlug(hash)).toBe('');
    }
  });

  it('tolerates both `#foo` and `#/foo` forms', () => {
    expect(parseHashSlug('#foo')).toBe('foo');
    expect(parseHashSlug('#/foo')).toBe('foo');
  });

  it('strips a trailing slash', () => {
    expect(parseHashSlug('#/foo/')).toBe('foo');
    expect(parseHashSlug('#foo/')).toBe('foo');
  });

  it('strips trailing query strings', () => {
    expect(parseHashSlug('#/foo?utm=referrer')).toBe('foo');
    expect(parseHashSlug('#foo?bar')).toBe('foo');
  });

  it('returns nested slugs intact', () => {
    expect(parseHashSlug('#/reference/chord-sheet')).toBe('reference/chord-sheet');
  });
});

describe('hrefForSlug', () => {
  it('returns the canonical index href for the empty slug', () => {
    expect(hrefForSlug('')).toBe('#/');
  });

  it('prefixes a single slash for non-empty slugs', () => {
    expect(hrefForSlug('embed-react')).toBe('#/embed-react');
    expect(hrefForSlug('reference/chord-sheet')).toBe('#/reference/chord-sheet');
  });
});
