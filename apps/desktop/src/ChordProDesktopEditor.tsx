/**
 * Desktop-specific CodeMirror 6 + `tree-sitter-chordpro` ChordPro
 * editor, wrapped as a controlled-mode React component composed
 * inside `<App />`. Combines grammar load, a ViewPlugin for
 * incremental reparse + decorations, and a diagnostics walker.
 *
 * Why this lives in `apps/desktop/` instead of `@chordsketch/react`:
 * `@chordsketch/react`'s built-in `<ChordSourceArea>` uses a
 * lightweight regex `StreamLanguage` for highlighting and does not
 * (yet) expose a way to inject custom CodeMirror extensions. The
 * desktop app's tree-sitter-backed highlighting + diagnostics is
 * higher fidelity and is its sole consumer in this repo; teaching
 * `<ChordSourceArea>` to accept an extensions prop would let this
 * editor move into the shared package later.
 *
 * The grammar + runtime wasm binaries are copied into
 * `apps/desktop/public/` by `scripts/build-grammar-wasm.mjs` at
 * `prebuild` / `predev` time; Vite serves them at
 * `/tree-sitter-chordpro.wasm` and `/web-tree-sitter.wasm`.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  forEachDiagnostic,
  setDiagnostics,
  type Diagnostic,
} from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { Language, Parser, Query } from 'web-tree-sitter';

import { HIGHLIGHTS_QUERY } from './highlights-query.generated';

/** Imperative handle exposed via `ref`. */
export interface ChordProDesktopEditorHandle {
  /** Move keyboard focus into the editor. */
  focus(): void;
  /** Read the current document contents. */
  getValue(): string;
}

export interface ChordProDesktopEditorProps {
  /** Controlled ChordPro source. */
  value: string;
  /** Fires synchronously on every user-initiated edit. Programmatic
   * `value`-prop updates do NOT fire this handler. */
  onChange?: (next: string) => void;
  /** Placeholder text shown when the document is empty. */
  placeholder?: string;
  /** className applied to the wrapper `<div>`. */
  className?: string;
}

/**
 * Mark decorations keyed by the capture names
 * `packages/tree-sitter-chordpro/queries/highlights.scm` emits.
 * Built once, reused on every highlight pass. `Decoration.mark` is
 * correct for inline spans (leaves line structure alone); the
 * grammar never spans whole blocks so we don't need
 * `Decoration.line`.
 *
 * The plugin publishes these marks directly, so their classes —
 * not `@lezer/highlight` tags — are what has to be painted, and
 * `chordproTheme` below paints them. A `HighlightStyle` would never
 * fire here: that pipeline colours a Lezer parse tree, and this
 * editor has no Lezer language, only tree-sitter. Keeping the class
 * names and their colours in one file is what stops the two from
 * drifting apart, which is exactly how the editor came to render
 * every capture in the body colour (#711).
 *
 * The captures left out are deliberate. `@string` (a directive's
 * value) and `@embedded` (the lines inside a verbatim
 * `{start_of_abc}` block) are copy, not syntax — the design-system
 * editor reference leaves both unstyled, and so does
 * `<ChordSourceArea>` in `@chordsketch/react`.
 */
const CAPTURE_MARK: Record<string, Decoration> = {
  comment: Decoration.mark({ class: 'cm-chordpro-comment' }),
  keyword: Decoration.mark({ class: 'cm-chordpro-keyword' }),
  constant: Decoration.mark({ class: 'cm-chordpro-chord' }),
  'punctuation.bracket': Decoration.mark({ class: 'cm-chordpro-punct' }),
};

interface LoadedGrammar {
  parser: Parser;
  query: Query;
}

let grammarPromise: Promise<LoadedGrammar> | null = null;

/**
 * Lazily load + cache the tree-sitter runtime, grammar, and
 * highlights query. Called by the editor plugin on first
 * construction; subsequent editor instances share the cached
 * `LoadedGrammar`. Caches successes only — a rejected load nulls
 * the cache so a later editor instance (e.g. after the wasm is
 * refreshed on disk) can retry rather than inheriting the old
 * rejection.
 */
