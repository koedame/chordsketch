# `<ChordProEditor>`

The fastest path to embedding a ChordPro editor — one component
with editor + preview + transpose + PDF export. Mounts the same
chrome as
[`https://chordsketch.koeda.me/chordsketch/chordpro/`](https://chordsketch.koeda.me/chordsketch/chordpro/).

```tsx
import { ChordProEditor } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

<ChordProEditor defaultSource={"{title: My Song}\n[G]Hello [D]world"} />
```

> Renamed from `<Playground>` in `@chordsketch/react` v0.3.0
> ([ADR-0022](../../adr/0022-react-as-canonical-preview-surface.md)).
> The `Editor` suffix denotes a Tier 3 composed editor (source +
> preview + chrome) in the v0.3.0 layout.

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `defaultSource` | `string` | `""` | Initial uncontrolled source (empty document by default). Ignored when `source` is set. |
| `source` | `string` | — | Controlled source value. Pair with `onSourceChange`. |
| `onSourceChange` | `(next: string) => void` | — | Fires synchronously on every edit. |
| `defaultFormat` | `'html' \| 'text' \| 'pdf'` | `'html'` | Initial preview format (uncontrolled). |
| `format` | `'html' \| 'text' \| 'pdf'` | — | Controlled preview format. Pair with `onFormatChange`. |
| `onFormatChange` | `(next) => void` | — | Fires when the format toggle changes. |
| `defaultTranspose` | `number` | `0` | Initial transposition offset (uncontrolled). |
| `transpose` | `number` | — | Controlled transposition offset. Pair with `onTransposeChange`. |
| `onTransposeChange` | `(next: number) => void` | — | Fires when the user commits a new offset. |
| `title` | `string \| null` | `"ChordSketch"` | Heading shown in the header bar. Pass `null` or `""` to omit the heading entirely. |
| `pdfFilename` | `string` | `"chordsketch-output.pdf"` | Filename for the PDF download. |
| `headerExtras` | `ReactNode` | — | Slot for host-supplied controls in the header bar (e.g. a "Save to library" button). |
| `wasmLoader` | loader callable | — | Test-only override. |

Standard `HTMLAttributes<HTMLDivElement>` (e.g. `className`,
`style`, `id`) are forwarded to the wrapper. `onChange` and
`title` are omitted from the spread because both have
semantically loaded uses on `<ChordProEditor>` itself.

## Controlled vs uncontrolled

Each axis is independently controlled-or-uncontrolled: a host
can leave the source uncontrolled (`defaultSource`) while
controlling the format (`format` + `onFormatChange`), or
vice versa. The component falls back to a sensible default if
both `source` and `defaultSource` are omitted.
