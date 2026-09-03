# Embed ChordPro in your Svelte app

`@chordsketch/svelte` ships the same parser + renderer pipeline that
powers <https://chordsketch.koeda.me> as a published Svelte 5
component library. This page is the recipe collection for the most
common embedding scenarios; copy-paste into a fresh Vite + Svelte 5
app (or SvelteKit, see
[§Server-side rendering / SvelteKit](#recipe-8-server-side-rendering-sveltekit)
below) and it works.

It is the Svelte counterpart of
[Embed ChordPro and iReal Pro in a React app](embed-react.md) and
[Embed ChordPro in a Vue app](embed-vue.md) — the recipes below
follow those pages' order, and the three components render the same
output from the same engine. Where the Svelte package has no
counterpart for a React recipe, that is called out in
[§What the Svelte package does not cover](#what-the-svelte-package-does-not-cover).

> **Try it first.** Recipes 1 and 4 — `<ChordTextarea>` and
> `<Transpose>` — are running as an editable page at
> <https://chordsketch.koeda.me/svelte/>, built on this package. Type
> ChordPro there and watch the engine render it before you install
> anything ([ADR-0053](../../adr/0053-framework-demos-live-in-the-playground.md)).

> **Prerequisite.** `npm install @chordsketch/svelte svelte`. Svelte
> 5.0 or newer is a peer dependency — the components are written
> with runes and do not run on Svelte 4. The package ships
> preprocessed `.svelte` sources rather than compiled JavaScript
> ([ADR-0052](../../adr/0052-svelte-bindings-publish-sources.md)),
> so your own bundler compiles them with your app; Vite + SvelteKit
> resolve them through the `svelte` export condition with no extra
> configuration. The PDF / PNG export bundle is a separate optional
> peer — see [§Export to PDF](#recipe-5-export-to-pdf) for when to
> install it.

Three conventions differ from the React package throughout, because
they are how Svelte expresses the same ideas:

- **Render-prop fallbacks are snippets.** React's `loadingFallback`
  / `errorFallback` / `notFoundFallback` props are the `loading` /
  `error` / `notFound` snippets here.
- **Value callbacks are bindings.** React's `value` + `onChange`
  pair is a single `bind:value`, and `onTransposeChange` is
  `bind:transpose`. Event callbacks that carry no value —
  `<PdfExport>`'s `onExported` / `onError` — stay callbacks.
- **State helpers take getters** (React's hooks take positional
  arguments) and return objects with reactive properties. Pass
  `() => source` rather than `source`: reading a `$state` variable
  at the call site would capture one snapshot. A value that never
  changes can be passed directly.

## Recipe 1 — Drop in a ChordPro editor in 30 seconds

The fastest path. One component, no configuration, editor pane +
live preview:

```svelte
<script lang="ts">
  import { ChordTextarea } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';

  let source = $state('{title: My Song}\n[G]Hello [D]world');
</script>

<ChordTextarea bind:value={source} />
```

`<ChordTextarea>` also runs unbound: drop the `bind:`, and the
component keeps the text in its own state. There is no controlled /
uncontrolled split to opt into — binding the prop is what moves
ownership to the host. The preview re-renders a debounced copy of
the source (`debounceMs`, default `250`), so typing never stalls on
the renderer.

Add `bind:transpose` and `Ctrl`/`Cmd` + `ArrowUp` / `ArrowDown` step
the preview's transposition, clamped into `[transposeMin,
transposeMax]` (default `±11`). Unlike the React and Vue siblings,
this component **always** calls `preventDefault()` on that
combination, bound or not: `$bindable` gives the child no way to
detect whether the parent used `bind:transpose`, so there is no
runtime signal to gate the interception on. Hosts that need the
browser's own `Ctrl`+`ArrowUp`/`ArrowDown` paragraph navigation
(notably in Firefox) have to wrap the surrounding element and
re-dispatch the key event themselves.

## Recipe 2 — Render a read-only chord sheet

For lyrics-and-chords display without any editing affordance:

```svelte
<script lang="ts">
  import { ChordSheet } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';

  const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;
</script>

<ChordSheet {source} transpose={0} />
```

`format="html"` (the default) injects the engine's own chord-over-
lyrics fragment (`render_html_body`) together with the engine's
stylesheet, rewritten so every rule applies only inside
`.chordsketch-sheet__content` — the component styles itself and
nothing leaks onto the surrounding page. Override the reading column
with your own CSS if you want a different width:

```css
.chordsketch-sheet__content { max-width: none; }
```

`format="text"` switches to a `<pre>`-wrapped plain-text render for
an even-more-conservative preview.

Parse and render errors reach the `error` snippet rather than
throwing, and the previous successful output stays visible
underneath, so a half-typed edit never blanks the preview:

```svelte
<ChordSheet {source}>
  {#snippet loading()}<p>Loading…</p>{/snippet}
  {#snippet error(err)}<p role="alert">{err.message}</p>{/snippet}
</ChordSheet>
```

Pass an empty snippet (`{#snippet error(_err)}{/snippet}`) to
suppress the inline fallback entirely — the equivalent of React's
`errorFallback={null}` — when the host surfaces failures through a
toast instead.

## Recipe 3 — Build a custom editor layout

`<ChordTextarea>` is the batteries-included split pane. When you want
your own pane layout, compose the pieces yourself: any editor
surface, `useDebounced` to keep the renderer off the keystroke path,
and `<ChordSheet>` for the preview.

```svelte
<script lang="ts">
  import { ChordSheet, useDebounced } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';

  let source = $state('{title: My Song}\n[G]Hello');
  const debounced = useDebounced(() => source, 250);
</script>

<div class="editor">
  <textarea bind:value={source} aria-label="ChordPro editor" spellcheck="false"
  ></textarea>
  <ChordSheet source={debounced.current} />
</div>

<style>
  .editor {
    display: grid;
    gap: 1rem;
    grid-template-columns: 1fr 1fr;
  }
  @media (max-width: 767px) {
    .editor {
      grid-template-columns: 1fr;
    }
  }
</style>
```

`useDebounced(value, delay)` returns `{ current }`, which follows
`value` once `delay` ms have passed without a change; `delay <= 0`
skips the timer, which is what tests usually want. It registers an
`$effect`, so call it during component initialisation (or inside an
`$effect.root`) — the same applies to `useChordRender` and
`useChordDiagram`.

The Svelte package deliberately stops at the plain `<textarea>` —
the syntax-highlighting CodeMirror surface and the split-layout
primitive are React-only (see
[§What the Svelte package does not cover](#what-the-svelte-package-does-not-cover)).
The public contract of `<ChordTextarea>` is only "a bindable string
value", so layering a richer editor on top is a host-side choice
that does not change any of the above.

## Recipe 4 — Add transposition controls

`<Transpose>` is a native `<select>` listing every semitone offset
between `min` and `max` — keyboard and screen-reader support come
from the browser's own control. Bind its value and forward the same
value to `<ChordSheet>`:

```svelte
<script lang="ts">
  import { ChordSheet, Transpose, useTranspose } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';

  const source = '{title: Hello}\n[Am]hello [F]world';
  const transpose = useTranspose();
</script>

<Transpose bind:value={transpose.value} />
<ChordSheet {source} transpose={transpose.value} />
```

`useTranspose()` returns a plain object whose `value` property has a
clamping setter, which is what makes `bind:value={transpose.value}`
safe: a `<Transpose max={11}>` writing `11` into a helper capped at
`6` lands on `6` rather than escaping the range the caller asked
for.

The two defaults differ on purpose: `useTranspose()` clamps to the
feature limit `±11` (a full octave is the identity, so `±12` renders
the written chords), while the select offers the narrower `±6` that
is useful in practice. Pass `min` / `max` to `<Transpose>` to widen
the option list to whatever range the helper is clamping to.

`useTranspose()` also returns `increment` / `decrement` / `reset` /
`setValue` for hosts that build their own control (slider, number
input, keyboard shortcut). Every one of them clamps, and `reset()`
returns to the initial value — not necessarily zero. It registers no
`$effect`, so it can be called anywhere, including module scope when
a whole app shares one transposition.

## Recipe 5 — Export to PDF

PDF export ships in a separate heavy bundle so the lean
`@chordsketch/wasm` core stays small. Install the optional peer
alongside `@chordsketch/svelte`:

```bash
npm install @chordsketch/wasm-export
```

Then drop in `<PdfExport>`:

```svelte
<script lang="ts">
  import { PdfExport } from '@chordsketch/svelte';

  const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

  function onExported(filename: string): void {
    console.log(`saved ${filename}`);
  }

  function onError(err: Error): void {
    console.error(err);
  }
</script>

<PdfExport {source} filename="amazing-grace.pdf" {onExported} {onError}>
  Export PDF
</PdfExport>
```

The heavy bundle is **lazy-loaded** on first export — the initial
page load does not pay for it. The component's children are the
button label (default: `Export PDF`), attributes such as `class` /
`id` / `data-*` fall through to the `<button>`, and `onExported` /
`onError` are the same callbacks React takes. A failed render also
renders through the `error` snippet.

`usePdfExport()` returns the same `exportPdf` pipeline as state
(`{ exportPdf, loading, error }`) for custom UIs — dropdown items,
command palettes, and so on. Like `useTranspose` it registers no
`$effect`, so it is not restricted to component initialisation.

## Recipe 6 — Render chord diagrams

`<ChordDiagram>` looks up the chord in the built-in voicing database
and returns inline SVG that inherits `currentColor`:

```svelte
<script lang="ts">
  import { ChordDiagram } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';
</script>

<ChordDiagram chord="Am" instrument="guitar" />
<ChordDiagram chord="C" instrument="ukulele" />
<ChordDiagram chord="Dm7" instrument="piano" />
```

An unknown chord is **not** an error: the lookup resolves to no
voicing and the `notFound` snippet renders instead, receiving
`{ chord, instrument }` (default: an inline `role="note"` keeping
the chord name visible). The `error` snippet is reserved for real
failures — an unknown instrument, a WASM init that never completed.

`orientation="horizontal"` switches to the Japanese-tablature
convention (nut on the left), and `compact` renders the
above-a-lyric layout used by `{diagrams: inline}`.
`useChordDiagram()` returns the raw SVG string for hosts that want
to embed it inside custom markup (tooltip, popover, etc.).

## Recipe 7 — Drive your own UI from the render output

For hosts that want to place the rendered song somewhere
`<ChordSheet>`'s wrapper does not fit — a karaoke prompter, a print
layout, a diffing view — `useChordRender` exposes the same pipeline
as reactive state:

```svelte
<script lang="ts">
  import { useChordRender } from '@chordsketch/svelte';

  let { source }: { source: string } = $props();
  const render = useChordRender(() => source, { format: 'text' });
</script>

<article>
  {#if render.error !== null}
    <p role="alert">{render.error.message}</p>
  {:else if render.loading && render.output === null}
    <p>Loading…</p>
  {/if}
  {#if render.output !== null}
    <pre>{render.output}</pre>
  {/if}
</article>
```

`useChordRender` is what `<ChordSheet>` uses internally, so driving
it directly gives identical output you can place anywhere in your
tree. It resolves to a **string** — the rendered HTML fragment or
plain text — not to an AST. For AST-level custom rendering (React's
`useChordproAst` / `renderChordproAst`), call `parseChordpro` on
`@chordsketch/wasm` directly and walk the JSON yourself; the Svelte
package has no helper around it.

## Recipe 8 — Server-side rendering / SvelteKit

The components are safe to render on the server, but the sheet
itself is filled in on the client. Two things make that so: the
stylesheet injection no-ops when there is no `document`, and the
render lives in an `$effect`, which Svelte does not run during SSR.
The server therefore emits the component's wrapper (plus the
`loading` snippet, if you supply one) and the client swaps in the
rendered sheet once the runtime is up — the same markup on both
sides, so hydration is clean.

```svelte
<!-- src/routes/song/[id]/+page.svelte -->
<script lang="ts">
  import { ChordSheet } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';

  let { data }: { data: { source: string } } = $props();
</script>

<ChordSheet source={data.source}>
  {#snippet loading()}<p>Loading…</p>{/snippet}
</ChordSheet>
```

Prefer rendering the preview on the client even for static content:
the browser's HTTP cache stores `chordsketch_wasm_bg.wasm` once and
reuses it across navigations, which a per-request server render
cannot do.

For pure server rendering (generating an OG image, emailing a PDF),
drive `@chordsketch/wasm` directly from a `+server.ts` endpoint and
call `render_html_with_options` / `render_pdf` — the Svelte
components are the wrong layer for non-Svelte server rendering.

## What the Svelte package does not cover

`@chordsketch/svelte` covers the ChordPro surface. Three areas of
[`@chordsketch/react`](embed-react.md) have no Svelte counterpart,
by design rather than by omission:

| React surface | Why there is no Svelte equivalent |
|---|---|
| iReal Pro (`<IrealProEditor>`, `<IrealPreview>`, `useIrealParse`, …) | Not ported. Recipes 8 and 9 of the React page are React-only for now. |
| AST walker (`useChordproAst`, `renderChordproAst`) | `<ChordSheet format="html">` renders the engine's own HTML instead of walking the AST into a component tree, per [ADR-0017](../../adr/0017-react-renders-from-ast.md). See Recipe 7 for the AST-level escape hatch. |
| Interaction props built on that walker (in-preview chord selection, drag-to-reposition, chord audio) | They address React elements produced by the walker, which the Svelte render path never creates. |

The CodeMirror source editor (`<ChordSourceArea>`) and the
`<SplitLayout>` / `<RendererPreview>` primitives are likewise
React-only; Recipe 3 shows the Svelte way to build the same layout.

Everything else — preview, editor, transposition, chord diagrams,
PDF export — is present under the same prop names, defaults and DOM
class vocabulary as the React package, so a port between the two is
mechanical.

## See also

- [Embed ChordPro and iReal Pro in a React app](embed-react.md) —
  the React counterpart of this page, and the home of the iReal Pro
  recipes.
- [Embed ChordPro in a Vue app](embed-vue.md) — the same recipes for
  `@chordsketch/vue`, whose Composition-API shape is the closest
  neighbour to the helpers used here.
- [Render to HTML, plain text, or PDF](render.md) — same operation
  across every binding (CLI / Rust / Python / Swift / Kotlin /
  Ruby / wasm), useful if your stack mixes a Svelte client with a
  non-Svelte server.
- [Transpose chords by N semitones](transpose.md) — the
  transposition surface across bindings, for hosts that want to
  pre-compute transpositions outside Svelte.
- [`packages/svelte/README.md`](../../../packages/svelte/README.md)
  — the full API reference for `@chordsketch/svelte`: every prop,
  binding, snippet and helper signature in one table. The
  per-component reference pages in this guide's sidebar document
  `@chordsketch/react`, whose props differ where the frameworks
  differ; use the package README for Svelte rather than reading them
  across.
