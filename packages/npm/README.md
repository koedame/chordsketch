<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/wasm

[ChordSketch](https://github.com/koedame/chordsketch) compiled to
WebAssembly — parse and render [ChordPro](https://www.chordpro.org/) and
[iReal Pro](https://www.irealpro.com/) chord charts in the browser **or**
in Node.js with the same package.

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
console.log(version());
```

### Node.js

```js
// No init() — the wasm-pack nodejs build auto-loads the .wasm file
// synchronously when the module is imported.
import {
  render_html,
  render_text,
  validate,
  version,
} from '@chordsketch/wasm';

const chordpro = `{title: Amazing Grace}
{key: G}

[G]Amazing [G7]grace, how [C]sweet the [G]sound`;

const errors = validate(chordpro); // [] if valid
const html = render_html(chordpro);
const text = render_text(chordpro);
console.log(version());
```

### PDF / PNG export (separate package)

PDF (`render_pdf`) and iReal Pro PNG / PDF (`renderIrealPng` /
`renderIrealPdf`) live in the sister package
[`@chordsketch/wasm-export`](https://www.npmjs.com/package/@chordsketch/wasm-export).
It bundles the same lean API plus the resvg / svg2pdf / fontdb
transitive dependency tree required for rasterisation and PDF
emission, so it weighs ~25× more than this package (~10 MB raw vs
~400 KB). Install it on the side and dynamic-import it only when
the user actually triggers an export:

```js
const { default: initExport, render_pdf } = await import('@chordsketch/wasm-export');
await initExport(); // browser only — Node auto-loads via wasm-pack --target nodejs
const pdfBytes = render_pdf(chordpro); // Uint8Array
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

For `render_pdf` (ChordPro → PDF) use `@chordsketch/wasm-export`.

### Rendering with options

| Function | Input | Output |
|----------|-------|--------|
| `render_html_with_options(input, options)` | ChordPro string + options | HTML string |
| `render_text_with_options(input, options)` | ChordPro string + options | Plain text string |

For `render_pdf_with_options` use `@chordsketch/wasm-export`.

### iReal Pro conversion

| Function | Input | Output |
|----------|-------|--------|
| `convertChordproToIrealb(input)` | ChordPro source | `{ output: string, warnings: string[] }` — `output` is an `irealb://` URL |
| `convertIrealbToChordproText(input)` | `irealb://` URL | `{ output: string, warnings: string[] }` — `output` is rendered ChordPro text |
| `renderIrealSvg(input)` | `irealb://` URL | `string` — full SVG document (iReal Pro-style chart) |
| `parseIrealb(input)` | `irealb://` URL or `irealbook://` URL | `string` — AST-shaped JSON mirroring `IrealSong`. Accepts both the canonical 7..=9-field `irealb://` shape and the iRealBook 6-field `irealbook://` shape (`Title=Composer=Style=Key=TimeSig=Music`). |
| (iReal PNG / PDF rendering moved to `@chordsketch/wasm-export`) | | |
| `serializeIrealb(input)` | AST-shaped JSON | `string` — `irealb://` URL (round-trips with `parseIrealb`) |
| `chordTypography(chordJson)` | AST-shaped chord JSON (`{root, quality, bass, alternate?}`) | `string` — JSON `{spans: [{kind, text}, ...]}` matching the iReal Pro engraved-chart convention. The renderer emits `Root` + `Accidental` + `Extension` + `Slash` + `Bass` span kinds; URL-stored quality shorthand (`b`/`#`/`^`/`h`/`o`/`-`) translates to typeset glyphs (`♭`/`♯`/`Δ`/`ø`/`°`/`−`); two-or-more-alteration extensions stack vertically via a `\|` separator (`7♭9♯5` → `7♭9\|♯5`). |

`convertChordproToIrealb` is lossy: lyrics, fonts / colours, and
capo are dropped because iReal has no surface for them. Each
drop appears in `warnings` as a `"<kind>: <message>"` string
(`kind` is `lossy-drop`, `approximated`, or `unsupported`).

`convertIrealbToChordproText` returns the
`chordsketch-render-text` rendering of the converted song, not
raw ChordPro source — there is no source emitter yet.

```js
import { convertChordproToIrealb, convertIrealbToChordproText } from '@chordsketch/wasm';

const { output: url, warnings } = convertChordproToIrealb('{title: Test}\n[C]Hello');
console.log(url);       // "irealb://..."
console.log(warnings);  // ["lossy-drop: lyrics are dropped", ...]

const { output: text } = convertIrealbToChordproText(url);
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

### Chord diagrams

| Function | Returns | Description |
|----------|---------|-------------|
| `chord_diagram_svg(chord, instrument)` | `string \| null` (SVG markup) | Render a chord diagram as inline SVG. `instrument` is case-insensitive: `"guitar"`, `"ukulele"` (alias `"uke"`), or `"piano"` (aliases `"keyboard"`, `"keys"`). Returns `null` when the chord is not in the built-in voicing database; throws on unknown instrument. Exported without a `js_name` rename, so it keeps its snake\_case Rust name (like `render_html` / `render_text`) rather than the camelCase used by every other function in this table. |
| `chordDiagramSvgWithDefines(chord, instrument, defines)` | `string \| null` | Like `chord_diagram_svg` but consults song-level `{define}` voicings first. `defines` is an array of `[name, raw]` tuples (e.g. `[["Gsus4", "base-fret 1 frets 3 3 0 0 1 3"]]`). |
| `chordDiagramSvgWithOrientation(chord, instrument, orientation?)` | `string \| null` | Orientation-aware variant. `orientation` (exported as the `ChordDiagramOrientation` type): `"vertical"` (default) or `"horizontal"` (nut on the left, Japanese tablature convention). Horizontal mode is reader-view only (high pitch on top, matches tablature stave order); see ADR-0026. `null` / `undefined` / unrecognised strings fall back to vertical. |
| `chordDiagramSvgWithDefinesOrientation(chord, instrument, defines, orientation?)` | `string \| null` | Combined surface — accepts both song-level `{define}` voicings and the orientation knob. |
| `chordDiagramSvgWithDefinesOrientationCompact(chord, instrument, defines, orientation?)` | `string \| null` | Compact-size counterpart of `chordDiagramSvgWithDefinesOrientation` — renders the smaller above-a-lyric layout used for `{diagrams: inline}` / `{diagrams: hover}`, honouring the same `{define}` voicings and orientation knob. The returned SVG carries an extra `chord-diagram-compact` (or `keyboard-diagram-compact`) class on its root element. |
| `chordPitches(chord)` | `Uint8Array \| undefined` | Constituent pitches of a chord as MIDI note numbers, for driving an audio synth. Returns a block voicing (root, third, fifth, plus any extension / altered / added tones, with a slash bass an octave below the root); `undefined` when the chord is not parseable. |
| `diagramPitches(chord, instrument, defines)` | `Uint8Array \| undefined` | MIDI note numbers **sounded** by the chord diagram drawn for `(chord, instrument)` — for auditioning a diagram as exactly the shape it depicts, rather than the name-based block voicing `chordPitches` returns. Fretted instruments return one pitch per non-muted string in string order; keyboard instruments return the highlighted keys. `defines` is the same `[name, raw]` tuple list `chordDiagramSvgWithDefines` accepts. `undefined` when no diagram is available. Throws when `defines` is malformed. |
| `chordStaffNotes(chord)` | `StaffNote[] \| undefined` (`{letter, accidental, octave, midi}`) | Constituent tones of a chord spelled for staff notation, ascending by pitch (a slash bass sorts first). Each tone is spelled diatonically from the chord's structure so it lands on its conventional staff line (e.g. `Ebm7` → E♭ G♭ B♭ D♭, not D♯ F♯ A♯ C♯). `undefined` when the chord is not parseable. |
| `keyScalePitches(key)` | `Uint8Array \| undefined` | Ascending one-octave scale of a musical key as MIDI note numbers — the movable-do "do re mi fa sol la ti do". Major keys yield the major scale; minor keys the natural-minor scale. Eight bytes; `undefined` when the key is not parseable. |
| `keyTonicTriad(key)` | `Uint8Array \| undefined` | Tonic triad of a musical key as MIDI note numbers (the "do mi sol" chord). Major / minor per the key; extensions on the spelling are ignored. Three bytes; `undefined` when the key is not parseable. |
| `listDirectives()` | `DirectiveInfo[]` (`{name, aliases, valueKind, values, summary}`) | Return the ChordPro directive catalog (ADR-0028). Each entry carries the directive's canonical name, its aliases, the `valueKind` (`"none"` / `"freeform"` / `"enum"`), the allowed `values` (non-empty only for `"enum"`), and a one-line summary. |
| `directiveValueOptions(name)` | `string[] \| null` | Return the allowed value set for an enum-valued directive (alias-aware), or `null` for free-form / value-less directives and unknown names (ADR-0028). |

> **Note:** Pitch- and note-returning functions here return `undefined` for
> "not found", not `null`. This differs from `@chordsketch/node`, where the
> equivalent functions return `null`. The SVG-returning functions
> (`chord_diagram_svg` and its variants) return `null` on both bindings.

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
