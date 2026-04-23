/**
 * CodeMirror 6 + `tree-sitter-chordpro` editor for the desktop app.
 *
 * Implements the `EditorAdapter` contract from `@chordsketch/ui-web`
 * so the desktop host can swap in a rich editor without touching
 * the framework-agnostic ui-web code path. The playground stays on
 * the default `<textarea>` factory and does not pay the
 * CodeMirror / web-tree-sitter bundle cost.
 *
 * The grammar + runtime wasm binaries are copied into
 * `apps/desktop/public/` by `scripts/build-grammar-wasm.mjs` at
 * `prebuild` / `predev` time; Vite serves them at
 * `/tree-sitter-chordpro.wasm` and `/web-tree-sitter.wasm`.
 */
import type {
  EditorAdapter,
  EditorFactory,
  EditorFactoryOptions,
} from '@chordsketch/ui-web';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
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

// `HIGHLIGHTS_QUERY` is generated from
// `packages/tree-sitter-chordpro/queries/highlights.scm` by
// `scripts/build-grammar-wasm.mjs` at `prebuild` / `predev` time.
// That file is gitignored — the grammar is the single source of
// truth, so a grammar change forces the desktop editor to pick up
// the new query on the next build rather than relying on a
// hand-maintained inline copy.

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
        // Range-scoped `QueryOptions` are honoured here so the
        // highlight query only walks the visible / changed slice
        // of the tree rather than the entire document on every
        // keystroke. `tree-sitter`'s query cursor internally
        // clips matches to `[startIndex, endIndex)`.
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
  visit();
  walker.delete();
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
  view.dispatch(setDiagnostics(view.state, diagnostics));
  // `setDiagnostics` returns a `TransactionSpec` (not a
  // transaction), which `view.dispatch` accepts directly — no
  // extra wrapping needed.
}

// Base theme that fills the pane and matches the dark surface of
// the existing ui-web design tokens. Light-mode overrides live in
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
 * EditorFactory implementation. Passed to
 * `mountChordSketchUi({ createEditor: codemirrorEditorFactory })`
 * from the desktop bootstrap.
 */
export const codemirrorEditorFactory: EditorFactory = (
  options: EditorFactoryOptions,
): EditorAdapter => {
  const host = document.createElement('div');
  host.className = 'chordsketch-cm-host';

  const listeners = new Set<(value: string) => void>();
  // Per-adapter flag drained inside the update listener. Set by
  // `setValue` just before dispatching the replacement transaction
  // so the change event flows through CodeMirror's extensions
  // (decorations need to refresh for the new doc) without the
  // subscriber-facing `onChange` handlers firing — the
  // `EditorAdapter` contract requires programmatic loads to be
  // invisible to the subscriber. Only a single synchronous
  // dispatch happens between the flag set and the listener drain,
  // so there is no observable race.
  let suppressNextChange = false;
  const listenerExt = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (suppressNextChange) {
      suppressNextChange = false;
      return;
    }
    const value = update.state.doc.toString();
    for (const handler of listeners) handler(value);
  });

  const grammarCompartment = new Compartment();

  const state = EditorState.create({
    doc: options.initialValue,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      chordproTheme,
      syntaxHighlighting(chordproHighlightStyle),
      listenerExt,
      placeholder(options.placeholder ?? ''),
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

  // Kick off grammar load in the background; on resolution, inject
  // the highlight plugin via the compartment. Errors are logged to
  // the console — the user keeps a working plain-text editor.
  void loadGrammar()
    .then((grammar) => {
      view.dispatch({
        effects: grammarCompartment.reconfigure(highlightPlugin(grammar)),
      });
    })
    .catch((err: unknown) => {
      console.error('Failed to load tree-sitter-chordpro grammar', err);
    });

  return {
    element: host,
    getValue: () => view.state.doc.toString(),
    setValue: (value: string) => {
      // Replace the whole doc. Internal extensions (decorations,
      // highlighting) still need to run on this change, so we
      // dispatch a normal transaction — the `suppressNextChange`
      // flag above keeps the subscriber-facing listeners silent.
      suppressNextChange = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value,
        },
      });
    },
    onChange(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    focus: () => view.focus(),
    destroy: () => {
      listeners.clear();
      view.destroy();
    },
  };

};
