# `<PdfExport>` + `usePdfExport`

PDF export ships in a separate heavy bundle (`@chordsketch/wasm-export`,
~6 MB gzipped), behind the `@chordsketch/react/pdf` subpath — not the
package root. Import from there and install the optional peer
alongside `@chordsketch/react` if you intend to use PDF export:

```bash
npm install @chordsketch/wasm-export
```

The heavy bundle is **lazy-loaded** on first export — the initial
page load does not pay for it. Keeping the lazy `import()` behind a
separate entry point also means bundlers that resolve dynamic imports
at build time (webpack, Turbopack — notably Next.js) never require
the peer unless the app imports `@chordsketch/react/pdf`.

To wire PDF export into `<RendererPreview format="pdf">`,
`<PreviewToolbar>`, `<ChordProPreview>`, or `<ChordProEditor>`, pass
`<PdfExport>` through their `pdfExportComponent` prop — those
components no longer import it themselves.

## `<PdfExport>`

```tsx
import { PdfExport } from '@chordsketch/react/pdf';

<PdfExport source={chordproSource} filename="amazing-grace.pdf">
  Export PDF
</PdfExport>
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `source` | `string` | (required) | ChordPro source to render. |
| `filename` | `string` | `"chordsketch-output.pdf"` | Filename for the download. |
| `options` | `PdfExportOptions` | — | `{ transpose?, config? }` forwarded to the renderer. |
| `children` | `ReactNode` | `PDF_EXPORT_DEFAULT_LABEL` (`"Export PDF"`) | Button label. Re-import the named constant to keep sister components (e.g. `<PreviewToolbar>`) in lockstep. |
| `onExported` | `(filename: string) => void` | — | Fires after the download has been initiated. |
| `onError` | `(error: Error) => void` | — | Fires when the underlying call rejects. |
| `wasmLoader` | loader callable | dynamic import | Test-only override. |

`<PdfExport>` extends every standard `<button>` attribute
(`className`, `style`, `type`, `disabled`, …) so it composes with
any host button styling.

## `usePdfExport`

```ts
function usePdfExport(): UsePdfExportResult;
```

Returns the same export pipeline as state for custom UIs
(dropdown items, command-palette entries, keyboard shortcuts).

| Field | Type | Description |
|---|---|---|
| `exportPdf` | `(source: string, filename: string, options?: PdfExportOptions) => Promise<void>` | Run an export. Returns when the download has been initiated. |
| `loading` | `boolean` | True while the heavy bundle is loading or a render is in flight. |
| `error` | `Error \| null` | Non-null when the latest call rejected. |

The heavy bundle is fetched only on the first `exportPdf` call;
subsequent calls reuse the already-loaded module. The browser's
HTTP cache stores the bundle across navigations.
