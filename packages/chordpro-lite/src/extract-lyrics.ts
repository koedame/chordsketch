import { removeSpans } from './spans';

/** Collapse any run of intra-line whitespace left behind by span removal. */
const INNER_WHITESPACE = /[^\S\n]+/g;

/**
 * Extract the plain lyric text from ChordPro source.
 *
 * Per line: remove every inline chord annotation and directive, collapse
 * the whitespace their removal leaves behind, and trim. Lines that are
 * empty afterwards - blank lines, chord-only lines, directive-only lines
 * - are dropped, and the surviving lyric lines are rejoined with `\n`.
 *
 * The result is deliberately **not** a rendering: directives are not
 * interpreted, chords are not transposed, and the chord-over-syllable
 * layout is not preserved. It is the sung words and nothing else, which
 * is what a full-text index, a word count, or a plain-text export wants.
 * For a faithful rendering use the engine's renderers
 * (`@chordsketch/wasm`, `@chordsketch/node`, or the CLI).
 *
 * @param source - the raw ChordPro source
 * @returns the lyric text, or `''` when the chart carries no lyric words
 *   (an instrumental, or empty input)
 *
 * @example
 * ```ts
 * extractLyrics('{title: X}\n[G]Hello [Am]world'); // 'Hello world'
 * extractLyrics('{soc}\n[G] [C] [D]\n{eoc}');      // '' - instrumental
 * ```
 */
export function extractLyrics(source: string): string {
  const lines: string[] = [];
  for (const rawLine of source.split('\n')) {
    // Inline chord annotations (`[G]`, `[Cmaj7/E]`) and directives
    // (`{title: X}`, `{soc}`) are matched within one line, so an
    // unbalanced closer further down the chart cannot make one span
    // swallow the lines in between.
    const stripped = removeSpans(removeSpans(rawLine, '[', ']'), '{', '}')
      .replace(INNER_WHITESPACE, ' ')
      .trim();
    if (stripped !== '') {
      lines.push(stripped);
    }
  }
  return lines.join('\n');
}
