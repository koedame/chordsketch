# `<ChordDiagram>` + `useChordDiagram`

Inline chord-voicing SVG renderer. Looks up the chord in the
built-in voicing database (60 guitar + 36 ukulele + 60 piano
voicings) and returns SVG that inherits `currentColor`, so it
themes cleanly inside any host.

## `<ChordDiagram>`

```tsx
import { ChordDiagram } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

<ChordDiagram chord="Am" instrument="guitar" />
<ChordDiagram chord="C" instrument="ukulele" />
<ChordDiagram chord="Dm7" instrument="piano" />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `chord` | `string` | (required) | Chord name (e.g. `"Am"`, `"C#m7"`, `"Bb"`). |
| `instrument` | `'guitar' \| 'ukulele' \| 'piano' \| ...` | `'guitar'` | Instrument family. See `ChordDiagramInstrument`. |
| `defines` | `ReadonlyArray<readonly [name, raw]>` | — | Optional song-level `{define}` voicings to consult before falling back to the built-in database. Format mirrors `chordsketch_chordpro::voicings::lookup_diagram`. |
| `loadingFallback` | `ReactNode` | `role="status"` placeholder | Shown while wasm loads. |
| `notFoundFallback` | `(chord, instrument) => ReactNode \| ReactNode` | inline `role="note"` | Rendered when the chord is unknown. |
| `errorFallback` | `(error: Error) => ReactNode \| null` | inline `role="alert"` | Pass `null` to suppress. |
| `wasmLoader` | loader callable | dynamic import | Test-only override. |

Standard `HTMLAttributes<HTMLDivElement>` are forwarded to the
wrapper.

## `useChordDiagram`

```ts
function useChordDiagram(
  chord: string,
  instrument: ChordDiagramInstrument,
  wasmLoader?: ChordDiagramWasmLoader,
  defines?: ReadonlyArray<readonly [string, string]>,
): ChordDiagramResult;
```

Returns:

| Field | Type | Description |
|---|---|---|
| `svg` | `string \| null` | Inline SVG string when a voicing is found; `null` otherwise. |
| `loading` | `boolean` | True until the first resolution completes. |
| `error` | `Error \| null` | Non-null when the underlying call rejected. |
| `notFound` | `boolean` | True when the voicing database has no entry. |

Use the hook directly when the host needs the raw SVG (to embed
it in a tooltip body, a popover, or a custom container).

`ChordDiagramInstrument` is re-exported from `use-chord-diagram.ts`
and covers every instrument the underlying Rust voicing database
recognises.
