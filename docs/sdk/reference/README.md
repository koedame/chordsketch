# `@chordsketch/react` API reference

Per-component and per-hook reference for every export from
[`packages/react/src/index.ts`](https://github.com/koedame/chordsketch/blob/main/packages/react/src/index.ts).
The library is split between a **ChordPro surface** and an **iReal
Pro surface**; both surfaces are import-shaped the same way and
share the same wasm runtime under the hood.

For copy-paste-ready embedding recipes, see
[Embed in a React app](#/embed-react). The pages below assume you
already have `@chordsketch/react` installed and want the precise
prop / parameter contract for a specific export.

## ChordPro

| Topic | Covers |
|---|---|
| [`<ChordSheet>` + AST hooks](#/reference/chord-sheet) | `<ChordSheet>`, `renderChordproAst`, `useChordRender`, `useChordproAst` and the AST types |
| [`<ChordProEditor>`](#/reference/playground) | One-component editor + preview + transpose composite (renamed from `<Playground>` in v0.3.0) |
| [`<ChordProPreview>`](#/reference/chord-pro-preview) | Preview pane + format toggle + transpose controls, no source editor (new in v0.3.0) |
| [Editors](#/reference/editors) | `<ChordTextarea>` (textarea baseline, was `<ChordEditor>`), `<ChordSourceArea>` (CodeMirror, was `<SourceEditor>`), `chordProLanguage`, `chordProTagTable` |
| [Layout primitives](#/reference/layout) | `<SplitLayout>`, `<RendererPreview>` |
| [`<Transpose>` + `useTranspose`](#/reference/transpose) | Accessible ± / reset control and its standalone hook |
| [`<ChordDiagram>` + `useChordDiagram`](#/reference/chord-diagram) | Chord-voicing SVG renderer |
| [`<PdfExport>` + `usePdfExport`](#/reference/pdf-export) | Lazy-loaded PDF export button + hook |
| [Chord source-edit helpers](#/reference/chord-source-edit) | `applyChordReposition`, `lyricsOffsetToSourceColumn` |

## iReal Pro

| Topic | Covers |
|---|---|
| [Components](#/reference/ireal-components) | `<IrealBarGrid>` (was `<IrealEditor>`), `<IrealPreview>`, `<IrealProEditor>` (was `<IrealPlayground>`) |
| [Hooks](#/reference/ireal-hooks) | `useIrealParse`, `useIrealSerialize`, `useIrealRender` |
| [AST helpers](#/reference/ireal-helpers) | `irealChord*ToString`, `irealCanonicalSymbolText`, `irealIs*` |

## Other

- [`version()`](#/reference/version) — runtime version helper.
- [`useDebounced`](#/reference/chord-sheet) — re-exported utility,
  documented on the `<ChordSheet>` page where it is most often used.
