# Embed ChordPro in your Vue app

`@chordsketch/vue` ships the same parser + renderer pipeline that
powers <https://chordsketch.koeda.me> as a published Vue 3 component
library. This page is the recipe collection for the most common
embedding scenarios; copy-paste into a fresh Vite + Vue 3 app (or
Nuxt, see [§Server-side rendering / Nuxt](#recipe-8-server-side-rendering-nuxt)
below) and it works.

It is the Vue counterpart of
[Embed ChordPro and iReal Pro in a React app](embed-react.md) —
the recipes below follow that page's order, and the two components
render the same output from the same engine. Where the Vue package
has no counterpart for a React recipe, that is called out in
[§What the Vue package does not cover](#what-the-vue-package-does-not-cover).

> **Prerequisite.** `npm install @chordsketch/vue vue`. Vue 3.3 or
> newer is a peer dependency. The PDF / PNG export bundle is a
> separate optional peer — see [§Export to PDF](#recipe-5-export-to-pdf)
> for when to install it.

Three conventions differ from the React package throughout, because
they are how Vue expresses the same ideas:

- **Render-prop fallbacks are slots.** React's `loadingFallback` /
  `errorFallback` / `notFoundFallback` props are the `loading` /
  `error` / `not-found` slots here.
- **Callbacks are `update:*` events.** `onChange` is
  `update:modelValue`, so the editor binds with `v-model`.
- **Composables take an options object** (React's hooks take
  positional arguments) and return refs. Every input accepts a plain
  value, a ref, or a getter, and the work re-runs when a reactive
  input changes.

## Recipe 1 — Drop in a ChordPro editor in 30 seconds

The fastest path. One component, no configuration, editor pane +
live preview:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { ChordTextarea } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';

const source = ref('{title: My Song}\n[G]Hello [D]world');
</script>

<template>
  <ChordTextarea v-model="source" />
</template>
```

`<ChordTextarea>` also runs uncontrolled: drop the `v-model`, pass
`default-value`, and the component keeps the text in its own state
while still emitting `update:modelValue` on every keystroke. The
preview re-renders a debounced copy of the source (`debounce-ms`,
default `250`), so typing never stalls on the renderer.

Bind `v-model:transpose` as well and `Ctrl`/`Cmd` + `ArrowUp` /
`ArrowDown` step the preview's transposition, clamped into
`[transposeMin, transposeMax]` (default `±11`). The shortcut only
intercepts the keystroke when that listener is bound, so hosts that
never asked for it keep the browser's own text navigation.

## Recipe 2 — Render a read-only chord sheet

For lyrics-and-chords display without any editing affordance:

```vue
<script setup lang="ts">
import { ChordSheet } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';

const source = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;
</script>

<template>
  <ChordSheet :source="source" :transpose="0" />
</template>
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

Parse and render errors reach the `error` slot rather than throwing,
and the previous successful output stays visible underneath, so a
half-typed edit never blanks the preview:

```vue
<template>
  <ChordSheet :source="source">
    <template #loading><p>Loading…</p></template>
    <template #error="{ error }"><p role="alert">{{ error.message }}</p></template>
  </ChordSheet>
</template>
```

Pass an empty `<template #error />` to suppress the inline fallback
entirely — the equivalent of React's `errorFallback={null}` — when
the host surfaces failures through a toast instead.

## Recipe 3 — Build a custom editor layout

`<ChordTextarea>` is the batteries-included split pane. When you want
your own pane layout, compose the pieces yourself: any editor
surface, `useDebounced` to keep the renderer off the keystroke path,
and `<ChordSheet>` for the preview.

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { ChordSheet, useDebounced } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';

const source = ref('{title: My Song}\n[G]Hello');
const debounced = useDebounced(source, 250);
</script>

<template>
  <div class="editor">
    <textarea v-model="source" aria-label="ChordPro editor" spellcheck="false" />
    <ChordSheet :source="debounced" />
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr 1fr;
}
@media (max-width: 767px) {
  .editor { grid-template-columns: 1fr; }
}
</style>
```

`useDebounced(value, delay)` returns a ref that follows `value` once
`delay` ms have passed without a change; `delay <= 0` passes the
input straight through, which is what tests usually want.

The Vue package deliberately stops at the plain `<textarea>` — the
syntax-highlighting CodeMirror surface and the split-layout
primitive are React-only (see
[§What the Vue package does not cover](#what-the-vue-package-does-not-cover)).
The public contract of `<ChordTextarea>` is only "a string value and
an `update:modelValue` event", so layering a richer editor on top is
a host-side choice that does not change any of the above.

## Recipe 4 — Add transposition controls

`<Transpose>` is a native `<select>` listing every semitone offset
between `min` and `max` — keyboard and screen-reader support come
from the browser's own control. Bind it with `v-model` and forward
the value to `<ChordSheet>`:

```vue
<script setup lang="ts">
import { ChordSheet, Transpose, useTranspose } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';

const source = '{title: Hello}\n[Am]hello [F]world';
const { value } = useTranspose();
</script>

<template>
  <Transpose v-model="value" />
  <ChordSheet :source="source" :transpose="value" />
</template>
```

The two defaults differ on purpose: `useTranspose()` clamps to the
feature limit `±11` (a full octave is the identity, so `±12` renders
the written chords), while the select offers the narrower `±6` that
is useful in practice. Pass `:min` / `:max` to `<Transpose>` to widen
the option list to whatever range the composable is clamping to.

`useTranspose()` also returns `increment` / `decrement` / `reset` /
`setValue` for hosts that build their own control (slider, number
input, keyboard shortcut). Every one of them clamps, and `reset()`
returns to the initial value — not necessarily zero.

## Recipe 5 — Export to PDF

PDF export ships in a separate heavy bundle so the lean
`@chordsketch/wasm` core stays small. Install the optional peer
alongside `@chordsketch/vue`:

```bash
npm install @chordsketch/wasm-export
```

Then drop in `<PdfExport>`:

```vue
<script setup lang="ts">
import { PdfExport } from '@chordsketch/vue';

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

<template>
  <PdfExport
    :source="source"
    filename="amazing-grace.pdf"
    @exported="onExported"
    @error="onError"
  >
    Export PDF
  </PdfExport>
</template>
```

The heavy bundle is **lazy-loaded** on first export — the initial
page load does not pay for it. The default slot is the button label
(default: `Export PDF`), attributes such as `class` / `id` /
`data-*` fall through to the `<button>`, and the `exported` /
`error` events are the Vue form of React's `onExported(filename)` /
`onError(err)` callbacks. A failed render also renders through the
`error` slot.

`usePdfExport()` returns the same `exportPdf` pipeline as state
(`{ exportPdf, loading, error }`) for custom UIs — dropdown items,
command palettes, and so on.

## Recipe 6 — Render chord diagrams

`<ChordDiagram>` looks up the chord in the built-in voicing database
and returns inline SVG that inherits `currentColor`:

```vue
<script setup lang="ts">
import { ChordDiagram } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';
</script>

<template>
  <ChordDiagram chord="Am" instrument="guitar" />
  <ChordDiagram chord="C" instrument="ukulele" />
  <ChordDiagram chord="Dm7" instrument="piano" />
</template>
```

An unknown chord is **not** an error: the lookup resolves to no
voicing and the `not-found` slot renders instead, receiving
`{ chord, instrument }` (default: an inline `role="note"` keeping
the chord name visible). The `error` slot is reserved for real
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
as refs:

```vue
<script setup lang="ts">
import { useChordRender } from '@chordsketch/vue';

const props = defineProps<{ source: string }>();
const { output, loading, error } = useChordRender(
  () => props.source,
  { format: 'text' },
);
</script>

<template>
  <article>
    <p v-if="error" role="alert">{{ error.message }}</p>
    <p v-else-if="loading && output === null">Loading…</p>
    <pre v-if="output !== null">{{ output }}</pre>
  </article>
</template>
```

`useChordRender` is what `<ChordSheet>` uses internally, so driving
it directly gives identical output you can place anywhere in your
tree. It resolves to a **string** — the rendered HTML fragment or
plain text — not to an AST. For AST-level custom rendering (React's
`useChordproAst` / `renderChordproAst`), call `parseChordpro` on
`@chordsketch/wasm` directly and walk the JSON yourself; the Vue
package has no composable around it.

## Recipe 8 — Server-side rendering / Nuxt

The components are safe to render on the server, but the sheet
itself is filled in on the client. Two things make that so: the
stylesheet injection no-ops when there is no `document`, and the
render awaits a dynamically imported `@chordsketch/wasm`, which
cannot resolve within a synchronous SSR pass. The server therefore
emits the component's wrapper (plus the `loading` slot, if you
supply one) and the client swaps in the rendered sheet once the
runtime is up — the same markup on both sides, so hydration is
clean.

```vue
<!-- pages/song/[id].vue -->
<script setup lang="ts">
import { ChordSheet } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';

const route = useRoute();
const { data: source } = await useFetch<string>(`/api/songs/${route.params.id}`);
</script>

<template>
  <ChordSheet :source="source ?? ''">
    <template #loading><p>Loading…</p></template>
  </ChordSheet>
</template>
```

Prefer rendering the preview on the client even for static content:
the browser's HTTP cache stores `chordsketch_wasm_bg.wasm` once and
reuses it across navigations, which a per-request server render
cannot do.

For pure server rendering (generating an OG image, emailing a PDF),
drive `@chordsketch/wasm` directly from a Nitro server route and
call `render_html_with_options` / `render_pdf` — the Vue components
are the wrong layer for non-Vue server rendering.

## What the Vue package does not cover

`@chordsketch/vue` covers the ChordPro surface. Three areas of
[`@chordsketch/react`](embed-react.md) have no Vue counterpart, by
design rather than by omission:

| React surface | Why there is no Vue equivalent |
|---|---|
| iReal Pro (`<IrealProEditor>`, `<IrealPreview>`, `useIrealParse`, …) | Not ported. Recipes 8 and 9 of the React page are React-only for now. |
| AST walker (`useChordproAst`, `renderChordproAst`) | `<ChordSheet format="html">` renders the engine's own HTML instead of walking the AST into a component tree, per [ADR-0017](../../adr/0017-react-renders-from-ast.md). See Recipe 7 for the AST-level escape hatch. |
| Interaction props built on that walker (in-preview chord selection, drag-to-reposition, chord audio) | They address React elements produced by the walker, which the Vue render path never creates. |

The CodeMirror source editor (`<ChordSourceArea>`) and the
`<SplitLayout>` / `<RendererPreview>` primitives are likewise
React-only; Recipe 3 shows the Vue way to build the same layout.

Everything else — preview, editor, transposition, chord diagrams,
PDF export — is present under the same prop names, defaults and DOM
class vocabulary as the React package, so a port between the two is
mechanical.

## See also

- [Embed ChordPro and iReal Pro in a React app](embed-react.md) —
  the React counterpart of this page, and the home of the iReal Pro
  recipes.
- [Embed ChordPro in a Svelte app](embed-svelte.md) — the same
  recipes for `@chordsketch/svelte`, whose rune-backed state helpers
  are the closest neighbour to the composables used here.
- [Render to HTML, plain text, or PDF](render.md) — same operation
  across every binding (CLI / Rust / Python / Swift / Kotlin /
  Ruby / wasm), useful if your stack mixes a Vue client with a
  non-Vue server.
- [Transpose chords by N semitones](transpose.md) — the
  transposition surface across bindings, for hosts that want to
  pre-compute transpositions outside Vue.
- [`packages/vue/README.md`](../../../packages/vue/README.md) — the
  full API reference for `@chordsketch/vue`: every prop, event, slot
  and composable signature in one table. The per-component reference
  pages in this guide's sidebar document `@chordsketch/react`, whose
  props differ where the frameworks differ; use the package README
  for Vue rather than reading them across.
