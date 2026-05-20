# `<ChordProPreview>`

Preview pane with format toggle and transpose controls — no
source editor. The right surface for hosts that own the
ChordPro source elsewhere (a VS Code WebView fed by the active
editor, an external docs viewer, a saved-song reader) but want
the same in-pane chrome the playground exposes without
composing it by hand.

```tsx
import { ChordProPreview } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

<ChordProPreview source={"{title: My Song}\n[G]Hello [D]world"} />
```

> New in `@chordsketch/react` v0.3.0
> ([ADR-0022](../../adr/0022-react-as-canonical-preview-surface.md)).
> Tier 2 in the v0.3.0 layout: composed preview + controls, but
> no source editor. Pair with [`<ChordProEditor>`](#/reference/playground)
> for the full Tier 3 editor + preview shell, or compose the Tier 1
> atoms ([`<RendererPreview>`](#/reference/layout),
> [`<Transpose>`](#/reference/transpose)) directly for fully
> custom layouts.

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `source` | `string` | — | ChordPro source to render. Required. The host owns this value; `<ChordProPreview>` does not edit it. |
| `format` | `'html' \| 'text' \| 'pdf'` | — | Controlled preview format. Pair with `onFormatChange`. |
| `defaultFormat` | `'html' \| 'text' \| 'pdf'` | `'html'` | Initial preview format (uncontrolled). Ignored when `format` is supplied. |
| `onFormatChange` | `(next) => void` | — | Fires when the format `<select>` changes. |
| `formats` | `ReadonlyArray<'html' \| 'text' \| 'pdf'>` | `['html', 'text', 'pdf']` | Format options to include in the select. Host surfaces that do not ship the PDF wasm bundle should drop `'pdf'` so the user does not pick an unavailable format. |
| `transpose` | `number` | — | Controlled transposition offset. Pair with `onTransposeChange`. |
| `defaultTranspose` | `number` | `0` | Initial transposition offset (uncontrolled). Ignored when `transpose` is supplied. |
| `onTransposeChange` | `(next: number) => void` | — | Fires when the transpose control commits a new offset. |
| `transposeMin` | `number` | `-11` | Minimum transpose offset emitted by the control. |
| `transposeMax` | `number` | `11` | Maximum transpose offset emitted by the control. |
| `pdfFilename` | `string` | — | Filename for the PDF download when `format === 'pdf'`. Forwarded to `<RendererPreview>`. |
| `chordDiagramsInstrument` | `ChordDiagramInstrument` | — | Forwarded to the underlying [`<RendererPreview>`](#/reference/layout). |
| `loadingFallback` | `ReactNode` | — | Optional content rendered while the wasm runtime is initialising. |
| `errorFallback` | `((error: Error) => ReactNode) \| null` | — | Optional render prop that takes over when a parse or render error occurs. Pass `null` to suppress the error UI. |
| `wasmLoader` | loader callable | — | Test-only override for the inline (`html` / `text`) render paths. Production callers never need to supply this. |

Standard `HTMLAttributes<HTMLDivElement>` (e.g. `className`,
`style`, `id`) are forwarded to the wrapper. `children` and
`onChange` are omitted from the spread because both have
semantically loaded uses on `<ChordProPreview>` itself.

## Controlled vs uncontrolled

Each axis is independently controlled-or-uncontrolled: a host
can leave the format uncontrolled (`defaultFormat`) while
controlling the transpose offset (`transpose` + `onTransposeChange`),
or vice versa. Mixing the two for the same axis is a configuration
error and the controlled value wins.

## When to reach for `<ChordProPreview>`

Use `<ChordProPreview>` whenever the host application already
owns the ChordPro source — for example, when the active VS Code
editor's document is the source of truth, when a server-rendered
docs page passes the song body as a prop, or when the surrounding
application has its own preferred editor (CodeMirror, Monaco, a
custom RTE) and only needs the preview half. The component drops
the editor surface entirely, so the host wires the source from
wherever is natural and reaches for transpose / format controls
out of the box.

For the full editor + preview shell, reach for
[`<ChordProEditor>`](#/reference/playground) instead — that
component is the same Tier 3 composition the
[playground page](https://chordsketch.koeda.me/chordsketch/chordpro/)
mounts, with a built-in source editor on top of the same preview
chrome.
