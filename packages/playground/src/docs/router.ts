// Hash-based router for the docs SPA. Single-page; no external
// router dependency. Resolves the hash to one of the slugs declared
// in `pages.ts`, falls back to the empty (index) slug on any
// unknown hash.

import { useEffect, useState } from 'react';

/**
 * Parse a `window.location.hash` value into a slug. Tolerates
 * `#`, `#/`, `#/index`, `#foo`, `#/foo`, `#/foo/`, and
 * `#/foo?query`. Returned slug is the lookup key into
 * `DOC_GROUPS`. Exported so unit tests can lock the tolerance
 * clauses without going through React rendering.
 */
export function parseHashSlug(hash: string): string {
  if (hash === '' || hash === '#' || hash === '#/' || hash === '#/index') {
    return '';
  }
  const trimmed = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  const queryStart = trimmed.indexOf('?');
  return queryStart === -1 ? trimmed : trimmed.slice(0, queryStart);
}

function readSlug(): string {
  if (typeof window === 'undefined') return '';
  return parseHashSlug(window.location.hash);
}

/**
 * Subscribe to `hashchange` and return the current slug. Stable
 * across re-renders so the routing layer can treat it as a value,
 * not a side-effect.
 */
export function useHashSlug(): string {
  const [slug, setSlug] = useState<string>(() => readSlug());
  useEffect(() => {
    const handler = () => {
      setSlug(readSlug());
    };
    window.addEventListener('hashchange', handler);
    return () => {
      window.removeEventListener('hashchange', handler);
    };
  }, []);
  return slug;
}

/**
 * Build the in-page `href` for a given slug. Hash routing keeps the
 * docs entry point stable at `/chordsketch/docs/`; the slug always
 * lives in the hash.
 */
export function hrefForSlug(slug: string): string {
  if (slug === '') return '#/';
  return `#/${slug}`;
}
