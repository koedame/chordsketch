# @chordsketch/ui-irealb-editor

Bar-grid GUI editor for iReal Pro charts. Pluggable into
[`@chordsketch/ui-web`](../ui-web)'s `MountOptions.createEditor`
slot via the `EditorAdapter` contract.

This is a private workspace package; not published to npm.

## Status

First iteration (#2363):

- Header form: title, composer, style, key (root + accidental + mode),
  time signature (numerator / denominator), tempo, transpose.
- Bar grid: read-only display of each bar's chords joined by spaces,
  4 bars per line, with section labels.

Subsequent iterations:

- #2364 — bar popover for chord / barline / ending / musical symbol.
- #2365 — section management and bar add / remove / reorder.
- #2366 — `@chordsketch/ui-web` runtime swap + iRealb input toggle.
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
