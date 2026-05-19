# Layout primitives

Composition helpers for building custom editor / preview shells.
`<Playground>` uses these internally; reach for them directly when
you need a different chrome.

## `<SplitLayout>`

```tsx
import { SplitLayout, SourceEditor, RendererPreview } from '@chordsketch/react';

<SplitLayout
  start={<SourceEditor value={source} onChange={setSource} />}
  end={<RendererPreview source={source} format="html" />}
/>
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `start` | `ReactNode` | (required) | Content rendered in the left (or top, on narrow viewports) pane. |
| `end` | `ReactNode` | (required) | Content rendered in the right (or bottom) pane. |
| `defaultRatio` | `number` | `0.5` | Initial split ratio (0..1). Uncontrolled. |
| `ratio` | `number` | — | Controlled ratio. Pair with `onRatioChange`. |
| `onRatioChange` | `(next: number) => void` | — | Fires after a drag commits. |
| `splitterLabel` | `string` | `"Resize panes"` | Accessible name for the splitter handle. |
| `stackBelow` | `number` | `768` | Pixel viewport width below which panes stack vertically. |

The split ratio is exposed as a `--cs-split-ratio` CSS variable so
hosts can apply additional rules (e.g. `display: grid` with a
ratio-dependent layout).

## `<RendererPreview>`

```tsx
import { RendererPreview } from '@chordsketch/react';

<RendererPreview source={source} format="html" />
```

| Prop | Type | Description |
|---|---|---|
| `source` | `string` | ChordPro source. |
| `format` | `'html' \| 'text' \| 'pdf'` | Output format. `'pdf'` switches to a download-button surface backed by `<PdfExport>`. |
| `transpose` | `number` | Semitone offset. |
| `config` | `string` | Renderer config preset name or inline RRJSON. |
| `pdfFilename` | `string` | Filename for the PDF download (PDF format only). Defaults to `"chordsketch-output.pdf"`. |
| `chordDiagramsInstrument` | `'guitar' \| ...` | See [`<ChordSheet>`](#/reference/chord-sheet). |
| `activeSourceLine`, `caretColumn`, `caretLineLength` | numbers | Caret-tracking for editor/preview sync. |
| `onChordReposition` | callback | Drag-to-reposition support. See [chord source-edit helpers](#/reference/chord-source-edit). |
| `loadingFallback` | `ReactNode` | Shown while wasm initialises. |
| `errorFallback` | `(err) => ReactNode \| null` | Pass `null` to suppress. |
| `wasmLoader` | loader callable | Test-only override. |

Standard `HTMLAttributes<HTMLDivElement>` are forwarded to the
wrapper. The `PreviewFormat` type (`'html' \| 'text' \| 'pdf'`)
is exported so hosts can type their own format-toggle state.
