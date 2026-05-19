# Chord source-edit helpers

Primitives for drag-to-reposition chord editing inside the rendered
preview. `<ChordSheet>` / `<RendererPreview>` / `renderChordproAst`
emit `ChordRepositionEvent` values through their `onChordReposition`
callback; consumers feed them through `applyChordReposition` to
compute the updated ChordPro source.

## `applyChordReposition`

```ts
function applyChordReposition(
  source: string,
  event: ChordRepositionEvent,
): ChordRepositionResult;
```

Returns `{ nextSource, ok }`. `ok` is `false` when the event refers
to a chord position that no longer matches the source (e.g. the
host's debounced state lagged behind a fast edit); `nextSource`
is unchanged on failure.

```tsx
import { ChordSheet, applyChordReposition } from '@chordsketch/react';

<ChordSheet
  source={source}
  onChordReposition={(event) => {
    const { nextSource, ok } = applyChordReposition(source, event);
    if (ok) setSource(nextSource);
  }}
/>
```

## `lyricsOffsetToSourceColumn`

```ts
function lyricsOffsetToSourceColumn(line: string, lyricsOffset: number): number;
```

Helper used by `applyChordReposition` internally; exported for
hosts that build their own drop handlers (e.g. a touch-aware
gesture layer). Maps a 0-indexed offset in the rendered lyrics
string to the 0-indexed column in the ChordPro source line.

## `ChordRepositionEvent`

```ts
interface ChordRepositionEvent {
  /** 1-indexed source line carrying the chord that is being moved. */
  fromLine: number;
  /** 0-indexed source column where the chord currently lives. */
  fromColumn: number;
  /** 0-indexed offset in the rendered lyrics where the chord was dropped. */
  toLyricsOffset: number;
  /** The chord string itself, including brackets (e.g. `"[G]"`, `"[D/F#]"`). */
  chord: string;
}
```

The event shape is intentionally narrow — it describes a single
chord move on a single line. Cross-line moves are not supported
today (file an issue if your host needs them).
