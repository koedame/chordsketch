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
 * Default highlight style — pairs the {@link chordProTagTable}
 * captures with the design system's chord-sheet typography
 * (DESIGN.md §3.2). Colours pull through CSS variables defined in
 * `@chordsketch/react/styles.css` (and the workspace `tokens.css`)
 * with inline fallbacks so the editor renders correctly even if
 * the host has not loaded the stylesheet yet.
 */
const designSystemHighlight = HighlightStyle.define([
  // Chord literals (`[G]`, `[Am7]`) — the only crimson surface
  // in the editor, matching the renderer's chord typography.
  {
    tag: chordProTagTable.atom,
    color: 'var(--cs-crimson-500, #BD1642)',
    fontWeight: '700',
    fontFamily:
      '"Roboto", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  },
  // Directive keys (`title`, `key`, `start_of_verse`).
  {
    tag: chordProTagTable.keyword,
    color: 'var(--cs-info-fg, #1F4F8A)',
    fontWeight: '600',
  },
  // Directive values (after the colon).
  {
    tag: chordProTagTable.string,
    color: 'var(--cs-text-strong, #44424A)',
  },
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
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--cs-surface-hover, #F6F4F7)',
    },
    '.cm-cursor': {
      borderLeftWidth: '2px',
      borderLeftColor: 'var(--cs-crimson-500, #BD1642)',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--cs-crimson-100, #FBE1E8) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'var(--cs-crimson-100, #FBE1E8) !important',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'var(--cs-crimson-50, #FDF2F5)',
      outline: '1px solid var(--cs-crimson-300, #EC8AA3)',
    },
    '&.cm-focused': {
      outline: 'none',
      boxShadow: 'inset 0 0 0 1px var(--cs-crimson-500, #BD1642)',
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
      }),
      [],
    );

    const wrapperClass = ['chordsketch-source-editor', className]
      .filter(Boolean)
      .join(' ');

    return <div {...divProps} ref={containerRef} className={wrapperClass} />;
  },
);
