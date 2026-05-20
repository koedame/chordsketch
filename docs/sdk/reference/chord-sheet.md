# `<ChordSheet>` + AST hooks

The render surface for a parsed ChordPro song. `<ChordSheet>` is
the flagship component; the underlying parse / render pipeline is
exposed via hooks for hosts that need their own UI.

## `<ChordSheet>`

```tsx
import { ChordSheet } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

<ChordSheet source={chordproSource} transpose={0} />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `source` | `string` | (required) | ChordPro source to render. |
| `transpose` | `number` | `0` | Semitone offset forwarded to the renderer. |
| `format` | `'html' \| 'text'` | `'html'` | `'html'` walks the AST into a React tree via `renderChordproAst`; `'text'` returns a `<pre>` block. |
| `chordDiagramsInstrument` | `'guitar' \| 'ukulele' \| 'piano' \| ...` | — | When set, append a chord-diagrams grid after the song. Honours `{diagrams: off}` / `{no_diagrams}`. HTML format only. |
| `activeSourceLine` | `number` | — | 1-indexed source line to highlight in the rendered output. Paired with `<ChordSourceArea>`'s `onCaretLineChange`. HTML format only. |
| `caretColumn` | `number` | — | 0-indexed caret column inside the active line. Paired with `caretLineLength` to position the inline caret marker. |
| `caretLineLength` | `number` | — | Total character length of the active source line. |
| `onChordReposition` | `(event: ChordRepositionEvent) => void` | — | Enables drag-and-drop chord repositioning. See [chord source-edit helpers](#/reference/chord-source-edit). |
| `config` | `string` | — | Configuration preset name or inline RRJSON forwarded to the renderer. |
| `loadingFallback` | `ReactNode` | minimal `role="status"` | Shown while wasm initialises. |
| `errorFallback` | `(error: Error) => ReactNode \| null` | inline `role="alert"` | Pass `null` to suppress and surface errors via your own channel. |
| `wasmLoader`, `astWasmLoader` | loader callables | dynamic import | Test-only overrides. |

Standard `HTMLAttributes<HTMLDivElement>` (e.g. `className`,
`style`, `id`) are forwarded to the wrapper element.

## `renderChordproAst`

```ts
function renderChordproAst(
  song: ChordproSong,
  options?: RenderChordproAstOptions,
): ReactNode;
```

The walker that powers `<ChordSheet>`'s `format="html"` branch.
Returns a React tree; identical output to placing
`<ChordSheet format="html" />` with the same source. Use directly
when you want to embed the rendered song inside a host React
tree without going through the `<ChordSheet>` shell — for
example, to wrap each rendered line in a host-specific tooltip
trigger.

## `useChordproAst`

```ts
function useChordproAst(
  source: string,
  options?: ChordproParseOptions,
): ChordproAstResult;
```

Returns `{ ast, warnings, loading, error, transposedKey }`. The
hook lazy-loads `@chordsketch/wasm` on first call and re-parses on
every source / option change. `ast` is the
[`ChordproSong`](https://github.com/koedame/chordsketch/blob/main/packages/react/src/chordpro-ast.ts)
JSON-shaped AST.

| Option | Type | Description |
|---|---|---|
| `transpose` | `number` | Semitone offset applied at parse time. |
| `config` | `string` | Renderer config preset name or inline RRJSON. |
| `wasmLoader` | loader callable | Test-only override. |

## `useChordRender`

```ts
function useChordRender(
  source: string,
  options?: ChordRenderOptions,
): ChordRenderResult;
```

Lower-level render-to-string hook backing `<ChordSheet>`. Returns
`{ html | text, loading, error, format }`. Prefer
`useChordproAst` + `renderChordproAst` for HTML output — the AST
walker avoids serialising through a string round-trip.

`ChordRenderFormat` is `'html' | 'text'`. The hook does not handle
PDF; use `usePdfExport` for that.

## `useDebounced`

```ts
function useDebounced<T>(value: T, delayMs: number): T;
```

Returns `value` after `delayMs` of stable input. Useful when wiring
a fast-edit textarea into a wasm-backed render — see
[Recipe 3 in the embedding guide](#/embed-react).

## AST types

`@chordsketch/react` re-exports every AST type from `chordpro-ast.ts`
so hosts can statically type the JSON they receive from
`useChordproAst`:

```
ChordproSong, ChordproMetadata, ChordproLine, ChordproDirective,
ChordproDirectiveKind, ChordproCommentStyle, ChordproLyricsLine,
ChordproLyricsSegment, ChordproTextSpan, ChordproSpanAttributes,
ChordproChord, ChordproChordDefinition, ChordproChordDetail,
ChordproChordQuality, ChordproNote, ChordproAccidental,
ChordproImageAttributes
```

See [`chordpro-ast.ts`](https://github.com/koedame/chordsketch/blob/main/packages/react/src/chordpro-ast.ts)
for the field-level documentation; the JSDoc comments there are
the source of truth.