async function loadGrammar(): Promise<LoadedGrammar> {
  if (grammarPromise) return grammarPromise;
  const attempt = (async () => {
    await Parser.init({
      // The runtime defaults to `locateFile: (p) => new URL(p, document.baseURI).href`.
      // We override anyway to pin the resolution explicitly — the
      // bundled Vite app's `baseURI` is the window location, and
      // `web-tree-sitter.wasm` is served at the web root by the
      // `public/` copy.
      locateFile: (path: string) =>
        new URL(`/${path}`, window.location.origin).href,
    });
    const language = await Language.load('/tree-sitter-chordpro.wasm');
    const parser = new Parser();
    parser.setLanguage(language);
    // `queries/highlights.scm` is the canonical query shipped in
    // `packages/tree-sitter-chordpro/queries/`. Inlining it here
    // keeps the runtime fetch count down (one less round-trip
    // compared to a separate GET for the `.scm`) and lets the
    // bundler tree-shake the source at build time.
    const query = new Query(language, HIGHLIGHTS_QUERY);
    return { parser, query };
  })();
  attempt.catch(() => {
    // Drop the cached rejection so the next editor instance
    // retries from scratch.
    if (grammarPromise === attempt) grammarPromise = null;
  });
  grammarPromise = attempt;
  return attempt;
}

/**
 * ViewPlugin that re-parses the document on every change, runs
 * the highlights query, and publishes the resulting decoration
 * set. `tree-sitter-chordpro`'s incremental-parse support is used
 * via `parser.parse(doc, oldTree)` to keep per-keystroke work
 * linear in the edit size rather than the document size.
 */
