# @chordsketch/ui-irealb-editor

Bar-grid GUI editor for iReal Pro charts. Pluggable into
[`@chordsketch/ui-web`](../ui-web)'s `MountOptions.createEditor`
slot via the `EditorAdapter` contract.

This is a private workspace package; not published to npm.

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
  add / remove / reorder), N-th ending number (1–9, empty = none),
  and musical symbol (None / Segno / Coda / D.C. / D.S. / Fine).
- #2365 — structural editing via per-section + per-bar UI buttons:
  Add Section (with label prompt), Rename / Delete (with confirm) /
  Move up / Move down per section; Add Bar / Delete bar / Move bar
  left + right within each section. The two host hooks
  `promptSectionLabel` and `confirmDeleteSection` default to
  `window.prompt` / `window.confirm` and can be overridden by the
  host (or by tests).

Subsequent iterations:

- #2366 — `@chordsketch/ui-web` runtime swap + iRealb input toggle.
- #2367 — desktop integration (Open / Save dispatch + View menu).
- #2368 — keyboard navigation + ARIA grid semantics.
- #2376 — keyboard shortcuts for bar delete / reorder (deferred from
  #2365 so binding decisions stay deliberate).

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

mountChordSketchUi(root, {
  renderers,
  createEditor: (opts) =>
    createIrealbEditor({ ...opts, wasm: { parseIrealb, serializeIrealb } }),
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

The `EditorAdapter` returned matches the `@chordsketch/ui-web`
contract verbatim: `getValue` / `setValue` / `onChange` / `destroy`,
plus `element` for DOM mounting.

## Tests

```sh
npm install
npm run typecheck
npm test
```

The vitest suite uses jsdom + a wasm stub. It does not require a
built `@chordsketch/wasm`.
