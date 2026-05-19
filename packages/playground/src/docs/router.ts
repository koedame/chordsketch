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

/**
 * True for hashes that name a route change. `#/`, `#/foo`,
 * `#/foo/bar`, and the empty hash are routes. Bare `#anchor` forms
 * are in-page anchors emitted by the Markdown renderer for h2 / h3
 * heading ids and the on-page outline — they MUST NOT unmount the
 * active article, and they MUST NOT advance the router. The browser
 * scrolls natively.
 */
function isRouteHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}

function readSlug(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash;
  // Cold-load with a non-route hash (someone shared an outline-anchor
  // URL): land on the index. The browser separately scrolls to the
  // matching heading id if it exists.
  if (!isRouteHash(hash)) return '';
  return parseHashSlug(hash);
}

/**
 * Subscribe to `hashchange` and return the current slug. Stable
 * across re-renders so the routing layer can treat it as a value,
 * not a side-effect. In-page anchor hashes (e.g. `#some-heading`)
 * are ignored — they fire `hashchange` but do not advance the
 * router, so clicking the outline scrolls without unmounting.
 */
export function useHashSlug(): string {
  const [slug, setSlug] = useState<string>(() => readSlug());
  useEffect(() => {
    const handler = () => {
      if (!isRouteHash(window.location.hash)) return;
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
