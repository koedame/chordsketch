/** One preview line: the chords on it, plus its lyric text. */
export interface PreviewLine {
  /**
   * The chord symbols in source order (`['C', 'G', 'Am', 'F']`). Empty
   * for a lyric-only line.
   */
  chords: string[];
  /** The lyric text with chords and directives stripped. `''` for a chord-only line. */
  lyric: string;
}

/** Caps for {@link extractPreview}; every one has a thumbnail-sized default. */
export interface PreviewOptions {
  /** Maximum preview lines to return. Default 2; `0` or less returns `[]`. */
  maxLines?: number;
  /** Maximum chord symbols kept per line. Default 6. */
  maxChordsPerLine?: number;
  /**
   * Maximum lyric characters (code points) kept per line. Default 40;
   * `0` or less leaves every lyric empty.
   */
  maxLyricChars?: number;
}

/**
 * Match one inline chord annotation and capture its contents (`[G]` -
 * `G`). Single-line constrained for the same reason as the spans in
 * `extract-lyrics`.
 */
const INLINE_CHORD_SPAN = /\[([^\]\n]*)\]/g;

/** Match a whole directive (`{title: X}`, `{soc}`). */
const DIRECTIVE_SPAN = /\{[^}\n]*\}/g;

/** Collapse any run of intra-line whitespace left behind by span removal. */
const INNER_WHITESPACE = /[^\S\n]+/g;

/** Defaults, sized for a small card thumbnail. */
const DEFAULTS = { maxLines: 2, maxChordsPerLine: 6, maxLyricChars: 40 } as const;

/**
 * Truncate to at most `max` **code points**.
 *
 * `Array.from` rather than `String.prototype.slice`: `slice` counts
 * UTF-16 code units, so cutting mid-astral-character (an emoji, a rare
 * kanji, a musical symbol) leaves a lone surrogate that renders as a
 * replacement glyph. Iterating code points puts every boundary between
 * characters. Combining marks and ZWJ sequences can still split, which
 * degrades to a visibly shorter preview rather than to invalid text.
 *
 * `max <= 0` is handled explicitly and returns `''`: `Array.prototype.slice`
 * treats a negative end as counting from the array's end, so
 * `points.slice(0, max)` for a negative `max` would keep everything but the
 * last `|max|` code points instead of nothing.
 */
function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return '';
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/**
 * Extract the opening chord and lyric lines of ChordPro source - enough
 * to show what a chart looks like without rendering it.
 *
 * Per line: capture each inline chord annotation's contents in order,
 * strip the chords and directives from the text, collapse the leftover
 * whitespace, and trim. A line contributes an entry when it has at least
 * one chord **or** some lyric text; blank lines, directive-only lines and
 * lines that strip to nothing are skipped. Scanning stops as soon as
 * `maxLines` entries are collected, so a long chart costs only its
 * opening lines.
 *
 * Chords come back as a flat per-line list, deliberately **not**
 * positioned over their syllables. Aligning chords to the text is the
 * renderer's job and needs the parsed AST; this samples the opening
 * lines so a caller can show a thumbnail, a search-result snippet, or a
 * terminal preview.
 *
 * Input that is not ChordPro degrades rather than throwing: a lyrics-only
 * body yields lyric-only lines, and an opaque `irealb://` URL yields a
 * single junk-looking line. Gate on {@link detectFormat} instead of
 * relying on that.
 *
 * @param source - the raw ChordPro source
 * @param options - optional caps; see {@link PreviewOptions}
 * @returns up to `maxLines` preview lines in source order; empty when
 *   there is nothing to show
 *
 * @example
 * ```ts
 * extractPreview('{title: X}\n[C]Morning [G]light\n[Am]Evening [F]rain');
 * // [ { chords: ['C', 'G'], lyric: 'Morning light' },
 * //   { chords: ['Am', 'F'], lyric: 'Evening rain' } ]
 *
 * extractPreview('[G] [C] [D]');
 * // [ { chords: ['G', 'C', 'D'], lyric: '' } ]
 * ```
 */
export function extractPreview(source: string, options: PreviewOptions = {}): PreviewLine[] {
  const maxLines = options.maxLines ?? DEFAULTS.maxLines;
  const maxChordsPerLine = options.maxChordsPerLine ?? DEFAULTS.maxChordsPerLine;
  const maxLyricChars = options.maxLyricChars ?? DEFAULTS.maxLyricChars;
  if (maxLines <= 0) return [];

  const lines: PreviewLine[] = [];
  for (const rawLine of source.split('\n')) {
    const chords: string[] = [];
    // `matchAll` starts a fresh iteration per line. `.exec` on a shared
    // global regex would carry `lastIndex` across lines and silently
    // skip matches.
    for (const match of rawLine.matchAll(INLINE_CHORD_SPAN)) {
      // `?? ''` rather than an assertion: group 1 is non-optional, so a
      // match always carries it, but `noUncheckedIndexedAccess` types
      // the access as possibly-undefined and the empty string is the
      // honest fallback - it is what an empty `[]` yields, which the
      // guard below drops.
      const symbol = (match[1] ?? '').trim();
      // Skip `[]` and `[ ]`: an annotation with no symbol is not a chord.
      if (symbol !== '' && chords.length < maxChordsPerLine) chords.push(symbol);
    }
    const lyric = rawLine
      .replace(INLINE_CHORD_SPAN, '')
      .replace(DIRECTIVE_SPAN, '')
      .replace(INNER_WHITESPACE, ' ')
      .trim();
    if (chords.length === 0 && lyric === '') continue;
    lines.push({ chords, lyric: truncateCodePoints(lyric, maxLyricChars) });
    if (lines.length >= maxLines) break;
  }
  return lines;
}
