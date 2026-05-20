# @chordsketch/ui-irealb-editor

> ## ⚠️ Internal workspace package — not for external use
>
> This package is the bar-grid editor that powers the ChordSketch
> playground's `/irealpro/` route and the Tauri desktop app's iReal
> Pro view. It is intentionally `"private": true` and is **not
> published to npm**.
>
> **If you are building a third-party application** that embeds an
> iReal Pro editor or preview, use
> [`@chordsketch/react`](../react/)'s `<IrealEditor>` /
> `<IrealPreview>` / `<IrealPlayground>` components instead. Those
> components are published, follow semver, and present an idiomatic
> React surface; see
> [ADR-0020](../../docs/adr/0020-ireal-pro-react-surface.md) for
> the architectural split between this private editor and the
> public React surface.
>
> Reasons this package stays internal:
>
> - It is framework-agnostic DOM. External hosts embedding the
>   editor in a React app should not be forced to bridge a
>   non-React lifecycle into their tree —
>   [`@chordsketch/react`](../react/)'s `<IrealProEditor>` is the
>   canonical React-side host.
> - Its API is co-designed with the playground / desktop iteration
>   loop (popover-driven editing flow, `EditorAdapter` contract,
>   wasm bridge injection). Publishing it would lock those
>   choices behind semver.

Bar-grid GUI editor for iReal Pro charts. Exports a self-contained
`EditorAdapter` contract (TypeScript interface) that any host can
implement to embed a structured iReal Pro chart editor. Hosts
using [`@chordsketch/react`](../react/)'s `<IrealProEditor>` get
this integration for free; standalone hosts can consume the
adapter directly.

## Status

Shipped:

- #2363 — header form (title / composer / style / key + accidental +
  mode / time numerator + denominator / tempo / transpose) plus a
  4-bars-per-line grid of section + bar cells.
- #2364 — clicking a bar cell opens a modal popover (W3C APG dialog
  pattern: focus trap, Escape / outside-click dismissal) that edits
  every field of the underlying `Bar`: start / end barlines, chord
  rows (root + accidental + 12 named qualities + Custom string +
  optional `/X` bass + beat position 1 / 1.5 / … / 4.5, with
  add / remove / reorder), N-th ending number (0 = untitled
  bracket per spec `N0`, 1–9 = numbered bracket, empty = no
  bracket), and musical symbol (None / Segno / Coda / D.C. /
  D.S. / Fine).
- #2365 — structural editing via per-section + per-bar UI buttons:
  Add Section (with label prompt), Rename / Delete (with confirm) /
  Move up / Move down per section; Add Bar / Delete bar / Move bar
  left + right within each section. The two host hooks
  `promptSectionLabel` and `confirmDeleteSection` default to
  `window.prompt` / `window.confirm` and can be overridden by the
  host (or by tests).
- #2376 — bar-cell keyboard shortcuts (see "Keyboard shortcuts"
  below).

Subsequent iterations:

- #2366 — host-driven runtime swap + iRealb input toggle.
- #2367 — desktop integration (Open / Save dispatch + View menu).
- #2368 — keyboard navigation + ARIA grid semantics.

## Design

The editor is framework-agnostic: vanilla TypeScript + plain DOM.
The wasm bridge (`parseIrealb` / `serializeIrealb`) is **injected**
via the factory's `wasm` option rather than imported, so this
package has no runtime dependency on `@chordsketch/wasm` and the
test suite can supply a stub.

The host (playground / desktop / tests) wires the bridge once at
mount time:

```ts
import { parseIrealb, serializeIrealb } from '@chordsketch/wasm';
import { createIrealbEditor } from '@chordsketch/ui-irealb-editor';
import '@chordsketch/ui-irealb-editor/style.css';

const adapter = createIrealbEditor({
  initialValue: '',
  wasm: { parseIrealb, serializeIrealb },
});
root.appendChild(adapter.element);
adapter.onChange((url) => {
  // Persist or forward the updated `irealb://` URL.
});
```

## API

```ts
function createIrealbEditor(options: CreateIrealbEditorOptions): EditorAdapter;

interface CreateIrealbEditorOptions {
  initialValue: string;          // irealb:// URL; "" seeds an empty chart
  placeholder?: string;          // unused (parity with EditorFactoryOptions)
  wasm: IrealbWasm;              // injected parse / serialize
}

interface IrealbWasm {
  parseIrealb(input: string): string;     // URL  -> AST JSON
  serializeIrealb(input: string): string; // AST JSON -> URL
}
```

The `EditorAdapter` returned exposes a small, self-contained
contract: `getValue` / `setValue` / `onChange` / `destroy`, plus
`element` for DOM mounting. Hosts implement (or wrap) this
contract to embed the editor — the interface lives entirely in
this package and has no dependency on any other workspace
package.

## Keyboard shortcuts

Once a bar cell has keyboard focus (Tab into it, or click it), the
following shortcuts are active. Each one mirrors the equivalent
per-bar UI button so the keyboard path is a strict superset of the
mouse path — never a different operation.

| Shortcut                  | Action                                |
|---------------------------|---------------------------------------|
| `Delete` / `Backspace`    | Remove the bar (no confirmation)      |
| `Alt`+`ArrowLeft`         | Move the bar one position left        |
| `Alt`+`ArrowRight`        | Move the bar one position right       |

After a reorder, focus stays on the bar cell at its new position so
a repeated `Alt`+`ArrowLeft` keeps moving the same bar leftward
without re-grabbing focus. After a delete, focus moves to the
next-sibling bar cell — or to the section's "+ Add bar" trailer if
the section is now empty — so a keyboard user can keep working in
the same column.

Move shortcuts at the section boundary (`Alt`+`ArrowLeft` on the
first bar / `Alt`+`ArrowRight` on the last bar) are bounded no-ops:
they `preventDefault` (defence against any host-level handler that
treats the chord as history navigation) but do not mutate the AST.

Cross-section bar moves are not yet wired; drag-and-drop is the
planned path for that and is tracked under #2357. Section-level
shortcuts (move section, delete section) are also out of scope —
those operations remain reachable through the per-section UI
buttons.

## Tests

```sh
npm install
npm run typecheck
npm test
```

The vitest suite uses jsdom + a wasm stub. It does not require a
built `@chordsketch/wasm`.