function highlightPlugin(grammar: LoadedGrammar) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      tree: ReturnType<Parser['parse']>;

      constructor(view: EditorView) {
        this.tree = grammar.parser.parse(view.state.doc.toString()) ?? null;
        this.decorations = this.buildDecorations();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          // `oldTree` makes the reparse incremental — tree-sitter
          // skips spans that didn't change. Without this, a 1000-
          // line file gets re-scanned top to bottom on every
          // keystroke, blowing the "stay responsive" AC.
          this.tree = grammar.parser.parse(
            update.state.doc.toString(),
            this.tree ?? undefined,
          );
          this.decorations = this.buildDecorations();
          publishDiagnostics(update.view, this.tree);
        }
      }

      buildDecorations(): DecorationSet {
        if (!this.tree) return Decoration.none;
        const builder = new RangeDecorationBuilder();
        // No range option: the query walks the whole tree. The
        // obvious `{ startIndex: 0, endIndex: doc.length }` is a trap
        // — `web-tree-sitter` passes those straight to tree-sitter's
        // BYTE range, while a CodeMirror document position counts
        // UTF-16 code units, so the range covers only the first half
        // of an ASCII document and everything after it silently loses
        // its highlighting. Viewport-scoped decorations would be
        // cheaper for very long buffers, but that needs a
        // per-visible-range decoration set; the chord sheets this
        // editor opens fit the "reparse on every keystroke" budget
        // whole.
        const matches = grammar.query.matches(this.tree.rootNode);
        for (const match of matches) {
          for (const capture of match.captures) {
            const mark = CAPTURE_MARK[capture.name];
            if (!mark) continue;
            builder.add(capture.node.startIndex, capture.node.endIndex, mark);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Helper that sorts decorations by `from` before handing them to
 * `Decoration.set(..., true)` — tree-sitter's query match order is
 * not position-sorted, and CodeMirror throws on unsorted ranges.
 */
class RangeDecorationBuilder {
  private entries: { from: number; to: number; value: Decoration }[] = [];

  add(from: number, to: number, value: Decoration): void {
    if (from === to) return; // Empty spans are rejected by CodeMirror.
    this.entries.push({ from, to, value });
  }

  finish(): DecorationSet {
    this.entries.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(
      this.entries.map((e) => e.value.range(e.from, e.to)),
    );
  }
}

/**
 * Hard cap on the number of diagnostics emitted per parse.
 * `@codemirror/lint` re-runs through state fields on every
 * transaction, so an unbounded list (pasted binary, malformed
 * 10 MB log) makes keystroke cost quadratic in the error count.
 * Once the cap is hit the walker stops collecting and the user
 * sees a single trailing "…and N more errors" entry so the
 * truncation is discoverable, not silent.
 */
const MAX_DIAGNOSTICS = 100;

/**
 * Walks the tree looking for `ERROR` / `MISSING` nodes and
 * surfaces them as `@codemirror/lint` diagnostics (red underline +
 * tooltip). Lets the editor flag unbalanced braces / brackets the
 * instant the user types them.
 */
function publishDiagnostics(
  view: EditorView,
  tree: ReturnType<Parser['parse']>,
): void {
  if (!tree) return;
  const diagnostics: Diagnostic[] = [];
  const walker = tree.walk();
  let truncated = 0;
  const pushDiagnostic = (d: Diagnostic): void => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      truncated += 1;
      return;
    }
    diagnostics.push(d);
  };
  const visit = (): void => {
    const node = walker.currentNode;
    if (node.isError) {
      pushDiagnostic({
        from: node.startIndex,
        to: Math.max(node.startIndex + 1, node.endIndex),
        severity: 'error',
        message: `Invalid ChordPro syntax near "${node.type}"`,
      });
    } else if (node.isMissing) {
      pushDiagnostic({
        from: node.startIndex,
        to: Math.max(node.startIndex + 1, node.endIndex),
        severity: 'error',
        message: `Missing "${node.type}"`,
      });
    }
    if (walker.gotoFirstChild()) {
      do {
        visit();
      } while (walker.gotoNextSibling());
      walker.gotoParent();
    }
  };
  try {
    visit();
  } finally {
    // `walker` wraps a WASM `TreeCursor` — skipping `.delete()`
    // would leak its WASM-side memory for the parser's lifetime.
    // The finally is unconditional so a thrown `visit()` (e.g. a
    // future `web-tree-sitter` regression) does not bleed handles
    // keystroke-by-keystroke (#2214).
    walker.delete();
  }
  if (truncated > 0) {
    // Trailing marker so the truncation is visible in the lint
    // gutter, not just silent. `from === to` would be rejected,
    // so anchor it at doc end with a 1-char span.
    const docLen = view.state.doc.length;
    diagnostics.push({
      from: Math.max(0, docLen - 1),
      to: docLen,
      severity: 'warning',
      message: `…and ${truncated} more syntax error${truncated === 1 ? '' : 's'} (truncated; fix earlier errors first)`,
    });
  }
  // Skip the dispatch on the common "valid ChordPro" path where
  // both the previous and the new diagnostics list are empty.
  // `@codemirror/lint`'s state field re-runs through every
  // transaction even when the value is unchanged, so eliminating
  // the empty-to-empty write halves the per-keystroke transaction
  // count on the happy path (#2215).
  if (diagnostics.length === 0 && !hasExistingDiagnostics(view)) {
    return;
  }
  view.dispatch(setDiagnostics(view.state, diagnostics));
  // `setDiagnostics` returns a `TransactionSpec` (not a
  // transaction), which `view.dispatch` accepts directly — no
  // extra wrapping needed.
}

/**
 * Return true iff the EditorState currently has at least one
 * diagnostic set. Iterates all existing diagnostics (O(n)) because
 * `forEachDiagnostic` has no built-in break; this is acceptable since
 * the function is only called on the error-clearing path where the
 * new diagnostics list is already empty.
 */
function hasExistingDiagnostics(view: EditorView): boolean {
  let found = false;
  forEachDiagnostic(view.state, () => {
    found = true;
  });
  return found;
}

// Theme for the editor's own surface, and the paint for the marks
// above. Both the metrics and the token roles mirror
// `<ChordSourceArea>`'s theme in `@chordsketch/react`, so the
// desktop source pane reads the same as the browser playground's:
// a crimson chord, secondary-tone directives, brackets and
// comments, and the song's copy as plain text. The values are the
// design tokens `@chordsketch/react/styles.css` puts in scope on the
// surrounding `<SplitLayout>`, with the same inline fallbacks that
// package uses.
const chordproTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.875rem',
    backgroundColor: 'var(--cs-surface, #FFFFFF)',
    color: 'var(--cs-text-primary, #0A0A0B)',
    fontFamily:
      "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.857',
    padding: '1rem',
  },
  '.cm-content': {
    caretColor: 'var(--cs-crimson-500, #BD1642)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--cs-surface, #FFFFFF)',
    borderRight: '1px solid var(--cs-border, #E8E6EA)',
    color: 'var(--cs-text-secondary, #67646D)',
  },
  '.cm-activeLine': {
    // A 4 % ink overlay rather than an opaque tint: CodeMirror paints
    // the selection below the line background, and an opaque one
    // would hide the selection wash on the caret line.
    backgroundColor: 'rgba(10, 10, 11, 0.04)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--cs-surface-hover, #F6F4F7)',
  },
  // Chord annotations (`[Am]`) — the one accent in the source pane.
  '.cm-chordpro-chord': {
    color: 'var(--cs-crimson-500, #BD1642)',
    fontWeight: '600',
  },
  // Directive names (`title`, `start_of_verse`) and the braces and
  // brackets around them. Both recede so the chords and lyrics read
  // first.
  '.cm-chordpro-keyword, .cm-chordpro-punct': {
    color: 'var(--cs-text-secondary, #67646D)',
  },
  '.cm-chordpro-comment': {
    color: 'var(--cs-text-secondary, #67646D)',
    fontStyle: 'italic',
  },
  '&.cm-focused': { outline: 'none' },
});

