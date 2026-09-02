<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/svelte

[![npm](https://img.shields.io/npm/v/@chordsketch/svelte)](https://www.npmjs.com/package/@chordsketch/svelte)

Svelte 5 components for [ChordPro](https://www.chordpro.org/) — the plain-text format that writes chords above lyrics (`[C]Hello`) — powered by [ChordSketch](https://github.com/koedame/chordsketch)'s Rust engine compiled to WebAssembly. It ships a chord-sheet preview, a split-pane editor, chord diagrams, a transposition control and a PDF export button, plus the rune-backed state helpers behind them, and lives on npm as `@chordsketch/svelte`. It is the Svelte counterpart of [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react) and [`@chordsketch/vue`](https://www.npmjs.com/package/@chordsketch/vue); all three render the same output from the same engine.

## Installation

```bash
npm install @chordsketch/svelte svelte
```

`svelte` (5.0 or newer) is a peer dependency — the components are written with runes and are not compatible with Svelte 4. `@chordsketch/wasm` comes along as a dependency; `<PdfExport>` additionally needs the heavier export bundle, which is an **optional** peer — install it only if you export PDFs:

```bash
npm install @chordsketch/wasm-export
```

The package ships uncompiled `.svelte` sources (the Svelte convention), so your bundler compiles them with your app. It also ships one stylesheet — import it once at your app root (see Quick start).

## Quick start

```svelte
<script lang="ts">
  import { ChordSheet, Transpose, useTranspose } from '@chordsketch/svelte';
  import '@chordsketch/svelte/styles.css';

  let source = $state(`{title: Silent Night}
{key: C}

[C]Silent night, [G7]holy [C]night`);

  const transpose = useTranspose();
</script>

<Transpose bind:value={transpose.value} />
<ChordSheet {source} transpose={transpose.value} />
```

`<ChordSheet format="html">` renders the engine's chord-over-lyrics markup and injects the engine's own stylesheet, rewritten so every rule applies only inside `.chordsketch-sheet__content` — the component styles itself, and nothing leaks onto the surrounding page. Override the reading column with your own CSS if you want a different width:

```css
.chordsketch-sheet__content { max-width: none; }
```

## API

### Components

| Component | Props | Bindable | Snippets |
|---|---|---|---|
| `<ChordSheet>` | `source` (required), `transpose`, `config`, `format` (`html` \| `text`, default `html`) | — | `loading`, `error` (the `Error`) |
| `<ChordTextarea>` | `value`, `transpose`, `config`, `previewFormat`, `readOnly`, `debounceMs` (default `250`), `placeholder`, `textareaAriaLabel`, `transposeMin` / `transposeMax` | `value`, `transpose` | `loading`, `error` (forwarded to the preview) |
| `<ChordDiagram>` | `chord` (required), `instrument` (default `guitar`), `defines`, `orientation`, `compact` | — | `loading`, `notFound` (`{ chord, instrument }`), `error` (the `Error`) |
| `<Transpose>` | `value`, `min` (default `-6`), `max` (default `+6`), `step`, `label`, `formatValue` | `value` | — |
| `<PdfExport>` | `source` (required), `filename`, `options`, `disabled`, `onExported`, `onError` | — | `children` (label), `error` (the `Error`) |

Every component forwards unrecognised attributes (`id`, `class`, `data-*`, `aria-*`) to its root element — the button, for `<PdfExport>`.

`<ChordSheet>` and `<ChordDiagram>` inject markup produced by the Rust renderer from a fixed template — no consumer HTML is ever injected.

### State helpers

The helpers are plain functions backed by runes, not Svelte `use:` actions. Reactive inputs are passed as getters (`() => source`), because reading a `$state` variable at the call site would capture one snapshot; a value that never changes can be passed directly.

| Helper | Signature | Returns |
|---|---|---|
| `useChordRender` | `(source, options?)` | `{ output, loading, error }`; `options` takes `format` / `transpose` / `config` |
| `useChordDiagram` | `(chord, options?)` | `{ svg, loading, error }`; `options` takes `instrument` / `defines` / `orientation` / `compact` |
| `usePdfExport` | `()` | `{ exportPdf(source, filename, options?), loading, error }` |
| `useTranspose` | `(options?)` | `{ value, increment, decrement, reset, setValue }`; `options` takes `initial` / `min` / `max` (default `±11`) |
| `useDebounced` | `(value, delay)` | `{ current }` — follows `value` once `delay` ms have passed without a change |
| `version` | `()` | the installed package version |

`useChordRender`, `useChordDiagram` and `useDebounced` register an `$effect`, so call them during component initialisation (or inside an `$effect.root`). `useTranspose` and `usePdfExport` register none and can be called anywhere.

Unknown chords are not errors: `useChordDiagram` resolves `svg` to `null` and `<ChordDiagram>` renders its `notFound` snippet.

## Options

`transpose` and `config` are forwarded to the renderer wherever they appear (`<ChordSheet>`, `<ChordTextarea>`, `<PdfExport options>`, `useChordRender`, `usePdfExport`):

| Option | Type | Meaning |
|---|---|---|
| `transpose` | `number` | Semitone offset, reduced modulo 12 by the renderer. Omitted or `0` renders the written chords. |
| `config` | `string` | Configuration preset name (`"guitar"`, `"ukulele"`, …) or an inline [RRJSON](https://www.chordpro.org/chordpro/chordpro-configuration/) configuration string. |

## Differences from `@chordsketch/react`

The component and prop names match [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react) wherever the two frameworks agree. Where they do not:

- **Render props become snippets.** React's `loadingFallback` / `errorFallback` / `notFoundFallback` props are the `loading` / `error` / `notFound` snippets here. Pass an empty snippet (`{#snippet error(_e)}{/snippet}`) to suppress an inline fallback, which is what `errorFallback={null}` does in React.
- **Value callbacks become bindings.** React's `value` + `onChange` pair is a single `bind:value`, and `onTransposeChange` is `bind:transpose`. There is no controlled / uncontrolled split: bind the prop to own the value, or leave it unbound and the component keeps its own.
- **Event callbacks stay callbacks.** `<PdfExport>`'s `onExported` / `onError` are props, as in React.
- **Helpers take getters and return objects with reactive properties**, rather than React's positional hook arguments and tuple returns.
- **`<ChordSheet format="html">` renders the engine's HTML** (`render_html_body` plus the engine stylesheet), where the React package walks the AST into React elements. The output is the same chord-over-lyrics layout; the React-only interaction props built on that walker (in-preview chord selection, drag-to-reposition, chord audio) have no equivalent here.
- **`<ChordTextarea>`'s transpose shortcut always intercepts `Ctrl`/`Cmd`+`ArrowUp`/`ArrowDown`.** React only calls `preventDefault()` when `onTransposeChange` is supplied, and Vue only when `v-model:transpose` is bound, so an uninterested host keeps the browser's own paragraph-navigation shortcut (notably in Firefox). Svelte's `$bindable` gives the child no way to detect whether `bind:transpose` was used, so this component cannot replicate that opt-out — the shortcut always fires, whether or not you bind `transpose`.

## Links

- Repository: <https://github.com/koedame/chordsketch>
- Playground: <https://chordsketch.koeda.me>
- Documentation: <https://chordsketch.koeda.me/docs/>
- Issues: <https://github.com/koedame/chordsketch/issues>

## License

MIT
