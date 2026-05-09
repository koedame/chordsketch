/**
 * CodeMirror 6 editor adapter for the playground's ChordPro
 * surface. Uses `StreamLanguage` (regex-based tokenisation) rather
 * than `tree-sitter-chordpro` so the playground stays light — the
 * desktop app's tree-sitter backed editor lives at
 * `apps/desktop/src/codemirror-editor.ts` and is the source of
 * truth for richer editing. The playground's job is to demo the
 * parser / renderer, so an approximate-but-correct highlighter is
 * sufficient and keeps the deployed bundle small.
 *
 * Colours come from the design system tokens defined in
 * `tokens.css` (DESIGN.md §3.2): chord = `--crimson-500` Roboto 700;
 * directive key = `--info-fg`; comment / bracket punctuation =
 * `--text-tertiary` italic. Fallback values mirror the inline
 * `:root` block in `@chordsketch/ui-web/style.css` so this file
 * works even if the host stylesheet has not loaded yet.
 *
 * Implements the {@link EditorAdapter} contract from
 * `@chordsketch/ui-web` so the host can swap it in via
 * `MountOptions.createEditor`. The factory mirrors
 * `defaultTextareaEditor`'s shape: takes `EditorFactoryOptions`,
 * returns an adapter with `element` / `getValue` / `setValue` /
 * `onChange` / `focus` / `destroy`.
 */
import type {
  EditorAdapter,
  EditorFactory,
  EditorFactoryOptions,
} from '@chordsketch/ui-web';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  syntaxHighlighting,
  type StringStream,
} from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

interface ChordProState {
  // Tokeniser is mostly stateless; we only carry whether the
  // previous token was the directive key so the value half can be
  // styled distinctly. `null` means "not currently inside a
  // directive" or "we have already emitted the value half."
  inDirective: 'key' | 'value' | null;
}

const chordProLanguage = StreamLanguage.define<ChordProState>({
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
        // Unexpected character inside a directive — treat as
        // string and keep going so the user can still type a
        // partial directive without the whole line going red.
        if (stream.next() != null) return 'string';
      } else {
        if (stream.eat(':')) return 'punctuation';
        if (stream.skipTo('}')) return 'string';
        // No closing brace on this line; consume the rest so the
        // `start_of_chorus` ↔ `end_of_chorus` block doesn't bleed.
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

    // Section markers (`{start_of_verse}` / `{end_of_chorus}`) are
    // already handled above as directives. Plain lyric runs go
    // through here — consume up to the next chord / directive /
    // line end and emit `null` so the default body style applies.
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

const designSystemHighlight = HighlightStyle.define([
  // Chord glyphs (`[G]`, `[Am7]`) — the only crimson surface in the
  // editor, matching the renderer's chord typography.
  {
    tag: t.atom,
    color: 'var(--crimson-500, #BD1642)',
    fontWeight: '700',
    fontFamily:
      '"Roboto", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  },
  // Directive keys (`title`, `key`, `start_of_verse`).
  {
    tag: t.keyword,
    color: 'var(--info-fg, #1F4F8A)',
    fontWeight: '600',
  },
  // Directive values (after the colon).
  {
    tag: t.string,
    color: 'var(--text-strong, #44424A)',
  },
  // Curly / square brackets and the directive colon.
  {
    tag: t.punctuation,
    color: 'var(--text-tertiary, #8A8790)',
  },
  // ChordPro line comments (`# verse 1 ...`).
  {
    tag: t.comment,
    color: 'var(--text-tertiary, #8A8790)',
    fontStyle: 'italic',
  },
]);

// Theme — pulls from the same tokens the rest of ui-web uses so
// the editor sits inside the design system rather than fighting
// CodeMirror's defaults. CSS-variable fallbacks mirror the inline
// `:root` block in `@chordsketch/ui-web/style.css` so the editor
// renders correctly even if a host loads this module before
// ui-web's stylesheet.
const designSystemTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '0.875rem',
      backgroundColor: 'var(--surface, #FFFFFF)',
      color: 'var(--text-primary, #0A0A0B)',
    },
    '.cm-scroller': {
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: '1.857',
    },
    '.cm-content': {
      caretColor: 'var(--crimson-500, #BD1642)',
      padding: '1.5rem 0',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface, #FFFFFF)',
      borderRight: '1px solid var(--border, #E8E6EA)',
      color: 'var(--text-tertiary, #8A8790)',
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--sp-3, 0.75rem) 0 var(--sp-4, 1rem)',
      fontSize: '0.8125rem',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--surface-hover, #F6F4F7)',
      color: 'var(--text-secondary, #67646D)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--surface-hover, #F6F4F7)',
    },
    '.cm-cursor': {
      borderLeftWidth: '2px',
      borderLeftColor: 'var(--crimson-500, #BD1642)',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--crimson-100, #FBE1E8) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'var(--crimson-100, #FBE1E8) !important',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'var(--crimson-50, #FDF2F5)',
      outline: '1px solid var(--crimson-300, #EC8AA3)',
    },
    '&.cm-focused': {
      outline: 'none',
      boxShadow: 'inset 0 0 0 1px var(--crimson-500, #BD1642)',
    },
  },
  { dark: false },
);

/**
 * Build the {@link EditorAdapter} backed by CodeMirror 6. The
 * `element` is the `EditorView`'s `dom` so ui-web's `flex: 1`
 * editor pane fills correctly. `setValue` uses a transaction with
 * a sentinel annotation so the caller's load is not echoed back
 * to the change handler — matches the contract in the
 * `EditorAdapter` doc comment.
 */
export const createCodeMirrorChordProEditor: EditorFactory = (
  options: EditorFactoryOptions,
): EditorAdapter => {
  let changeHandlers: Array<(value: string) => void> = [];
  // `programmaticLoad` flips for the duration of a `setValue`
  // transaction so the update listener can skip notifying
  // subscribers. ui-web's `setValue` contract says programmatic
  // loads MUST NOT fire `onChange` — this is the single place
  // we enforce that.
  let programmaticLoad = false;

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (programmaticLoad) return;
    const value = update.state.doc.toString();
    for (const handler of changeHandlers) handler(value);
  });

  const state = EditorState.create({
    doc: options.initialValue,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      bracketMatching(),
      history(),
      chordProLanguage,
      syntaxHighlighting(designSystemHighlight),
      designSystemTheme,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.lineWrapping,
      ...(options.placeholder ? [placeholderExtension(options.placeholder)] : []),
      updateListener,
    ],
  });

  const view = new EditorView({ state });

  return {
    element: view.dom,
    getValue() {
      return view.state.doc.toString();
    },
    setValue(value: string) {
      programmaticLoad = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
        });
      } finally {
        programmaticLoad = false;
      }
    },
    onChange(handler) {
      changeHandlers.push(handler);
      return () => {
        changeHandlers = changeHandlers.filter((h) => h !== handler);
      };
    },
    focus() {
      view.focus();
    },
    destroy() {
      changeHandlers = [];
      view.destroy();
    },
  };
};
