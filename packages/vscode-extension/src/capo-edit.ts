/**
 * Local copy of the `readCapo` / `setCapoInSource` helpers that
 * `@chordsketch/react` exports from `chord-source-edit.ts`.
 *
 * The WebView preview uses `<ChordProPreview toolbar="performance">`,
 * whose `<Capo>` group writes back through `onSourceChange` after
 * recomputing the source via `setCapoInSource`. The WebView posts a
 * `{ type: 'edit-capo', capo: N }` message to the extension host
 * (see `WebviewToExt` in `preview.ts`); the host then applies a
 * `WorkspaceEdit` against the live `TextDocument` so the persisted
 * `.chordpro` file gets the `{capo: N}` directive update too.
 *
 * Why a local copy instead of `import { setCapoInSource } from
 * '@chordsketch/react'`? The React package ships as one bundled
 * `dist/index.js` containing every component + CodeMirror dep —
 * tree-shaking a pre-bundled file from a Node host pulls hundreds
 * of KB of dead JSX into the extension. The helpers themselves are
 * ~30 lines of pure string manipulation, so duplicating them is
 * cheaper than re-architecting the React package's exports.
 *
 * Fix-propagation contract: every behavioural change to
 * `setCapoInSource` / `readCapo` in
 * `packages/react/src/chord-source-edit.ts` MUST land in this file
 * in the same PR. The sister-site test at `capo-edit.test.ts`
 * exists to catch drift if the duplication ever falls out of sync.
 */

/** Minimum capo fret position. Mirrors `CAPO_MIN` in `@chordsketch/react`. */
export const CAPO_MIN = 0;
/** Maximum capo fret position. Mirrors `CAPO_MAX` in `@chordsketch/react`. */
export const CAPO_MAX = 12;

const CAPO_DIRECTIVE_RE = /\{capo:\s*(-?\d+)\s*\}\s*\n?/;
const CAPO_ANCHOR_RE = /^(\{(?:title|subtitle|artist|key|tempo|time)[^}]*\}\s*\n)+/;

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function readCapo(source: string): number {
  const match = source.match(CAPO_DIRECTIVE_RE);
  if (!match) return CAPO_MIN;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n < 0) return CAPO_MIN;
  return clampInt(n, CAPO_MIN, CAPO_MAX);
}

export function setCapoInSource(source: string, capo: number): string {
  const clamped = clampInt(Math.trunc(capo), CAPO_MIN, CAPO_MAX);
  const directive = clamped === CAPO_MIN ? '' : `{capo: ${clamped}}\n`;
  if (CAPO_DIRECTIVE_RE.test(source)) {
    return source.replace(CAPO_DIRECTIVE_RE, directive);
  }
  if (clamped === CAPO_MIN) return source;
  const anchor = source.match(CAPO_ANCHOR_RE);
  if (anchor) {
    const idx = (anchor.index ?? 0) + anchor[0].length;
    return `${source.slice(0, idx)}${directive}${source.slice(idx)}`;
  }
  return `${directive}${source}`;
}
