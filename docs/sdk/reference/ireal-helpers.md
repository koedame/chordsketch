# iReal Pro AST helpers

Pure helper functions for projecting `IrealSong` AST nodes back to
their canonical text form. None of these touch the wasm runtime;
they operate on the in-memory AST and are safe to call in any
context (SSR, web worker, command palette).

## `irealChordRootToString`

```ts
function irealChordRootToString(root: IrealChordRoot): string;
```

Returns the chord root in iReal Pro's canonical accidental form
(`C`, `Db`, `F#`, …). Pairs with `irealChordQualityToString` to
build a full chord label.

## `irealChordQualityToString`

```ts
function irealChordQualityToString(quality: IrealChordQuality): string;
```

Returns the chord quality suffix (`'7'`, `'^9'`, `'h7'`, …) using
iReal Pro's URL-storage shorthand. The
[`crates/render-ireal::chord_typography`](https://github.com/koedame/chordsketch/blob/main/crates/render-ireal/src/chord_typography.rs)
module translates this shorthand to display glyphs (`♭` / `Δ` /
`ø` / `°` / `−`) for the SVG renderer; consumers that need the
display form should drive `chordTypography` on the wasm surface.

## `irealChordToString`

```ts
function irealChordToString(chord: IrealChord): string;
```

Convenience wrapper that concatenates root + quality + optional
bass note into one string. Equivalent to
`${irealChordRootToString(chord.root)}${irealChordQualityToString(chord.quality)}${chord.bass ? '/' + irealChordRootToString(chord.bass) : ''}`.

## `irealSectionLabelToString`

```ts
function irealSectionLabelToString(label: IrealSectionLabel): string;
```

Stringifies a section-label union (`'*A' | '*B' | ... | 'Verse' | ...`)
to its single-line label.

## `irealCanonicalSymbolText`

```ts
function irealCanonicalSymbolText(symbol: IrealMusicalSymbol): string | null;
```

Returns the canonical text form of a `MusicalSymbol` AST node
(`'S'` for segno, `'Q'` for coda, `'<D.C. al Fine>'` for da-capo
phrases, …). Returns `null` for symbols that have no text
representation (e.g. `Coda` rendered as a glyph).

## `irealIsDaCapo`, `irealIsDalSegno`

```ts
function irealIsDaCapo(symbol: IrealMusicalSymbol | null): boolean;
function irealIsDalSegno(symbol: IrealMusicalSymbol | null): boolean;
```

Type-guarded predicates for the `MusicalSymbol::DaCapo` /
`MusicalSymbol::DalSegno` variants. Useful when building a
"jumps" sidebar that lists every D.C. / D.S. marker in a chart.
