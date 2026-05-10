import type { HTMLAttributes } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
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

import { chordProLanguage, chordProTagTable } from './chordpro-language';

/** Imperative handle exposed via `ref` from {@link SourceEditor}. */
export interface SourceEditorHandle {
  /** Move keyboard focus into the editor. */
  focus(): void;
  /** Read the current document contents. */
  getValue(): string;
  /**
   * Replace the document. Bypasses the `onChange` listener so
   * programmatic loads (file open, undo from a parent state) do
   * not echo back as user edits — matches the contract React
   * controlled inputs hold for `value`.
   */
  setValue(value: string): void;
  /**
   * Insert `text` at the current selection (or caret position).
   * Replaces any non-empty selection. Unlike `setValue`, this
   * call DOES fire the `onChange` handler — it is a user-edit
   * shortcut, not a programmatic load. Returns focus to the
   * editor so the caret lands inside the inserted text and the
   * user can keep typing.
   *
   * If `selectInside` is `true`, the inserted text is left
   * selected after insertion, which lets the caller chain a
   * follow-up replacement (e.g. paste a placeholder, then let
   * the user overwrite it).
   */
  insertAtCursor(text: string, selectInside?: boolean): void;
}

/** Props accepted by {@link SourceEditor}. */
export interface SourceEditorProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /**
   * Controlled value. When set, the component synchronises the
   * editor doc against `value` on every render so the parent owns
   * the source of truth. Pair with `onChange` to capture edits.
   */
  value?: string;
  /**
   * Initial value for uncontrolled usage. Ignored when `value` is
   * supplied. Defaults to the empty string.
   */
  defaultValue?: string;
  /**
   * Fires synchronously on every user-initiated change. Programmatic
   * `setValue` calls (and the `value` prop synchronisation path) do
   * NOT fire this handler.
   */
  onChange?: (value: string) => void;
  /** Placeholder rendered while the editor is empty. */
  placeholder?: string;
  /**
   * Disable the line-number gutter. Defaults to enabled — the
   * playground and most editor UIs benefit from line numbers, but
   * embedded preview-only contexts can suppress them.
   */
  noLineNumbers?: boolean;
  /**
   * Disable line wrapping. Defaults to enabled — wrapping keeps
   * long lyric lines visible in narrow panes without forcing a
   * horizontal scroll.
   */
  noLineWrapping?: boolean;
}

/**
 * Default highlight style — mirrors the `.tok-*` rules in the
 * design-system reference (`design-system/ui_kits/web/editor.html`):
 *
 *   `.tok-chord     { color: var(--crimson-500); font-weight: 600; }`
 *   `.tok-directive { color: var(--text-secondary); }`
 *   `.tok-bracket   { color: var(--text-tertiary); }`
 *   `.tok-comment   { color: var(--text-tertiary); font-style: italic; }`
 *
 * The chord glyph in the source editor stays in the editor's
 * monospace stack — the Roboto / 700 / 16 px treatment from
 * DESIGN.md §3.2 applies to the rendered chord-sheet output, not
 * to the source pane. Directive values (the text after `:`) are
 * intentionally unstyled here so they inherit `--cs-text-primary`,
 * matching the plain "Country Roads" / "John Denver" copy in the
 * editor.html reference. Colours pull through CSS variables
 * defined in `@chordsketch/react/styles.css` (and the workspace
 * `design-system/tokens.css`) with inline fallbacks so the editor renders
 * correctly even if the host has not loaded the stylesheet yet.
 *
 * `tok-key` (special-cased value of the `{key: …}` directive) and
 * `tok-section` (section markers rendered outside `{…}` braces)
 * from the reference are not yet wired in here; the underlying
 * `StreamLanguage` does not differentiate those captures and
 * adding them is grammar work — see the docstring in
 * `chordpro-language.ts`.
 */
