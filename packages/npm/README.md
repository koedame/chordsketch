<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/wasm

[ChordSketch](https://github.com/koedame/chordsketch) compiled to
WebAssembly — parse and render [ChordPro](https://www.chordpro.org/) files
in the browser **or** in Node.js with the same package.

## Installation

[![npm](https://img.shields.io/npm/v/@chordsketch/wasm)](https://www.npmjs.com/package/@chordsketch/wasm)

Replace `VERSION` with the current version from the badge above.

```bash
npm install '@chordsketch/wasm@VERSION'
```

## Usage

The package ships **two builds** under one name and uses Node's
conditional `exports` to pick the right one for the runtime:

| Runtime | Build | Init required? |
|---|---|---|
| Browser (Vite, webpack, native ESM) | `wasm-pack --target web` | Yes — `await init()` |
| Node.js (≥ 20) | `wasm-pack --target nodejs` | No — auto-loaded synchronously |

### Browser

```js
import init, {
  render_html,
  render_text,
  render_pdf,
  validate,
  version,
} from '@chordsketch/wasm';

// Browsers must initialize the WASM module first.
await init();

const chordpro = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

const errors = validate(chordpro); // [] if valid
const html = render_html(chordpro);
const text = render_text(chordpro);
const pdfBytes = render_pdf(chordpro); // Uint8Array
console.log(version());
```

### Node.js

```js
// No init() — the wasm-pack nodejs build auto-loads the .wasm file
// synchronously when the module is imported.
import {
  render_html,
  render_text,
  render_pdf,
  validate,
  version,
} from '@chordsketch/wasm';

const chordpro = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

const errors = validate(chordpro); // [] if valid
const html = render_html(chordpro);
const text = render_text(chordpro);
const pdfBytes = render_pdf(chordpro); // Uint8Array
console.log(version());
```

### Rendering with options (both runtimes)

```js
// Browser
import init, { render_html_with_options } from '@chordsketch/wasm';
await init();

// Node.js
import { render_html_with_options } from '@chordsketch/wasm';

const html = render_html_with_options(input, {
  transpose: 2,        // semitone offset (any integer; renderer reduces mod 12)
  config: 'ukulele',   // preset name or inline RRJSON config
});
```

## API

### Basic rendering

| Function | Input | Output |
|----------|-------|--------|
| `render_html(input)` | ChordPro string | HTML string |
| `render_text(input)` | ChordPro string | Plain text string |
| `render_pdf(input)` | ChordPro string | `Uint8Array` (PDF bytes) |

### Rendering with options

| Function | Input | Output |
|----------|-------|--------|
| `render_html_with_options(input, options)` | ChordPro string + options | HTML string |
| `render_text_with_options(input, options)` | ChordPro string + options | Plain text string |
| `render_pdf_with_options(input, options)` | ChordPro string + options | `Uint8Array` (PDF bytes) |

### iReal Pro conversion

| Function | Input | Output |
|----------|-------|--------|
| `convertChordProToIrealb(input)` | ChordPro source | `{ output: string, warnings: string[] }` — `output` is an `irealb://` URL |
| `convertIrealbToChordProText(input)` | `irealb://` URL | `{ output: string, warnings: string[] }` — `output` is rendered ChordPro text |

`convertChordProToIrealb` is lossy: lyrics, fonts / colours, and
capo are dropped because iReal has no surface for them. Each
drop appears in `warnings` as a `"<kind>: <message>"` string
(`kind` is `lossy-drop`, `approximated`, or `unsupported`).

`convertIrealbToChordProText` returns the
`chordsketch-render-text` rendering of the converted song, not
raw ChordPro source — there is no source emitter yet.

```js
import { convertChordProToIrealb, convertIrealbToChordProText } from '@chordsketch/wasm';

const { output: url, warnings } = convertChordProToIrealb('{title: Test}\n[C]Hello');
console.log(url);       // "irealb://..."
console.log(warnings);  // ["lossy-drop: lyrics are dropped", ...]

const { output: text } = convertIrealbToChordProText(url);
console.log(text);
```

### Options

```ts
interface RenderOptions {
  transpose?: number;  // Semitone offset (any integer in i8 range; renderer reduces mod 12), default 0
  config?: string;     // Preset name ("guitar", "ukulele") or inline RRJSON
}
```

### Validation

| Function | Input | Output |
|----------|-------|--------|
| `validate(input)` | ChordPro string | `ValidationError[]` — parse errors (empty if valid) |

Each `ValidationError` is `{line, column, message}` with one-based line
and column numbers. Matches the NAPI (`@chordsketch/node`) binding.

### Utility

| Function | Output |
|----------|--------|
| `version()` | Library version string |

## Building from source

```bash
# From the repository root
cd packages/npm && npm run build
```

## License

MIT
