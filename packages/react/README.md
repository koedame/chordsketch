<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/react

React component library for rendering [ChordPro](https://www.chordpro.org/)
files, powered by [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm).

> **Status:** scaffold only. The component surface
> (`<ChordSheet>`, `<ChordEditor>`, `<Transpose>`, `<ChordDiagram>`,
> `<PdfExport>`) lands in issues
> [#2041](https://github.com/koedame/chordsketch/issues/2041)–[#2045](https://github.com/koedame/chordsketch/issues/2045).
> Until those issues close, the only export is `version()` — the
> package exists so its npm name is reserved, its publish pipeline
> is proven, and downstream consumers can pin against it ahead of
> the component release.

## Installation

[![npm](https://img.shields.io/npm/v/@chordsketch/react)](https://www.npmjs.com/package/@chordsketch/react)

Replace `VERSION` with the current version from the badge above.

```bash
npm install '@chordsketch/react@VERSION' react
```

`@chordsketch/wasm` is bundled as a runtime dependency and loads
itself — the host does not need to install it separately. `react`
is a **peer dependency** (React 18 or newer).

## Usage (scaffold)

```ts
import { version } from '@chordsketch/react';

console.log(version()); // "0.0.0" (pre-release)
```

Once the components land the API will grow; the package's `main`
entry point will remain the stable surface so this import path
continues to work.

## Design

- **Dual build (ESM + CJS)** produced by
  [tsup](https://tsup.egoist.dev/). Type declarations are emitted
  alongside each output.
- **React, ReactDOM, and `@chordsketch/wasm` are `external`** in the
  build config — they are resolved by the consumer's bundler rather
  than bundled in. This keeps the published package small and lets
  consumers upgrade those dependencies on their own cadence.
- **CSS under `./styles.css`** (currently empty) is the canonical
  stylesheet import path for future components:
  ```ts
  import '@chordsketch/react/styles.css';
  ```
  The export is reserved in `package.json` so the first component
  PR can land the stylesheet without a breaking path change.

## Links

- [Main repository](https://github.com/koedame/chordsketch)
- [ChordSketch Playground](https://koedame.github.io/chordsketch/)
  (vanilla-TS) — shows the underlying rendering with
  `@chordsketch/wasm` directly
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

[MIT](https://github.com/koedame/chordsketch/blob/main/LICENSE)
