/**
 * Tiny ChordPro language module for CodeMirror 6 — exported for
 * users who want to assemble their own `EditorView` against the
 * same syntax highlighting tokens the components in this package
 * use. {@link SourceEditor} consumes this internally; standalone
 * use is a deliberate opt-in for hosts with custom keymaps,
 * autocomplete, or linting.
 *
 * Tokenisation is regex-based via `@codemirror/language`'s
 * `StreamLanguage`. Five capture classes:
 *
 * - `comment` — line starting with `#`
 * - `keyword` — directive name (`title`, `start_of_verse`, …)
 * - `string` — directive value (between `:` and the closing `}`)
 * - `atom` — chord literal (`[Am7]`, `[D/F#]`)
 * - `punctuation` — bracket / brace / colon
 *
 * The desktop app's tree-sitter-backed editor at
 * `apps/desktop/src/codemirror-editor.ts` is the higher-fidelity
 * alternative and the source of truth for `tree-sitter-chordpro`
 * usage. This module is the lighter option for environments
 * (browser playground, embedded React hosts) that cannot afford
 * the ~1 MB tree-sitter-runtime bundle. The output approximates
 * the grammar — it is sufficient for highlighting but is not a
 * full parser.
 */
import { StreamLanguage, type StringStream } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Internal tokeniser state for {@link chordProLanguage}. */
interface ChordProState {
  /**
   * Phase inside a directive. `null` means we are not inside a
   * `{` … `}` block; `'key'` covers the directive name; `'value'`
   * covers everything after the colon.
   */
  inDirective: 'key' | 'value' | null;
}

/**
 * CodeMirror `StreamLanguage` for ChordPro. Pair with
 * {@link chordProTagTable} when you build your own
 * `HighlightStyle`.
 */
export const chordProLanguage = StreamLanguage.define<ChordProState>({
  name: 'chordpro',
  startState: () => ({ inDirective: null }),
  token(stream: StringStream, state: ChordProState): string | null {
    if (stream.sol() && stream.match(/#.*/)) return 'comment';

    if (stream.match('{')) {
      state.inDirective = 'key';
      return 'punctuation';
    }
    if (state.inDirective !== null) {
      if (stream.eat('}')) {
        state.inDirective = null;
        return 'punctuation';
      }
      if (state.inDirective === 'key') {
        if (stream.match(/[A-Za-z_][A-Za-z0-9_]*/)) {
          state.inDirective = stream.peek() === ':' ? 'value' : null;
          return 'keyword';
        }
        // Unexpected character inside a directive — treat as a
        // string and keep going so the user can still type a
        // partial directive without the whole line going red.
        if (stream.next() != null) return 'string';
      } else {
        if (stream.eat(':')) return 'punctuation';
        if (stream.skipTo('}')) return 'string';
        // No closing brace on this line; consume the rest so the
        // unbalanced directive does not bleed into the next line.
        stream.skipToEnd();
        return 'string';
      }
    }

    if (stream.eat('[')) {
      // Chord literal — `[Am7]`, `[D/F#]`, `[N.C.]`. Tolerate
      // anything up to the closing bracket so transposition
      // markers like `[*]` still highlight cleanly.
      stream.skipTo(']');
      stream.eat(']');
      return 'atom';
    }

    // Plain lyric runs — consume up to the next chord / directive
    // / line end and emit `null` so the default body style applies.
    stream.eatWhile((ch: string) => ch !== '[' && ch !== '{');
    if (stream.current().length > 0) return null;
    stream.next();
    return null;
  },
  tokenTable: {
    comment: t.comment,
    keyword: t.keyword,
    string: t.string,
    atom: t.atom,
    punctuation: t.punctuation,
  },
});

/**
 * Mapping from the {@link chordProLanguage} capture names to
 * `@lezer/highlight` `Tag`s. Use this to build a
 * `HighlightStyle.define([...])` aligned with the language's
 * emitted tokens.
 */
export const chordProTagTable = {
  comment: t.comment,
  keyword: t.keyword,
  string: t.string,
  atom: t.atom,
  punctuation: t.punctuation,
} as const;
