import { toValue, type MaybeGetter } from './reactive';
import { defaultWasmLoader, loadWasm } from './wasm-loader';

// Narrow subset of the `@chordsketch/wasm` module surface this
// helper touches. Defined structurally (rather than re-exported
// from the WASM package) so the Svelte bundle does not pull the WASM
// glue into its type graph — the actual module is dynamically
// imported at runtime.
//
// The HTML branch uses the BODY-only exports
// (`render_html_body*`), not `render_html`: the full-document
// output carries `<!DOCTYPE>` / `<html>` / `<head>` / `<style>`,
// which cannot be injected into a live page without leaking the
// renderer's document-level rules onto the host. `<ChordSheet>`
// pairs the body fragment with the renderer's stylesheet, scoped
// to its own wrapper — see `renderer-css.ts`.
export interface ChordRenderer {
  /**
   * Browser-build init function. Optional because the Node build
   * has none — see `wasm-loader.ts`, which owns the call.
   */
  default?: unknown;
  render_html_body: (input: string) => string;
  render_text: (input: string) => string;
  render_html_body_with_options: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => string;
  render_text_with_options: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => string;
  /**
   * Canonical chord-over-lyrics stylesheet the body fragment is
   * meant to be painted with. Optional on this interface because
   * only `<ChordSheet format="html">` consults it (via
   * `ensureRendererCss`), and because bundles predating the export
   * simply have no stylesheet to offer — the fragment then renders
   * with whatever the host supplies.
   */
  render_html_css?: () => string;
  /**
   * Variant of `render_html_css` honouring `settings.wraplines`
   * from the supplied options. Same optionality rationale.
   */
  render_html_css_with_options?: (options: {
    transpose?: number;
    config?: string;
  }) => string;
}

/** Options accepted by the render call. */
export interface ChordRenderOptions {
  /** Semitone transposition offset (reduced modulo 12 by the renderer). */
  transpose?: number;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or
   * inline RRJSON configuration string.
   */
  config?: string;
}

/** Supported render targets. */
export type ChordRenderFormat = 'html' | 'text';

/** Options accepted by {@link useChordRender}. */
export interface UseChordRenderOptions extends ChordRenderOptions {
  /** Render target. Defaults to `"html"`. */
  format?: ChordRenderFormat;
}

/** Reactive state returned by {@link useChordRender}. */
export interface ChordRenderResult {
  /**
   * Rendered output. `null` while WASM is initialising or while the
   * first render is in flight.
   */
  readonly output: string | null;
  /** `true` while the WASM module is loading or the render is in flight. */
  readonly loading: boolean;
  /**
   * The most recent render error (parse error, WASM init failure,
   * etc.), or `null` if the last render succeeded. Consumers render
   * this rather than letting the component throw.
   */
  readonly error: Error | null;
}

/**
 * Injected WASM loader. Tests pass a structurally-compatible stub;
 * production callers take the default, which lazy-loads
 * `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordWasmLoader = () => Promise<ChordRenderer>;

/**
 * Render a ChordPro source to an HTML fragment or plain text via
 * `@chordsketch/wasm`. The WASM module is loaded once per loader
 * (lazy) and reused; the render re-runs whenever `source` or one of
 * the options changes and never in between.
 *
 * Render errors are surfaced through the returned `error` property,
 * not thrown — the helper keeps the previous `output` visible so a
 * transient invalid edit does not blank the preview. Consumers
 * decide whether to display the error inline, toast it, or ignore.
 *
 * Call it during component initialisation: the re-render is an
 * `$effect`, which needs an owning component (or an `$effect.root`)
 * to be cleaned up with.
 *
 * ```svelte
 * <script lang="ts">
 *   let source = $state('{title: Song}\n[C]Hello');
 *   const render = useChordRender(() => source, () => ({ transpose: 2 }));
 * </script>
 *
 * {#if render.output !== null}{@html render.output}{/if}
 * ```
 */
export function useChordRender(
  source: MaybeGetter<string>,
  options: MaybeGetter<UseChordRenderOptions> = {},
  loader: ChordWasmLoader = defaultWasmLoader,
): ChordRenderResult {
  let output = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<Error | null>(null);

  $effect(() => {
    // Every reactive input is read synchronously, before the first
    // await: an effect only tracks what it reads up to the point it
    // yields, so a value read after an await would not re-trigger
    // the render when it changes.
    const input = toValue(source);
    const { format = 'html', transpose, config } = toValue(options);

    // Guard against a late-resolving render overwriting a more
    // recent one — if the inputs change while we are awaiting the
    // renderer, the effect re-runs, this flag flips, and the
    // in-flight render becomes a no-op.
    let cancelled = false;

    const run = async (): Promise<void> => {
      loading = true;
      try {
        // `loadWasm` caches the initialised module per loader, so an
        // input change mid-init does not start a second one.
        const renderer = await loadWasm(loader);
        if (cancelled) return;
        const hasOptions = transpose !== undefined || config !== undefined;
        let rendered: string;
        if (format === 'html') {
          rendered = hasOptions
            ? renderer.render_html_body_with_options(input, { transpose, config })
            : renderer.render_html_body(input);
        } else {
          rendered = hasOptions
            ? renderer.render_text_with_options(input, { transpose, config })
            : renderer.render_text(input);
        }
        if (cancelled) return;
        output = rendered;
        error = null;
      } catch (e) {
        if (cancelled) return;
        error = e instanceof Error ? e : new Error(String(e));
        // Deliberately keep the previous `output` so a momentarily
        // invalid edit (e.g. half-typed directive) does not blank
        // the preview. Consumers can render `error` alongside the
        // stale output if they want to surface the issue.
      } finally {
        if (!cancelled) {
          loading = false;
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  });

  return {
    get output() {
      return output;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
  };
}
