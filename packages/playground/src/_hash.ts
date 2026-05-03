// URL-hash helpers for the playground's input-format toggle (#2366).
//
// Extracted from `main.ts` so unit tests can exercise them without
// triggering the module-load `mountChordSketchUi(...)` side effect
// (which depends on the wasm build artefacts and a real DOM root).
// Symbols are re-exported from `main.ts` so the runtime call sites
// keep their familiar names.

export type InputFormat = 'chordpro' | 'irealb';

export const FORMAT_HASH_KEY = 'format';

/**
 * Parse `#format=chordpro` / `#format=irealb` out of a location
 * hash fragment. Returns `null` for any other shape so the caller
 * falls back to the value-based sniffer. We tolerate both the
 * leading `#` and the bare hash body so the helper composes with
 * `URLSearchParams`-style consumption.
 *
 * Unknown values (e.g. `#format=ireal` typo) emit a `console.warn`
 * so deep-link debugging surfaces the mismatch instead of silently
 * falling back to the default.
 */
export function parseFormatHash(hash: string): InputFormat | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body.length === 0) return null;
  // Only treat the hash as `URLSearchParams`-shaped when it
  // actually looks like one. A bare anchor (`#some-section`) or a
  // structured fragment that happens not to use `=` would otherwise
  // get round-tripped by `URLSearchParams` as `some-section=`,
  // which is a destructive coercion. See `writeFormatHash` for the
  // sister-site rationale.
  if (!looksLikeQueryHash(body)) return null;
  const params = new URLSearchParams(body);
  const value = params.get(FORMAT_HASH_KEY);
  if (value === null) return null;
  if (value === 'chordpro' || value === 'irealb') return value;
  // eslint-disable-next-line no-console
  console.warn(
    `[playground] ignoring unknown #${FORMAT_HASH_KEY}=${value}; expected "chordpro" or "irealb".`,
  );
  return null;
}

/**
 * Persist the active format to `window.location.hash` so a reload
 * lands on the same editor. Uses `history.replaceState` to avoid
 * polluting the back stack with one entry per toggle. Other
 * `key=value`-shaped hash entries are preserved; non-query
 * fragments (e.g. `#some-section`) are NOT silently coerced into
 * a key — see {@link looksLikeQueryHash}. Mirrors the round-trip
 * contract `parseFormatHash` reads with.
 */
export function writeFormatHash(format: InputFormat): void {
  const body = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  let nextBody: string;
  if (body.length === 0 || looksLikeQueryHash(body)) {
    const params = new URLSearchParams(body);
    params.set(FORMAT_HASH_KEY, format);
    nextBody = params.toString();
  } else {
    // Existing fragment is not query-shaped — overwriting it whole
    // is destructive but predictable, and matches the docstring's
    // promise that future deep-link keys live under the query
    // shape. Anything that wants to coexist with a non-query
    // fragment must adopt the query shape itself.
    nextBody = `${FORMAT_HASH_KEY}=${format}`;
  }
  window.history.replaceState(window.history.state, '', `#${nextBody}`);
}

/**
 * Does `body` look like a `key=value(&key=value)*` URL-encoded
 * fragment? Used to decide whether `URLSearchParams` round-tripping
 * is safe — for any other shape the round-trip is destructive
 * (a bare anchor `#mySection` becomes `mySection=` after
 * `URLSearchParams`).
 */
function looksLikeQueryHash(body: string): boolean {
  if (body.length === 0) return true;
  // Each `&`-separated chunk must contain exactly one `=` and a
  // non-empty key. Empty chunks (`a=1&&b=2`) are tolerated by
  // `URLSearchParams` but should disqualify the round-trip here
  // because they are not the canonical shape we want to preserve.
  for (const chunk of body.split('&')) {
    if (chunk.length === 0) return false;
    const eq = chunk.indexOf('=');
    if (eq <= 0) return false;
  }
  return true;
}
