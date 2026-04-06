# @chordsketch/wasm

[ChordSketch](https://github.com/koedame/chordsketch) compiled to
WebAssembly — parse and render [ChordPro](https://www.chordpro.org/) files
in the browser or any JavaScript runtime with WASM support.

## Installation

```bash
npm install @chordsketch/wasm
```

## Usage

### Browser (ES module)

```js
import init, {
  render_html,
  render_text,
  render_pdf,
  version,
} from '@chordsketch/wasm';

// Initialize the WASM module first
await init();

const chordpro = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

// Render to HTML
const html = render_html(chordpro);

// Render to plain text
const text = render_text(chordpro);

// Render to PDF (returns Uint8Array)
const pdfBytes = render_pdf(chordpro);

// Check version
console.log(version()); // "0.1.0"
```

### Rendering with options

```js
import init, { render_html_with_options } from '@chordsketch/wasm';

await init();

const html = render_html_with_options(input, {
  transpose: 2,        // semitone offset (-12 to +12)
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

### Options

```ts
interface RenderOptions {
  transpose?: number;  // Semitone offset (-12 to +12), default 0
  config?: string;     // Preset name ("guitar", "ukulele") or inline RRJSON
}
```

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
