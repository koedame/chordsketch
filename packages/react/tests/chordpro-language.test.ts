import { StringStream } from '@codemirror/language';
import { describe, expect, test } from 'vitest';

import { chordProLanguage } from '../src/chordpro-language';

/**
 * Drive the {@link chordProLanguage} stream tokenizer over a single line,
 * returning one `{ tag, text }` entry per emitted token. Reaches into the
 * `streamParser` spec (the object passed to `StreamLanguage.define`) so the
 * tokenizer can be exercised without mounting an `EditorView`.
 */
function tokenize(line: string): Array<{ tag: string | null; text: string }> {
  // `streamParser` is the StreamLanguage spec ({ token, startState, … }).
  const parser = (chordProLanguage as unknown as {
    streamParser: {
      startState?: () => unknown;
      token: (stream: StringStream, state: unknown) => string | null;
    };
  }).streamParser;
  const state = parser.startState ? parser.startState() : {};
  const stream = new StringStream(line, 2, 2);
  const out: Array<{ tag: string | null; text: string }> = [];
  // Bound the loop defensively: each token() call must advance the stream.
  while (!stream.eol() && out.length < line.length + 1) {
    const start = stream.pos;
    const tag = parser.token(stream, state);
    if (stream.pos === start) stream.next();
    out.push({ tag, text: line.slice(start, stream.pos) });
  }
  return out;
}

describe('chordProLanguage tokenizer — escaped specials (#2634)', () => {
  test('an escaped `\\[` is not highlighted as a chord', () => {
    const tokens = tokenize('do\\[re[Am]mi');
    // The only `atom` (chord) token must be the real `[Am]`, never the escaped
    // `\[` earlier on the line.
    const chordTokens = tokens.filter((t) => t.tag === 'atom');
    expect(chordTokens).toHaveLength(1);
    expect(chordTokens[0].text).toBe('[Am]');
  });

  test('the escaped bracket characters are consumed as lyric body', () => {
    const tokens = tokenize('a\\[b');
    // No chord token at all; the `\[` is plain lyric (null tag).
    expect(tokens.some((t) => t.tag === 'atom')).toBe(false);
    // The reconstructed text covers the whole line (no characters dropped).
    expect(tokens.map((t) => t.text).join('')).toBe('a\\[b');
  });

  test('an escaped `\\{` does not open a directive', () => {
    const tokens = tokenize('a\\{b');
    // No keyword/punctuation directive tokens — the `\{` is lyric.
    expect(tokens.some((t) => t.tag === 'keyword')).toBe(false);
    expect(tokens.map((t) => t.text).join('')).toBe('a\\{b');
  });

  test('real chords and directives still highlight after the fix', () => {
    const chord = tokenize('[Am]hi').filter((t) => t.tag === 'atom');
    expect(chord.map((t) => t.text)).toEqual(['[Am]']);
    const directive = tokenize('{title: X}').filter((t) => t.tag === 'keyword');
    expect(directive.map((t) => t.text)).toEqual(['title']);
  });

  test('a lone trailing backslash is consumed without error', () => {
    const tokens = tokenize('end\\');
    expect(tokens.map((t) => t.text).join('')).toBe('end\\');
  });
});