/**
 * Controlled CodeMirror editor with tree-sitter-chordpro
 * highlighting and diagnostics. Pair the `value` prop with
 * `onChange` to lift state into the parent; the component never
 * runs as an uncontrolled editor.
 *
 * Programmatic `value` updates from the parent (e.g. File → Open
 * loading a new buffer) dispatch a CodeMirror change transaction
 * that bypasses `onChange` — matches the React controlled-input
 * convention.
 */
export const ChordProDesktopEditor = forwardRef<
  ChordProDesktopEditorHandle,
  ChordProDesktopEditorProps
>(function ChordProDesktopEditor(
  { value, onChange, placeholder: placeholderText, className },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  // Per-instance flag drained inside the update listener. Set by
  // the controlled-mode sync effect just before dispatching the
  // replacement transaction so the change event flows through
  // CodeMirror's extensions (decorations need to refresh for the
  // new doc) without `onChange` firing on the React-controlled
  // setValue path.
  const suppressNextChangeRef = useRef(false);
  // Surface grammar load status so the editor can render a visible
  // banner if the tree-sitter wasm fails to load. The editor remains
  // usable as a plain-text editor in that case, but the user is
  // told why highlighting + diagnostics are missing rather than
  // silently going without them.
  const [grammarStatus, setGrammarStatus] = useState<
    'loading' | 'loaded' | 'failed'
  >('loading');

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Mount the EditorView once; tear it down on unmount. Subsequent
  // prop changes flow through the synchronisation effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const listenerExt = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (suppressNextChangeRef.current) {
        suppressNextChangeRef.current = false;
        return;
      }
      const next = update.state.doc.toString();
      onChangeRef.current?.(next);
    });

    const grammarCompartment = new Compartment();

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        chordproTheme,
        listenerExt,
        placeholder(placeholderText ?? ''),
        // Start empty; `loadGrammar()` injects the highlight plugin
        // once the wasm is ready. Initial render is plain text —
        // acceptable for the few hundred milliseconds of grammar
        // boot, and means a grammar load failure leaves the editor
        // usable (plain text with no highlighting) rather than
        // broken.
        grammarCompartment.of([]),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    // Kick off grammar load in the background; on resolution, inject
    // the highlight plugin via the compartment. On rejection the
    // editor stays usable as plain text and a visible banner above
    // the editor tells the user highlighting + diagnostics are
    // unavailable — surfacing the failure beyond the dev console so
    // a user without devtools open knows why their editor looks
    // plain.
    void loadGrammar()
      .then((grammar) => {
        // Guard against the view being destroyed before the grammar
        // resolves (rapid mount → unmount during HMR).
        if (viewRef.current !== view) return;
        view.dispatch({
          effects: grammarCompartment.reconfigure(highlightPlugin(grammar)),
        });
        setGrammarStatus('loaded');
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('Failed to load tree-sitter-chordpro grammar', err);
        if (viewRef.current !== view) return;
        setGrammarStatus('failed');
      });

    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // We intentionally only mount once. `value` updates flow
    // through the sync effect below; `placeholder` changes require
    // a remount which the user can force via React's `key` prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled-mode value synchronisation. Skips when the editor's
  // current doc already matches to avoid clobbering the caret on a
  // no-op render.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    suppressNextChangeRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    } finally {
      // Defensive: if the listener never observed the change for
      // any reason (synchronous dispatch always runs the listener,
      // but a future CodeMirror change could theoretically defer
      // it), do not leave the flag set across dispatches. The
      // listener resets it on success; this is the fallback.
      // We deliberately clear it AFTER dispatch so a normally
      // synchronous listener has already drained the flag.
      suppressNextChangeRef.current = false;
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
    }),
    [],
  );

  const wrapperClass = [
    'chordsketch-cm-host',
    grammarStatus === 'failed' ? 'chordsketch-cm-host--degraded' : null,
    className,
  ]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join(' ');

  // The host `<div>` is kept stable across grammar-status changes
  // so the mounted EditorView is never relocated by a React
  // reconcile pass. When the grammar load fails we render a
  // sibling banner ABOVE the host element rather than re-wrapping
  // it. `role="alert"` ensures screen readers announce the
  // degraded state on attach.
  return (
    <>
      {grammarStatus === 'failed' ? (
        <div role="alert" className="chordsketch-cm-grammar-banner">
          Syntax highlighting unavailable — ChordPro grammar failed to load.
          Edit will work but without highlighting or diagnostics.
        </div>
      ) : null}
      <div ref={hostRef} className={wrapperClass} />
    </>
  );
});
