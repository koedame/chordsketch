# `chordsketch-ireal` — AST design notes

This document records the design decisions that shape the AST in
`src/ast.rs` so the follow-up crates (#2052 / #2053 / #2054 /
#2058 / #2061 / #2066 / #2067) inherit a stable foundation. Every
choice listed here is a load-bearing assumption for at least one
of those tickets.

## Reference data model

The iReal Pro chart format has no published spec. The closest
public artefact is the [`daumling/ireal-renderer`][1] JS project,
which the AC for #2055 explicitly nominates as the reference. We
ported the **data model** (what fields a chart carries, how chords
sit inside bars, how repeats and endings nest) and intentionally
did **not** port the JS rendering code — rendering lives in
`chordsketch-render-ireal` (#2058) and binds to the data model
through this crate's public API.

[1]: https://github.com/daumling/ireal-renderer

## Field-level rationale

### `IrealSong`

- `title: String` (not `Option`). iReal Pro tolerates an empty
  title, and the conversion crate (#2053) gains nothing from
  carrying a `None`-vs-`Some("")` distinction. Empty string is
  the canonical "no title".
- `composer / style: Option<String>`. These are user-supplied and
  often missing on community-shared charts; `Option` reflects the
  source data better than an empty-string convention.
- `key_signature: KeySignature` (not `Option`). iReal Pro always
  has an implicit key (`C major` is the format default), and a
  default keeps every consumer monomorphic.
- `time_signature: TimeSignature` (not `Option`). Same reasoning;
  `4/4` is iReal's default.
- `tempo: Option<u16>`. Many charts leave tempo to the player;
  `Option` is honest.
- `transpose: i8`. Range `[-11, 11]` matches the existing
  `chordsketch-chordpro` clamp.
- `sections: Vec<Section>`. The chart is a flat list; nesting
  (e.g. forms inside forms) is not part of the iReal model.

### `Section`

- `label: SectionLabel`. The named-variant set (`Verse`, `Chorus`,
  `Intro`, `Outro`, `Bridge`) covers the strings the conversion
  crate (#2053) needs to map deterministically to ChordPro
  `{start_of_chorus}` / `{start_of_verse}` / etc. Letter form
  (`A`/`B`/`C`/`D`) is the jazz convention. `Custom(String)` is
  the escape hatch for anything else.

### `Bar`

- `start / end: BarLine` (no implicit defaults at the type level).
  Mid-section bars use `Single` on both sides; section boundaries
  use `Double`; repeat blocks use `OpenRepeat` / `CloseRepeat`;
  the chart's last bar uses `Final`.
- `chords: Vec<BarChord>`. An empty vector is the iReal "repeat
  the previous bar" idiom (the rendering crate paints a `W` glyph).
  Storing it as empty rather than introducing a `RepeatPrior`
  variant on `Bar` keeps the structure denormalised but keeps the
  bar-list ordering trivially indexable, which matters for the
  4-bar-per-line layout engine in #2060.
- `ending: Option<Ending>`. `Ending` wraps `NonZeroU8` so the
  `Some(Ending(0))` shape is unrepresentable.
- `symbol: Option<MusicalSymbol>`. Single-symbol-per-bar matches
  iReal Pro convention. If a future format extension allows
  multiples, this becomes `Vec<MusicalSymbol>` and call sites that
  match on `Option` need to update — flagged here so the migration
  is not surprising.

### `BarChord` and `BeatPosition`

- `BeatPosition { beat: NonZeroU8, subdivision: u8 }`. Discrete
  integers (not `f32`) so equality is byte-stable for golden
  tests. `subdivision` is in units of `2 ^ subdivision`-of-a-beat:
  `0` = on the beat, `1` = half-beat after, `2` = quarter-beat
  after, etc. This is enough resolution for the iReal grid (which
  shows up to 8th notes off-beat) without floating-point grief.

### `Chord` and `ChordQuality`

- `Chord { root, quality, bass }`. Slash chords are decomposed,
  not encoded as a special quality. `bass.is_none()` is "no slash".
- `ChordQuality::Custom(String)`. The named variants cover the
  qualities `chordsketch-render-ireal` (#2057) renders as a
  distinct glyph; everything beyond (extensions, alterations, poly
  chords) is a Custom string with the post-root token preserved
  verbatim. This avoids enum-bloat and keeps the rendering crate
  in charge of glyph mapping.

### `ChordRoot`

- `note: char` (uppercase ASCII letter). Storing as `char`
  instead of an enum keeps round-tripping with the URL serializer
  (#2052) trivial without paying the cost of a 7-variant enum
  whose `match` arms duplicate `c.is_ascii_uppercase()` checks.
  The character set is documented here and asserted at parse time
  (#2054 owns that check).

### `TimeSignature`

- `numerator: u8` clamped to `1 ..= 12` and `denominator` clamped
  to `{2, 4, 8}` at construction. The numerator cap matches iReal
  Pro's UI; the denominator allow-list excludes `1/x` and `x/16`
  because the iReal grid cannot render them. Construction errors
  return `None` rather than panicking — public APIs validate at
  the boundary per `.claude/rules/defensive-inputs.md`.

## Deferred AST scope

Items the iReal app supports but the AST does **not** model yet,
along with where they should land when implemented:

- **Mid-chart time changes.** A chart can switch from `4/4` to
  `3/4` mid-form. Modelling this requires either per-section
  `TimeSignature` overrides or per-bar overrides; the design call
  is deferred to #2054 where the parser will surface the format's
  actual encoding (`T34` markers).
- **Mid-chart key changes.** Same shape problem as time changes.
  Defer to #2054.
- **Slash-chord with non-letter bass.** A chord like
  `C/D♯` parses as `Chord { root: C, quality: Major, bass: Some(D♯) }`
  today; future work for the parser may need to accept root-less
  bass forms or pedal-tone extensions. Adding new `ChordQuality`
  variants is non-breaking and is the planned migration path.
- **Coda-2 / Segno-2.** iReal Pro distinguishes a second segno
  and a second coda for double-jump pieces. `MusicalSymbol`
  currently lists only one of each; if #2059 surfaces a need for
  the second forms, add `SegnoSecondary` / `CodaSecondary` variants
  rather than abusing the existing names.
- **Full repeat-bar-counts.** iReal supports "repeat the last 2
  bars" (a single `r` glyph spanning two bars). The current AST
  represents only single-bar repeats (an empty `Bar { chords: [] }`).
  #2059 owns the multi-bar form when it lands.
- **Lyrics.** iReal Pro has no native lyrics surface; the
  ChordPro→iReal converter (#2061) drops them. Modelling lyrics
  in this AST would be premature.

## JSON debug format

`src/json.rs` emits a stable, compact JSON view of an `IrealSong`
for golden-snapshot tests, and parses it back via the `FromJson`
trait. It is **not** a public wire format — the canonical iReal
serialisation is the `irealb://` URL, owned by #2052.

Format properties relied on by golden tests:

- Compact (no indentation, no whitespace inside objects).
- Field order matches the struct field order in `ast.rs`.
- Enums are tagged with a `"kind"` discriminator key when carrying
  payload data (`SectionLabel`, `ChordQuality`); plain enums (e.g.
  `Accidental`, `BarLine`) are bare strings.
- Strings use only the JSON-mandatory escapes plus `\u{XXXX}` for
  C0 controls. Non-ASCII passes through as UTF-8.

The deserializer is round-trip-only: it accepts exactly the subset
of JSON the serializer emits (no booleans, no floats, no trailing
commas, no leading-zero or `-0` integers, no duplicate keys, no
surrogate-pair `\u` escapes) and rejects anything else. Widening
one half of the pair without the other is a structural defect —
see the `json_round_trip_*` tests in `tests/ast.rs`.

The deserializer additionally enforces value-range invariants the
type system does not encode:

- `IrealSong.transpose` clamped to `[-11, 11]` (matches the
  `chordsketch-chordpro` clamp).
- `IrealSong.tempo` rejected when `Some(0)`; "no tempo recorded"
  is `None`.
- `ChordRoot.note` restricted to ASCII `A..=G` uppercase.
- `Ending::new(0)` and `BeatPosition::on_beat(0)` rejected via the
  `NonZeroU8` field types.
- `TimeSignature::new` enforces `numerator: 1..=12` and
  `denominator ∈ {2, 4, 8}`.

Out-of-range values produced by the serializer (i.e. supplied via
direct `pub` field mutation, bypassing the validating constructors)
will round-trip-fail in the deserializer — that is the load-bearing
property of the round-trip-only contract.

### Resource limits

`parse_json` enforces:

| Constant | Default |
|---|---|
| `MAX_INPUT_BYTES` | 4 MiB |
| `MAX_DEPTH` | 128 |
| `MAX_ARRAY_LEN` | 65 536 |
| `MAX_OBJECT_FIELDS` | 65 536 |
| `MAX_STRING_CHARS` | 1 048 576 |

These bounds are documented `pub const`s and changing any of them
is a review-required change. The duplicate-key check uses
`BTreeSet<String>` to keep the per-object cost `O(n log n)`.

### Diagnostic position semantics

`JsonError::position` is the byte index in the source string where
the parser detected the problem. For errors raised by the
post-parse AST extractors (missing field, wrong variant tag, value
out of documented range), the position is `0` because the parsed
[`crate::json::JsonValue`] tree does not preserve source spans;
the `message` is the only diagnostic for those cases. This is a
deliberate trade-off — adding spans to the value tree would
complicate every implementation of `FromJson` for marginal benefit
in a debug-only format.

If any property above changes, the tests
`json_serialization_is_byte_stable`,
`json_round_trips_through_deserializer`, and
`json_round_trip_handles_every_enum_variant` in `tests/ast.rs`,
plus this section, must be updated together.

## Dependency policy

Zero external dependencies. Every iReal-related follow-up crate
(#2052 / #2054 / #2058 / etc.) builds on this AST, so adding a
runtime dependency here would force the policy onto every
dependent. `chordsketch-chordpro` follows the same rule for the
same reason.

## Open questions for the parser (#2054)

- Should the parser produce `IrealSong` directly, or an interim
  per-bar token stream that this crate doesn't model? The current
  scaffold assumes the former; if the latter turns out to be
  structurally needed, it lives in `chordsketch-ireal::parser` as
  a separate module rather than disturbing the public AST shape.
- How are multi-song iReal collections (`irealbook://`) surfaced
  to callers? Most likely as `Vec<IrealSong>` from a top-level
  `parse_collection` function. Confirmed when #2054 lands.
