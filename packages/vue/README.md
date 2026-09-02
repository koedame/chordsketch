<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/vue

[![npm](https://img.shields.io/npm/v/@chordsketch/vue)](https://www.npmjs.com/package/@chordsketch/vue)

Vue 3 components for [ChordPro](https://www.chordpro.org/) — the plain-text format that writes chords above lyrics (`[C]Hello`) — powered by [ChordSketch](https://github.com/koedame/chordsketch)'s Rust engine compiled to WebAssembly. It ships a chord-sheet preview, a split-pane editor, chord diagrams, a transposition control and a PDF export button, plus the composables behind them, and lives on npm as `@chordsketch/vue`. It is the Vue counterpart of [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react); both render the same output from the same engine.

## Installation

```bash
npm install @chordsketch/vue vue
```

`vue` (3.3 or newer) is a peer dependency. `@chordsketch/wasm` comes along as a dependency; `<PdfExport>` additionally needs the heavier export bundle, which is an **optional** peer — install it only if you export PDFs:

```bash
npm install @chordsketch/wasm-export
```

The package ships one stylesheet — import it once at your app root (see Quick start).

## Quick start

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { ChordSheet, Transpose, useTranspose } from '@chordsketch/vue';
import '@chordsketch/vue/styles.css';

const source = ref(`{title: Silent Night}
{key: C}

[C]Silent night, [G7]holy [C]night`);

const { value: transpose } = useTranspose();
</script>

<template>
  <Transpose v-model="transpose" />
  <ChordSheet :source="source" :transpose="transpose" />
</template>
```

`<ChordSheet format="html">` renders the engine's chord-over-lyrics markup and injects the engine's own stylesheet, rewritten so every rule applies only inside `.chordsketch-sheet__content` — the component styles itself, and nothing leaks onto the surrounding page. Override the reading column with your own CSS if you want a different width:

```css
.chordsketch-sheet__content { max-width: none; }
```

## API

### Components

| Component | Props | Events | Slots |
|---|---|---|---|
| `<ChordSheet>` | `source` (required), `transpose`, `config`, `format` (`html` \| `text`, default `html`) | — | `loading`, `error` (`{ error }`) |
| `<ChordTextarea>` | `modelValue` / `defaultValue`, `transpose`, `config`, `previewFormat`, `readOnly`, `debounceMs` (default `250`), `placeholder`, `textareaAriaLabel`, `transposeMin` / `transposeMax` | `update:modelValue`, `update:transpose` | `loading`, `error` (forwarded to the preview) |
| `<ChordDiagram>` | `chord` (required), `instrument` (default `guitar`), `defines`, `orientation`, `compact` | — | `loading`, `not-found` (`{ chord, instrument }`), `error` (`{ error }`) |
| `<Transpose>` | `modelValue` (required), `min` (default `-6`), `max` (default `+6`), `step`, `label`, `formatValue` | `update:modelValue` | — |
| `<PdfExport>` | `source` (required), `filename`, `options`, `disabled` | `exported` (filename), `error` (Error) | default (label), `error` (`{ error }`) |

`<ChordSheet>` and `<ChordDiagram>` inject markup produced by the Rust renderer from a fixed template — no consumer HTML is ever injected.

### Composables

| Composable | Signature | Returns |
|---|---|---|
| `useChordRender` | `(source, options?) ` | `{ output, loading, error }` — refs; `options` takes `format` / `transpose` / `config` and may be a ref or getter |
| `useChordDiagram` | `(chord, options?)` | `{ svg, loading, error }` — refs; `options` takes `instrument` / `defines` / `orientation` / `compact` |
| `usePdfExport` | `()` | `{ exportPdf(source, filename, options?), loading, error }` |
| `useTranspose` | `(options?)` | `{ value, increment, decrement, reset, setValue }`; `options` takes `initial` / `min` / `max` (default `±11`) |
| `useDebounced` | `(value, delay)` | a ref that follows `value` once `delay` ms have passed without a change |
| `version` | `()` | the installed package version |

Every composable input accepts a plain value, a ref, or a getter, and the work re-runs when a reactive input changes. Unknown chords are not errors: `useChordDiagram` resolves `svg` to `null` and `<ChordDiagram>` renders its `not-found` slot.

## Options

`transpose` and `config` are forwarded to the renderer wherever they appear (`<ChordSheet>`, `<ChordTextarea>`, `<PdfExport options>`, `useChordRender`, `usePdfExport`):

| Option | Type | Meaning |
|---|---|---|
| `transpose` | `number` | Semitone offset, reduced modulo 12 by the renderer. Omitted or `0` renders the written chords. |
| `config` | `string` | Configuration preset name (`"guitar"`, `"ukulele"`, …) or an inline [RRJSON](https://www.chordpro.org/chordpro/chordpro-configuration/) configuration string. |

## Differences from `@chordsketch/react`

The component and prop names match [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react) wherever the two frameworks agree. Where they do not:

- **Render props become slots.** React's `loadingFallback` / `errorFallback` / `notFoundFallback` props are the `loading` / `error` / `not-found` slots here. Pass an empty `<template #error />` to suppress an inline fallback, which is what `errorFallback={null}` does in React.
- **Callbacks become events.** `onChange` is `update:modelValue` (so `<ChordTextarea>` binds with `v-model`), `onTransposeChange` is `update:transpose`, and `<PdfExport>`'s `onExported` / `onError` are the `exported` / `error` events.
- **Composables take an options object** instead of React's positional hook arguments, and return refs.
- **`<ChordSheet format="html">` renders the engine's HTML** (`render_html_body` plus the engine stylesheet), where the React package walks the AST into React elements. The output is the same chord-over-lyrics layout; the React-only interaction props built on that walker (in-preview chord selection, drag-to-reposition, chord audio) have no equivalent here.

## Links

- Repository: <https://github.com/koedame/chordsketch>
- Playground: <https://chordsketch.koeda.me>
- Documentation: <https://chordsketch.koeda.me/docs/>
- Issues: <https://github.com/koedame/chordsketch/issues>

## License

MIT