const designSystemHighlight = HighlightStyle.define([
  // Chord literals (`[G]`, `[Am7]`).
  {
    tag: chordProTagTable.atom,
    color: 'var(--cs-crimson-500, #BD1642)',
    fontWeight: '600',
  },
  // Directive names (`title`, `key`, `start_of_verse`).
  {
    tag: chordProTagTable.keyword,
    color: 'var(--cs-text-secondary, #67646D)',
  },
  // Directive values (text after the colon). Intentionally
  // unstyled — the reference treats values as plain copy.
  // Curly / square brackets and the directive colon.
  {
    tag: chordProTagTable.punctuation,
    color: 'var(--cs-text-tertiary, #8A8790)',
  },
  // ChordPro line comments (`# verse 1 …`).
  {
    tag: chordProTagTable.comment,
    color: 'var(--cs-text-tertiary, #8A8790)',
    fontStyle: 'italic',
  },
]);

/**
 * Theme — pulls from the same CSS variables exposed in
 * `@chordsketch/react/styles.css` so the editor sits inside the
 * design system rather than fighting CodeMirror's defaults. Every
 * variable carries an inline fallback so the editor renders
 * correctly even if the host has not loaded the stylesheet yet.
 */
const designSystemTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '0.875rem',
      backgroundColor: 'var(--cs-surface, #FFFFFF)',
      color: 'var(--cs-text-primary, #0A0A0B)',
    },
    '.cm-scroller': {
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: '1.857',
    },
    '.cm-content': {
      caretColor: 'var(--cs-crimson-500, #BD1642)',
      padding: '1.5rem 0',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--cs-surface, #FFFFFF)',
      borderRight: '1px solid var(--cs-border, #E8E6EA)',
      color: 'var(--cs-text-tertiary, #8A8790)',
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 0.75rem 0 1rem',
      fontSize: '0.8125rem',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--cs-surface-hover, #F6F4F7)',
      color: 'var(--cs-text-secondary, #67646D)',
      fontWeight: '600',
    },
    '.cm-activeLine': {
      // CodeMirror paints `.cm-selectionLayer` at z-index `-2`
      // — below `.cm-content` and therefore below any opaque
      // line background. A solid `--cs-surface-hover` here
      // would hide the selection wash on the caret line. Use a
      // 4 % ink overlay instead so the active line still reads
      // as a slight tint and the selection (`#F4B5C5`) shows
      // through clearly via alpha compositing.
      backgroundColor: 'rgba(10, 10, 11, 0.04)',
    },
    '.cm-cursor': {
      borderLeftWidth: '2px',
      borderLeftColor: 'var(--cs-crimson-500, #BD1642)',
    },
    // Selection background: a solid mid-tone pink chosen so it
    // is unambiguously distinct from BOTH the plain `--cs-surface`
    // (#FFFFFF) and the `--cs-surface-hover` (#F6F4F7) active-line
    // wash. The earlier attempts at this rule cycled through
    // `--cs-crimson-100` (#FBE1E8 — too close to the active-line
    // tint) and a `mix-blend-mode: multiply` overlay (works in
    // theory; flaky in practice across browser stacking
    // contexts), both of which left selections invisible on the
    // caret line. The literal hex sits between `--cs-crimson-100`
    // and `--cs-crimson-300` (#EC8AA3) — the design system does
    // not ship a `--crimson-200` step, and adding one is out of
    // scope here, so the colour is inlined with a comment
    // tagging the intended token gap. If `--crimson-200` ever
    // lands, swap to `var(--cs-crimson-200, #F4B5C5)`.
    '.cm-selectionBackground, ::selection': {
      backgroundColor: '#F4B5C5 !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: '#F4B5C5 !important',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'var(--cs-crimson-50, #FDF2F5)',
      outline: '1px solid var(--cs-crimson-300, #EC8AA3)',
    },
    '&.cm-focused': {
      // No focus outline / inset border. The CodeMirror caret
      // (`--cs-crimson-500`, drawn 2 px wide via the `.cm-cursor`
      // rule above) and the selection background already make
      // the active state legible without a frame around the
      // whole pane. Suppress CodeMirror's default `outline:
      // 1px dotted` so the editor sits flush inside its host
      // pane.
      outline: 'none',
    },
  },
  { dark: false },
);

