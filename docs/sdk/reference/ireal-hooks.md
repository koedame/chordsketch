# iReal Pro hooks

The hook surface backing the iReal Pro components. Use these when
the host builds its own UI on top of the wasm bridge — e.g. a
search box that matches against `composer`, a setlist filtered by
`key_signature.mode`, or a key-changer that edits `song.transpose`
and re-serialises.

## `useIrealParse`

```ts
function useIrealParse(source: string): UseIrealParseResult;
```

Parses an `irealb://` URL into a structured `IrealSong` AST.

| Field | Type | Description |
|---|---|---|
| `song` | `IrealSong \| null` | Parsed AST; `null` while loading or on error. |
| `loading` | `boolean` | True until the first parse completes. |
| `error` | `Error \| null` | Non-null when the parse failed. |

The hook re-parses every time `source` changes; wrap fast-edit
state with `useDebounced` to avoid pegging the wasm bridge on
keystroke storms.

## `useIrealSerialize`

```ts
function useIrealSerialize(song: IrealSong | null): UseIrealSerializeResult;
```

Round-trip serialises an `IrealSong` AST back to an `irealb://`
URL.

| Field | Type | Description |
|---|---|---|
| `url` | `string \| null` | Serialised URL; `null` when input is `null` or loading. |
| `loading` | `boolean` | True until the first serialise completes. |
| `error` | `Error \| null` | Non-null when serialisation rejected. |

`IrealSerializeLoader = () => Promise<IrealSerializer>` is the
shape consumed by an optional loader argument; production callers
do not pass it.

## `useIrealRender`

```ts
function useIrealRender(source: string): UseIrealRenderResult;
```

Lower-level render-to-SVG hook backing `<IrealPreview>`. Returns
`{ svg, loading, error }`. Prefer `<IrealPreview>` for the common
case; the hook is exposed for hosts that compose the SVG into a
larger document (e.g. a setlist PDF generator that wants the
charts as inline elements).

## AST types

Every type produced by `useIrealParse` is re-exported from the
package root:

```
IrealSong, IrealSection, IrealSectionLabel, IrealBar, IrealBarChord,
IrealBarChordKind, IrealBarLine, IrealChord, IrealChordRoot,
IrealChordQuality, IrealChordSize, IrealAccidental, IrealBeatPosition,
IrealKeySignature, IrealKeyMode, IrealTimeSignature, IrealMusicalSymbol
```

See [`ireal-ast.ts`](https://github.com/koedame/chordsketch/blob/main/packages/react/src/ireal-ast.ts)
for the field-level documentation.
