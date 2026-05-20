# Editors

`@chordsketch/react` ships two source-editor atoms: a CodeMirror 6-backed
`<ChordSourceArea>` (preferred for non-trivial editing) and a
zero-dep `<ChordTextarea>` baseline (a textarea + preview pair).

> Renamed in `@chordsketch/react` v0.3.0
> ([ADR-0022](../../adr/0022-react-as-canonical-preview-surface.md)).
> `<SourceEditor>` is now `<ChordSourceArea>` and `<ChordEditor>` is
> now `<ChordTextarea>` — Tier 1 widget atoms use widget-type names,
> while the `Editor` suffix is reserved for Tier 3 composed editors
> (`<ChordProEditor>`, `<IrealProEditor>`).

## `<ChordSourceArea>`

```tsx
import { useRef, useState } from 'react';
import { ChordSourceArea, type ChordSourceAreaHandle } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const [source, setSource] = useState('{title: My Song}\n[G]Hello');
const editorRef = useRef<ChordSourceAreaHandle>(null);

<ChordSourceArea
  ref={editorRef}
  value={source}
  onChange={setSource}
  onCaretChange={(c) => console.log(`L${c.line} C${c.column}`)}
/>
```

| Prop | Type | Description |
|---|---|---|
| `value` | `string` | Controlled document contents. Pair with `onChange`. |
| `defaultValue` | `string` | Uncontrolled initial value. |
| `onChange` | `(value: string) => void` | Fires synchronously on every edit. |
| `onCaretLineChange` | `(line: number) => void` | Fires when the caret moves to a different line (1-indexed). |
| `onCaretChange` | `(c: { line; column; lineLength }) => void` | Fires on every caret movement. |
| `placeholder` | `string` | Empty-state placeholder. |
| `noLineNumbers` | `boolean` | Hide the gutter. |
| `noLineWrapping` | `boolean` | Disable soft-wrap. |

`ChordSourceAreaHandle` exposes imperative methods via `ref`:

| Method | Description |
|---|---|
| `focus()` | Move focus into the editor. |
| `getValue()` | Read the current document contents. |
| `setValue(next)` | Replace the document contents. |
| `insertAtCursor(text, selectInside?)` | Insert text at the current caret. When `selectInside` is true, the inserted text is selected (useful for snippet insertion). |

Standard `HTMLAttributes<HTMLDivElement>` (e.g. `className`, `id`)
are forwarded to the wrapper.

## `<ChordTextarea>`

Lighter-weight alternative: a textarea-backed editor that shares
the wasm-backed renderer with `<ChordSourceArea>`. Use when the host
already has its own syntax-highlighting infrastructure and only
needs a plain text input + the preview.

| Prop | Type | Description |
|---|---|---|
| `value` | `string` | Controlled value. |
| `defaultValue` | `string` | Uncontrolled initial value. |
| `onChange` | `(value: string) => void` | Fires on every edit. |
| `transpose` | `number` | Controlled transposition offset. |
| `onTransposeChange` | `(next: number) => void` | Fires on commit. |
| `config` | `string` | Renderer config preset or inline RRJSON. |
| `previewFormat` | `'html' \| 'text'` | Defaults to `'html'`. |
| `readOnly` | `boolean` | Disables editing; preview becomes the primary surface. |
| `debounceMs` | `number` | Delay before the preview re-renders. Defaults to `150`. |
| `placeholder` | `string` | Textarea placeholder. |
| `textareaAriaLabel` | `string` | Accessible name for the textarea. |
| `minTranspose` / `maxTranspose` | `number` | Bounds the keyboard shortcuts. Default `-11` / `11`. |
| `loadingFallback` | `ReactNode` | Shown while wasm initialises. |
| `errorFallback` | `(err) => ReactNode \| null` | Pass `null` to suppress and surface errors elsewhere. |
| `wasmLoader`, `astWasmLoader` | loader callables | Test-only overrides. |

## `chordProLanguage`, `chordProTagTable`

```ts
import { chordProLanguage, chordProTagTable } from '@chordsketch/react';
```

CodeMirror 6 language extension and the tag table used by
`<ChordSourceArea>` for ChordPro syntax highlighting. Re-exported so
hosts can build their own CodeMirror instance with the same
highlighter — e.g., to embed a ChordPro snippet inside a
larger CodeMirror editor.

`chordProTagTable` exposes the named tags (`atom`, `keyword`,
`punctuation`, `comment`) that the language emits; hosts can map
each tag to their own theme colours via CodeMirror's
`HighlightStyle.define([...])`.
