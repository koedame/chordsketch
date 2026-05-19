# iReal Pro components

The iReal Pro surface mirrors the ChordPro surface in shape:
editor + preview + playground composite. All three components
consume the same wasm bridge under the hood; a parse error
inside the editor renders through `errorFallback` without
unmounting the surrounding tree.

## `<IrealPlayground>`

```tsx
import { IrealPlayground } from '@chordsketch/react';
import '@chordsketch/react/styles.css';

const URL =
  'irealb://Autumn%20Leaves%3D%5BT44Cm7%20%7C%20F7%20%7C%20BbMaj7%20%7C%20EbMaj7%20%5D%3DJoseph%20Kosma%3DJazz%20Ballad%3DC';

<IrealPlayground defaultValue={URL} />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `defaultValue` | `string` | sample chart | Initial uncontrolled `irealb://` URL. |
| `source` | `string` | — | Controlled URL. Pair with `onChange`. |
| `onChange` | `(url: string) => void` | — | Fires on every edit. |
| `readOnly` | `boolean` | `false` | Disables all form controls; the preview remains live. |
| `hideUrl` | `boolean` | `false` | Hide the URL textarea inside the editor pane. |
| `hideBars` | `boolean` | `false` | Hide the bar-grid editor inside the editor pane. |
| `hidePreview` | `boolean` | `false` | Hide the SVG preview pane. |
| `className`, `style` | — | — | Forwarded to the wrapper. |
| `errorFallback` | `ReactNode \| (err) => ReactNode \| null` | inline message | Renderer for parse / serialise errors. |
| `loader`, `previewLoader` | loader callables | — | Test-only overrides. |

## `<IrealEditor>`

The form-based editor surface used inside `<IrealPlayground>`.
Available standalone for hosts that want their own preview layout.

| Prop | Type | Description |
|---|---|---|
| `source` | `string` | Controlled URL value (no uncontrolled mode). |
| `onChange` | `(url: string) => void` | Fires on every edit. |
| `readOnly` | `boolean` | Force read-only display. |
| `showUrl` | `boolean` | Whether to show the raw-URL textarea. Defaults to `true`. |
| `showBars` | `boolean` | Whether to show the bar-grid editor. Defaults to `true`. |
| `promptSectionLabel` | `(current) => IrealSectionLabel \| null` | Override the prompt UX for adding / renaming sections. Defaults to `window.prompt`. |
| `confirmDeleteSection` | `(label) => boolean` | Override the confirm UX for deleting sections. Defaults to `window.confirm`. |
| `errorFallback` | `ReactNode \| (err) => ReactNode \| null` | Parse / serialise error renderer. |
| `className`, `style` | — | Forwarded to the wrapper. |
| `loader` | loader callable | Test-only override. |

## `<IrealPreview>`

SVG-only preview surface — narrow on purpose, mirrors the shape
of the SVG output the playground / desktop chart renderer
produces.

| Prop | Type | Description |
|---|---|---|
| `source` | `string` | `irealb://` URL to render. |
| `errorFallback` | `ReactNode \| (err) => ReactNode \| null` | Rendered on parse failure. |
| `className`, `style` | — | Forwarded to the wrapper. |
| `loader` | loader callable | Test-only override. |

`<IrealPreview>` does not embed pan / zoom controls; hosts wrap
it with their own viewport when needed.
