<!--
@component
Render a chord diagram (guitar / ukulele / piano) as inline SVG via
`@chordsketch/wasm`. The SVG comes from the trusted
`chordsketch_chordpro::chord_diagram` Rust module — the same
generator `<ChordSheet>`'s HTML output uses — so injecting it as HTML
is safe.

```svelte
<ChordDiagram chord="Am" instrument="guitar" />
```

### Snippets

- `loading` — while the WASM module loads. Defaults to a minimal
  `role="status"` placeholder.
- `notFound` — receives `{ chord, instrument }`, rendered when the
  voicing database has no entry for the pair. Defaults to an inline
  `role="note"` message so the chord name stays visible to a reader
  skimming the page.
- `error` — receives the `Error`, rendered when the underlying call
  fails (unknown instrument, WASM init failure). Defaults to an
  inline `role="alert"`.
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  import {
    useChordDiagram,
    type ChordDiagramInstrument,
    type ChordDiagramOrientation,
    type ChordDiagramWasmLoader,
  } from './use-chord-diagram.svelte';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** Chord name (e.g. `"Am"`, `"C#m7"`, `"Bb"`). */
    chord: string;
    /** Instrument family. Defaults to `"guitar"`. */
    instrument?: ChordDiagramInstrument;
    /**
     * Optional list of song-level `{define: <name> <raw>}` voicings
     * to consult before falling back to the built-in voicing
     * database. Each entry is a `[chord_name, raw]` tuple — the raw
     * string carries the directive body (e.g. `"base-fret 1 frets
     * 3 3 0 0 1 3"`). Mirrors the Rust `voicings::lookup_diagram`'s
     * "song-level defines take priority" rule.
     */
    defines?: ReadonlyArray<readonly [string, string]>;
    /**
     * Diagram orientation. Defaults to `"vertical"` — nut on top,
     * frets running downward. Pass `"horizontal"` for the
     * Japanese-tablature convention with nut on the left and frets
     * running rightward (reader-view, high pitch on top).
     */
    orientation?: ChordDiagramOrientation;
    /**
     * Render the compact above-a-lyric layout (the chordsketch
     * extension used by the `{diagrams: inline}` / `{diagrams:
     * hover}` modes). Defaults to `false` (the full-size diagram).
     * Falls back to the regular size on `@chordsketch/wasm` bundles
     * that predate the compact export.
     */
    compact?: boolean;
    /** Shown while the WASM module loads. */
    loading?: Snippet;
    /** Rendered when the voicing database has no entry for the pair. */
    notFound?: Snippet<[{ chord: string; instrument: ChordDiagramInstrument }]>;
    /** Rendered when the lookup fails. Receives the `Error`. */
    error?: Snippet<[Error]>;
    /**
     * Test-only WASM loader override. Production callers never need
     * to supply this — the default lazy-loads `@chordsketch/wasm`.
     *
     * @internal
     */
    wasmLoader?: ChordDiagramWasmLoader;
  }

  let {
    chord,
    instrument = 'guitar',
    defines = undefined,
    orientation = undefined,
    compact = false,
    loading: loadingSnippet = undefined,
    notFound: notFoundSnippet = undefined,
    error: errorSnippet = undefined,
    wasmLoader = undefined,
    ...rest
  }: Props = $props();

  // Snapshot — see the same note in `ChordSheet.svelte`.
  const diagram = useChordDiagram(
    () => chord,
    () => ({ instrument, defines, orientation, compact }),
    untrack(() => wasmLoader),
  );

  // Attributes shared by all four render branches, so the wrapper a
  // host styles or queries looks the same whether the diagram, the
  // placeholder, the not-found note or the error is showing.
  //
  // `data-orientation` surfaces the active orientation so consumers
  // and tests can observe it without parsing the SVG; it is omitted
  // (not emitted as `data-orientation=""`) when the prop is unset,
  // so the default vertical case stays attribute-free.
  //
  // `--compact` is a hook for host CSS; the compact geometry itself
  // comes from the renderer's compact SVG template.
  const wrapperAttrs = $derived({
    'data-orientation': orientation,
    ...rest,
    class: [
      'chordsketch-diagram',
      compact ? 'chordsketch-diagram--compact' : null,
      rest.class,
    ],
  });
</script>

{#if diagram.error !== null}
  <div {...wrapperAttrs}>
    {#if errorSnippet}
      {@render errorSnippet(diagram.error)}
    {:else}
      <div role="alert" class="chordsketch-diagram__error">{diagram.error.message}</div>
    {/if}
  </div>
{:else if diagram.svg === null}
  {#if diagram.loading}
    <div {...wrapperAttrs} aria-busy="true">
      {#if loadingSnippet}
        {@render loadingSnippet()}
      {:else}
        <div role="status" aria-live="polite" class="chordsketch-diagram__loading">
          Loading diagram…
        </div>
      {/if}
    </div>
  {:else}
    <!-- Not loading and no SVG — the voicing database has no entry
         for this pair. -->
    <div {...wrapperAttrs}>
      {#if notFoundSnippet}
        {@render notFoundSnippet({ chord, instrument })}
      {:else}
        <div role="note" class="chordsketch-diagram__notfound">
          <strong>{chord}</strong><span
            > — no {instrument} voicing in the built-in database</span
          >
        </div>
      {/if}
    </div>
  {/if}
{:else}
  <!-- Without an explicit name the inline SVG's accessible name is
       the empty string and the chord identity is invisible to screen
       readers. A host-supplied `role` (e.g. a tooltip wrapper) wins
       over this one. -->
  <div
    role="img"
    aria-label={`${chord} chord diagram (${instrument})`}
    {...wrapperAttrs}
  >
    {@html diagram.svg}
  </div>
{/if}
