import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

/**
 * CodeMirror 6 autocomplete for ChordPro directives and their values,
 * backed by the shared `@chordsketch/wasm` directive catalog (ADR-0028).
 *
 * The catalog is the SAME source the LSP completion reads, so the web
 * editor offers exactly the directive set + enum values that VS Code does
 * — no second hand-maintained list to drift.
 *
 * Two contexts are completed:
 * - inside `{…}` before the colon → directive names;
 * - after the colon of an enum-valued directive (e.g. `{diagrams: }`) →
 *   that directive's allowed values.
 *
 * Free-form directive values (`{title: …}`) and chord brackets (`[…]`)
 * are intentionally not completed here.
 */

/** One directive-catalog entry as returned by `@chordsketch/wasm`'s `listDirectives()`. */
export interface DirectiveCatalogEntry {
  name: string;
  aliases: string[];
  valueKind: 'none' | 'freeform' | 'enum';
  values: string[];
  summary: string;
}

/**
 * Narrow structural view of the catalog functions this module needs.
 * Kept structural (not a dependency on the wasm module's generated types)
 * so the default loader can cast the dynamic import and tests can inject a
 * plain stub — mirroring `useChordDiagram`'s `DiagramRenderer` approach.
 */
export interface ChordproCatalog {
  listDirectives(): DirectiveCatalogEntry[];
  directiveValueOptions(name: string): string[] | null | undefined;
}

/** Async catalog provider. Production uses the default lazy wasm loader. */
export type ChordproCatalogLoader = () => Promise<ChordproCatalog>;

interface WasmCatalogModule {
  default: () => Promise<unknown>;
  listDirectives: () => DirectiveCatalogEntry[];
  directiveValueOptions: (name: string) => string[] | null | undefined;
}

/**
 * Lazily load the directive catalog from `@chordsketch/wasm` (ADR-0028).
 *
 * This is the default backing for {@link chordProCompletionSource}, and is
 * exported so other consumers — the playground's "Insert directive" picker,
 * for instance — drive their directive list from the same single source the
 * editor completion and the LSP use, rather than a hand-maintained copy.
 */
export const loadChordproCatalog: ChordproCatalogLoader = async () => {
  const mod = (await import('@chordsketch/wasm')) as unknown as WasmCatalogModule;
  // Both wasm-pack outputs expose a `default` init; the nodejs build's is a
  // no-op, the web build's loads the `.wasm`. Mirrors `useChordDiagram`.
  await mod.default();
  return {
    listDirectives: () => mod.listDirectives(),
    directiveValueOptions: (name: string) => mod.directiveValueOptions(name),
  };
};

/** Characters that may appear in a directive name (matches the parser). */
const DIRECTIVE_NAME_RE = /^[A-Za-z0-9_+.-]*$/;
/** Characters that may appear in a completable directive value token. */
const DIRECTIVE_VALUE_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Resolved completion context from the text before the caret on one line.
 * `from` is the 0-based offset (within `textBefore`) where the replaceable
 * token starts. `null` means "no ChordPro completion here".
 */
export type ChordproCompletionContext =
  | { kind: 'directive'; prefix: string; from: number }
  | { kind: 'value'; directive: string; prefix: string; from: number }
  | null;

/**
 * Detect the completion context from the line text up to the caret.
 *
 * Mirrors the LSP's `detect_context` brace logic: the innermost unclosed
 * `{` decides whether we are completing a directive name (before the colon)
 * or a directive value (after it). Exported for unit testing.
 */
export function detectChordproCompletion(textBefore: string): ChordproCompletionContext {
  const lastOpen = textBefore.lastIndexOf('{');
  if (lastOpen === -1) return null;
  const afterOpen = textBefore.slice(lastOpen + 1);
  // A `}` between the `{` and the caret means the directive already closed.
  if (afterOpen.includes('}')) return null;

  const colon = afterOpen.indexOf(':');
  if (colon === -1) {
    // Directive name: prefix is the text after `{` with any leading space
    // skipped. Bail if it contains a character a directive name cannot.
    const trimmedStart = afterOpen.length - afterOpen.trimStart().length;
    const prefix = afterOpen.slice(trimmedStart);
    if (!DIRECTIVE_NAME_RE.test(prefix)) return null;
    return { kind: 'directive', prefix: prefix.toLowerCase(), from: lastOpen + 1 + trimmedStart };
  }

  // Directive value: directive name is before the colon; the value token is
  // after it with leading spaces skipped.
  const directive = afterOpen.slice(0, colon).trim().toLowerCase();
  if (!directive) return null;
  const rawValue = afterOpen.slice(colon + 1);
  const valueStart = rawValue.length - rawValue.trimStart().length;
  const prefix = rawValue.slice(valueStart);
  // Only single-token enum values are completed; a space means free text.
  if (!DIRECTIVE_VALUE_RE.test(prefix)) return null;
  return {
    kind: 'value',
    directive,
    prefix: prefix.toLowerCase(),
    from: lastOpen + 1 + colon + 1 + valueStart,
  };
}

/**
 * Build the CodeMirror {@link CompletionSource}. Production callers use the
 * default loader (lazy `@chordsketch/wasm`); tests inject a stub catalog.
 *
 * The catalog is fetched once and cached on the returned source.
 */
export function chordProCompletionSource(
  loader: ChordproCatalogLoader = loadChordproCatalog,
): CompletionSource {
  let cache: ChordproCatalog | null = null;
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);
    const detected = detectChordproCompletion(textBefore);
    if (!detected) return null;

    if (cache === null) {
      try {
        cache = await loader();
      } catch {
        // wasm unavailable (e.g. SSR / load failure): no completion rather
        // than throwing into the editor.
        return null;
      }
    }

    if (detected.kind === 'directive') {
      const options = cache.listDirectives().map((d) => ({
        label: d.name,
        type: 'keyword',
        detail: d.aliases[0] ? `alias: ${d.aliases[0]}` : undefined,
        info: d.summary,
      }));
      return {
        from: line.from + detected.from,
        options,
        validFor: DIRECTIVE_NAME_RE,
      };
    }

    const values = cache.directiveValueOptions(detected.directive);
    if (!values || values.length === 0) return null;
    return {
      from: line.from + detected.from,
      options: values.map((v) => ({ label: v, type: 'value' })),
      validFor: DIRECTIVE_VALUE_RE,
    };
  };
}
