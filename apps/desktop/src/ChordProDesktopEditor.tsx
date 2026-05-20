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
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
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
import { tags as t, type Tag } from '@lezer/highlight';
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

// `tags` recognises a fixed vocabulary. Map every tree-sitter
// capture name in `queries/highlights.scm` to one of them so
// `HighlightStyle` can colour them. Kept narrow — the grammar
// only uses five capture classes.
const CAPTURE_TO_TAG: Record<string, Tag> = {
  comment: t.comment,
  keyword: t.keyword,
  string: t.string,
  constant: t.literal,
  'punctuation.bracket': t.punctuation,
  embedded: t.special(t.string),
};

// Mark decorations keyed by capture name. Built once, reused on
// every highlight pass. `Decoration.mark` is correct for inline
// spans (leaves line structure alone); the grammar never spans
// whole blocks so we don't need `Decoration.line`.
const CAPTURE_MARK: Record<string, Decoration> = Object.fromEntries(
  Object.keys(CAPTURE_TO_TAG).map((capture) => [
    capture,
    // `replaceAll` covers multi-dotted capture names like
    // `variable.parameter.builtin` should the grammar ever emit
    // them. `.replace('.', '-')` only substitutes the first dot
    // and would collide with sibling captures on the second
    // segment.
    Decoration.mark({ class: `cm-capture-${capture.replaceAll('.', '-')}` }),
  ]),
);

/**
 * CodeMirror `HighlightStyle` pairing each tag with the desktop
 * theme colours. Light + dark are applied by CSS variables in
 * `apps/desktop/src/codemirror-editor.css`, so the theme respects
 * `prefers-color-scheme` without JS work.
 */
const chordproHighlightStyle = HighlightStyle.define([
  { tag: CAPTURE_TO_TAG.comment, class: 'cm-chordpro-comment' },
  { tag: CAPTURE_TO_TAG.keyword, class: 'cm-chordpro-keyword' },
  { tag: CAPTURE_TO_TAG.string, class: 'cm-chordpro-string' },
  { tag: CAPTURE_TO_TAG.constant, class: 'cm-chordpro-chord' },
  { tag: CAPTURE_TO_TAG['punctuation.bracket'], class: 'cm-chordpro-punct' },
  { tag: CAPTURE_TO_TAG.embedded, class: 'cm-chordpro-embedded' },
]);

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
        this.decorations = this.buildDecorations(view);
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
          this.decorations = this.buildDecorations(update.view);
          publishDiagnostics(update.view, this.tree);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        if (!this.tree) return Decoration.none;
        const builder = new RangeDecorationBuilder();
        // Pass the full document extent to the query so tree-sitter
        // walks every node. Viewport-scoped decorations would be
        // cheaper for very long buffers, but the current chord
        // fixtures comfortably fit the "reparse on every keystroke"
        // budget, and viewport scoping requires maintaining a
        // per-visible-range decoration set — a future optimisation
        // if large files become a concern. Keep the call symmetric
        // with `tree.rootNode.text` so a future reader can't
        // mistakenly assume range scoping is already in place.
        const matches = grammar.query.matches(this.tree.rootNode, {
          startIndex: 0,
          endIndex: view.state.doc.length,
        });
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

// Base theme that fills the pane and matches the dark surface of
// the shared design tokens. Light-mode overrides live in
// `codemirror-editor.css` (which Vite bundles alongside this
// module) and kick in via `prefers-color-scheme: light`.
const chordproTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '0.9rem',
      fontFamily:
        "'SF Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
    },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.6',
      padding: '1rem',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

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
        syntaxHighlighting(chordproHighlightStyle),
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
        <div
          role="alert"
          className="chordsketch-cm-grammar-banner"
          style={{
            padding: '0.5rem 1rem',
            background: '#3a2a00',
            color: '#ffd66e',
            borderBottom: '1px solid #66501a',
            fontSize: '0.85rem',
            fontFamily:
              "'-apple-system', 'BlinkMacSystemFont', 'Segoe UI', sans-serif",
          }}
        >
          Syntax highlighting unavailable — ChordPro grammar failed to load.
          Edit will work but without highlighting or diagnostics.
        </div>
      ) : null}
      <div ref={hostRef} className={wrapperClass} />
    </>
  );
});