/**
 * CodeMirror 6 ChordPro source editor. Provides line numbers,
 * regex-based syntax highlighting (chords / directives / comments),
 * bracket matching, history (`Ctrl/Cmd-Z` / `-Y`), search
 * (`Ctrl/Cmd-F`), and indent-with-tab. Theme + highlight pull
 * through CSS variables prefixed `--cs-*` so the editor styles
 * react to the host stylesheet without recompiling.
 *
 * Controlled and uncontrolled modes mirror the existing
 * `<ChordEditor>` (textarea) component. The two are intentionally
 * separate: the textarea is dependency-free, the CodeMirror
 * variant adds ~150 KB of editor runtime in exchange for
 * highlighting and rich keymaps. Pick whichever fits the host's
 * bundle budget.
 *
 * ```tsx
 * <SourceEditor
 *   value={source}
 *   onChange={setSource}
 *   placeholder="Paste your ChordPro here…"
 * />
 * ```
 */
export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  function SourceEditor(
    {
      value,
      defaultValue = '',
      onChange,
      placeholder,
      noLineNumbers,
      noLineWrapping,
      className,
      ...divProps
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const programmaticLoadRef = useRef(false);

    // Keep the handler stable across renders so the update
    // listener does not need to be re-registered on every parent
    // re-render.
    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    // Mount the EditorView once; tear it down on unmount. Subsequent
    // prop changes flow through the synchronisation effect below.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const updateListener = EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        if (programmaticLoadRef.current) return;
        const next = update.state.doc.toString();
        onChangeRef.current?.(next);
      });

      const extensions = [
        ...(noLineNumbers ? [] : [lineNumbers(), highlightActiveLineGutter()]),
        highlightActiveLine(),
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
        ...(noLineWrapping ? [] : [EditorView.lineWrapping]),
        ...(placeholder ? [placeholderExtension(placeholder)] : []),
        updateListener,
      ];

      const state = EditorState.create({
        doc: value ?? defaultValue,
        extensions,
      });
      const view = new EditorView({ state, parent: container });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // We intentionally only mount once. `value` updates flow
      // through the sync effect below; option-prop changes
      // (`noLineNumbers`, `noLineWrapping`, `placeholder`) require
      // a remount which the user can force via React's `key` prop.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Controlled-mode value synchronisation. Runs whenever the
    // parent passes a new `value`; skips when the editor's current
    // doc already matches to avoid clobbering the user's caret
    // position on a no-op render.
    useEffect(() => {
      if (value === undefined) return;
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      programmaticLoadRef.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
        });
      } finally {
        programmaticLoadRef.current = false;
      }
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          viewRef.current?.focus();
        },
        getValue() {
          return viewRef.current?.state.doc.toString() ?? '';
        },
        setValue(next: string) {
          const view = viewRef.current;
          if (!view) return;
          programmaticLoadRef.current = true;
          try {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: next },
            });
          } finally {
            programmaticLoadRef.current = false;
          }
        },
        insertAtCursor(text: string, selectInside = false) {
          const view = viewRef.current;
          if (!view) return;
          // `replaceSelection` collapses every selection range to
          // an inserted run; if the user has nothing selected the
          // current caret position is treated as a zero-length
          // range, so the same call works for "insert at caret"
          // and "replace selected" without a branch. Intentionally
          // does NOT flip `programmaticLoadRef` — this is a user
          // edit and should fire `onChange`.
          const { from } = view.state.selection.main;
          view.dispatch(view.state.replaceSelection(text));
          if (selectInside) {
            // Re-select the inserted text so a follow-up keystroke
            // overwrites the placeholder cleanly.
            view.dispatch({
              selection: { anchor: from, head: from + text.length },
            });
          }
          view.focus();
        },
      }),
      [],
    );

    const wrapperClass = ['chordsketch-source-editor', className]
      .filter(Boolean)
      .join(' ');

    return <div {...divProps} ref={containerRef} className={wrapperClass} />;
  },
);
