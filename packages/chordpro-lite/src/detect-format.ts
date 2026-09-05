import { BARE_DIRECTIVES } from './bare-directives';

/**
 * The chart formats this package can recognise.
 *
 * `'chordpro'` is the ChordPro text format; `'irealb'` is an iReal Pro
 * export URL (`irealb://` or `irealbook://`).
 */
export type ChartFormat = 'chordpro' | 'irealb';

/**
 * An iReal Pro export URL at the start of the input, after optional
 * leading whitespace. Matching a prefix rather than searching is
 * deliberate: an `irealb://` link quoted inside lyrics is not a chart.
 *
 * Both URL shapes the iReal Pro parser accepts are covered — the
 * canonical obfuscated `irealb://` and the six-field `irealbook://`.
 */
const IREAL_URL_PATTERN = /^\s*irealb(?:ook)?:\/\//;

/**
 * A ChordPro directive: either a known value-less directive (`{soc}`)
 * or any directive name followed by a colon (`{title: ...}`).
 *
 * Requiring one of those two shapes is what keeps arbitrary braced text
 * out. A template placeholder (`{username}`) and a JSON fragment
 * (`{"key": "value"}`) are both `{...}` but neither is a directive, and
 * treating them as one would misfile plain lyrics as ChordPro.
 *
 * The value-less names come from the Rust directive catalog via
 * `./bare-directives`; they are lowercase words, so they need no regular
 * expression escaping (the generator enforces that shape).
 */
const DIRECTIVE_PATTERN = new RegExp(
  `\\{(?:(?:${BARE_DIRECTIVES.join('|')})\\}|[a-z_]+\\s*:)`,
  'i',
);

/**
 * An inline chord annotation (`[G]`, `[Cmaj7/E]`).
 *
 * The chord must start with `A`-`G`, which rejects a markdown-style
 * `[invalid]` and a plain-text section label such as `[Verse]`. The
 * character class excludes newlines so an unbalanced `]` several lines
 * later cannot make one match swallow the lines in between.
 */
const INLINE_CHORD_PATTERN = /\[[A-G][^\]\n]*\]/;

/**
 * Identify which format `input` is written in, without loading a parser.
 *
 * Heuristics, in order:
 *
 * 1. an iReal Pro URL prefix (`irealb://`, `irealbook://`) - `'irealb'`
 * 2. a ChordPro directive (`{title: ...}`, `{soc}`) - `'chordpro'`
 * 3. an inline ChordPro chord (`[G]`, `[Cmaj7/E]`) - `'chordpro'`
 * 4. none of the above - `null`
 *
 * The iReal Pro check runs first, so a chart whose payload happens to
 * contain bracketed text is still classified by its URL.
 *
 * This is a pre-flight sniff, not a parse: it answers "which pipeline
 * should read this?" for a caller that has not loaded one yet. Once the
 * engine is available, `chordsketch_chordpro::heuristic::detect_format`
 * (also reachable through the CLI's `--input-format auto`) is the richer
 * classifier - it additionally recognises plain chord-over-lyric sheets,
 * which this function reports as `null`.
 *
 * @param input - the text to classify
 * @returns the detected format, or `null` when the input matches none of
 *   the heuristics (plain lyrics, an empty string, unrelated text)
 *
 * @example
 * ```ts
 * detectFormat('[G]Hello [Am]world');    // 'chordpro'
 * detectFormat('irealb://Song=Foo=...'); // 'irealb'
 * detectFormat('Just lyrics, no chords') // null
 * detectFormat('{"name":"x"}');          // null - not a directive
 * ```
 */
export function detectFormat(input: string): ChartFormat | null {
  if (IREAL_URL_PATTERN.test(input)) {
    return 'irealb';
  }
  if (DIRECTIVE_PATTERN.test(input) || INLINE_CHORD_PATTERN.test(input)) {
    return 'chordpro';
  }
  return null;
}
