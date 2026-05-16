# `irealb://` and `irealbook://` URL formats

Notes on the iReal Pro export URL formats. iReal Pro publishes the
[Custom Chord Chart Protocol][spec] (the chord-chart token
grammar — `*X` rehearsal marks, barlines, repeats, `n` no-chord,
`Y/YY/YYY` vertical spacers, etc.) and a companion
[developer docs page][devdocs] (overview of the `irealb://` and
`irealbook://` URL prefixes used to embed charts).

What the published spec covers, and how this parser relates to it:

- The **chord-chart token grammar** documented in the table below is
  a **subset of the published spec extended with internal tokens**
  observed in real exports (`Kcl`, `XyQ`, `LZ|`). Spec tokens the
  parser does not yet implement (`f` Fermata) are listed under
  "Out of scope" at the bottom.
- The **6-field `irealbook://` URL layout** this parser accepts —
  `Title=Composer=Style=Key=TimeSig=Music`, packed-digit timesig in
  slot 5, plain-text music body — does **not** match the spec's
  6-field example, which uses the literal `n` placeholder in slot 5
  ("no longer used") and embeds the time signature inside the chord
  stream as a `T..` token. The shape documented below is the legacy
  iRealBook layout that pianosnake/ireal-reader implements;
  spec-conformant parsing of the slot-5-`n` shape is tracked
  separately.
- The **obfuscated `irealb://` body** — the `MUSIC_PREFIX` sentinel
  plus the `obfusc50` per-50-char permutation — is **not** covered
  by the published spec at all. For that half the public references
  are the open-source [`pianosnake/ireal-reader`][pianosnake]
  JavaScript parser and the [`ironss/accompaniser`][accompaniser]
  de-obfuscation routine it cites.
- The **`===`-separated multi-song envelope** is likewise not in the
  published spec; pianosnake/ireal-reader is the reference.

This document reflects what the `chordsketch-ireal` parser
(`src/parser.rs`) implements; the grammar here covers the subset
the parser handles — features that the iReal app supports but our
parser folds into `ChordQuality::Custom` (or simply skips) are
listed under "Out of scope" at the bottom.

[spec]: https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol
[devdocs]: https://www.irealpro.com/developer-docs
[pianosnake]: https://github.com/pianosnake/ireal-reader
[accompaniser]: https://github.com/ironss/accompaniser

## URL shape

```
irealb://<percent-encoded-body>
irealbook://<percent-encoded-body>
```

Both prefixes are accepted by `strip_prefix` and dispatch is driven
by the body's part count + the presence of the `MUSIC_PREFIX`
sentinel, **not** by the URL prefix. In practice the iReal Pro app
exports obfuscated bodies under `irealb://` (7..=9 fields, music
slot starts with the sentinel) and emits the legacy plain-text
`irealbook://` shape (6 fields, no sentinel) for older / embedded
exports; the parser accepts either prefix for either shape so a
mis-labelled export still round-trips.

### File extension convention

The upstream iReal Pro app does not register a file extension —
URLs are typically pasted into clipboard / email / chat without a
backing file. ChordSketch establishes the following project-local
convention so the URL can be saved to disk and round-tripped:

| Extension | Body | URL prefix |
|---|---|---|
| `.irealb` | Single song — one `irealb://...` URL on a single line | `irealb://` |
| `.irealbook` | Multi-song collection — one `irealbook://...` URL on a single line | `irealbook://` |

`parse_collection` accepts both prefixes; the extension distinction
is for dialog filters, OS associations, and editor-mode hints only.
Sister sites that consume this convention: the CLI sniff
(`crates/cli/src/main.rs`), the Tauri desktop file associations
(`apps/desktop/src-tauri/tauri.conf.json`), and the VS Code /
JetBrains / Zed editor integrations.

## Top-level body structure

After percent-decoding the URL body, songs are separated by `===`:

```
song1===song2===song3===<playlist-name>
```

A single-song export has no `===` separators (and no trailing
playlist name). A multi-song export has at least two `===`-
separated segments where the **last segment is the playlist
name**, not a song.

The parser pops the last segment as the name and treats the
remaining segments as songs. Empty segments are skipped.

## Per-song structure

Each song is a `=`-separated sequence of fields. Empty fields
collapse on consecutive `=` characters (so the `==` sequences in
a real URL produce empty parts that the parser drops via
`split('=').filter(|s| !s.is_empty())`):

```
Title=Composer=Style=Key=[Transpose=]Music[=CompStyle]=BPM=Repeats
```

The `Transpose` and `CompStyle` fields are optional; their
presence is detected by counting the non-empty parts and
checking which slot starts with the [`MUSIC_PREFIX`](#music-prefix):

| Part count | Layout |
|---|---|
| 6 (no part starts with `MUSIC_PREFIX`) | iRealBook six-field: `Title=Composer=Style=Key=TimeSig=Music`. Music body is plain text (no music prefix, no `obfusc50` scramble); time signature is a packed-digit field (`44`, `34`, `68`, `128`) outside the chord stream. Tempo and transpose default to `None` / `0`. **Divergence from spec**: the published [Custom Chord Chart Protocol][spec] documents a different 6-field shape — `Title=Composer=Style=Key=n=Music` with the literal `n` placeholder ("no longer used") in slot 5 and the time signature embedded inside the chord stream as a `T..` token. The shape parsed here is the legacy iRealBook layout that [`pianosnake/ireal-reader`][pianosnake] implements; spec-conformant parsing of the slot-5-`n` shape is a separate concern. |
| 7 | `Title=Composer=Style=Key=Music=BPM=Repeats` |
| 8 (parts[4] starts with prefix) | `Title=Composer=Style=Key=Music=CompStyle=BPM=Repeats` |
| 8 (parts[5] starts with prefix) | `Title=Composer=Style=Key=Transpose=Music=BPM=Repeats` |
| 9 | `Title=Composer=Style=Key=Transpose=Music=CompStyle=BPM=Repeats` |

Anything outside `6` (irealbook) or `7..=9` (irealb) parts is
`ParseError::MalformedBody`. A malformed numeric field in either
shape (`BPM`, `Transpose`, `TimeSig` for the 6-field path) surfaces
as `ParseError::InvalidNumericField`.

### Music prefix

The chord-chart body is sentinel-prefixed with the literal string
`1r34LbKcu7`. The parser strips this prefix before invoking the
unscramble routine; an absent prefix surfaces as
`ParseError::MissingMusicPrefix`.

## Obfuscation: `obfusc50`

The chord-chart body (after stripping the music prefix) is
obfuscated by a per-50-character block permutation:

1. Walk the input in 50-character chunks (counted in **chars**,
   not bytes — iReal exports may contain UTF-8 metadata).
2. For each full 50-char chunk, **except** the chunk immediately
   before a tail of fewer than 2 chars (a quirk of the upstream JS
   that we mirror for round-trip parity):
   - Mirror positions `[0..=4]` ↔ `[45..=49]` (5 swaps).
   - Mirror positions `[10..=23]` ↔ `[26..=39]` (14 swaps).
   - Positions `[5..=9]`, `[24..=25]`, and `[40..=44]` are
     untouched.
3. Append any remaining tail (≤ 50 chars) unchanged.

The permutation is **self-inverse** — applying `obfusc50` twice
returns the input — which is the property serialisation will rely
on when [#2052](https://github.com/koedame/chordsketch/issues/2052)
lands.

## Chord-chart token grammar

The unscrambled body is processed left-to-right. The parser
checks each token in this priority order:

| Token / pattern | Effect |
|---|---|
| `XyQ` | Empty space — discard. |
| `Kcl` | "Repeat previous measure" marker bar — sets `Bar::repeat_previous = true` on the new bar. The renderer paints the percent-style 1-bar simile glyph (SMuFL U+E500). |
| `LZ\|` / `LZ` | Bar separator. |
| `*X` (`X` = single char) | Section marker. Per the iReal Pro open-protocol spec, the app emits exactly six rehearsal-mark tokens: `*A` / `*B` / `*C` / `*D` (jazz-form letter labels), `*i` (Intro), `*V` (Verse). The parser maps `*A..Z` → `Letter(c)`, `*i`/`*I` → `Intro`, `*v`/`*V` → `Verse`, anything else → `Custom(string)`. Earlier revisions also recognised `*c` / `*b` / `*o` as Chorus / Bridge / Outro but those tokens are not emitted by iReal Pro (the app treats them as custom labels) so the named variants were removed. |
| `<...>` | Comment / text mark. Anchored macro detection (start-of-comment, followed by space/dot/end): `D.C.` → `MusicalSymbol::DaCapo`, `D.S.` → `DalSegno`, `Fine` → `Fine`. The full verbatim text is ALSO saved to `Bar::text_comment` so longer captions like `<D.S. al 2nd ending>` and free-form `<13 measure lead break>` survive the round-trip. A bare-macro comment (`<D.C.>`, `<D.S.>`, `<Fine>`) skips the `text_comment` write since the symbol fully covers the semantics. |
| `Tnd` | Time signature. Two-digit packed form (`T44` = 4/4, `T34` = 3/4, `T68` = 6/8); three-digit form when numerator is two digits (`T128` = 12/8). |
| `x` | Repeat previous measure — sets `Bar::repeat_previous = true` on the current bar. |
| `r` | Repeat previous two measures — currently collapses to the same `Bar::repeat_previous = true` flag as `x` / `Kcl`. A future schema split may distinguish 1-bar from 2-bar simile via a separate field. |
| `Y+` | Vertical spacer — discard. |
| `n` | "No Chord" — sets `Bar::no_chord = true`. The renderer paints `N.C.` in the bar's centre. |
| `p` | Pause slash — discard. |
| `U` | Player ending marker — discard. |
| `S` | Segno — sets `Bar::symbol = Some(Segno)` on the current bar. |
| `Q` | Coda — sets `Bar::symbol = Some(Coda)` on the current bar. |
| `{` / `}` | Open / close repeat — sets `BarLine::OpenRepeat` / `BarLine::CloseRepeat` on the boundary bars. |
| `\|` | Bar separator. |
| `[` / `]` | Double bar open / close — sets `BarLine::Double`. |
| `Nd` (`d` = digit) | N-th ending bracket on the current bar (`N1` = first ending, etc.); rejects digit `0`. |
| `Z` | Final bar (`BarLine::Final`). |
| `(...)` | Alternate chord — when the parser is inside a `(...)` block, the next chord token attaches to the previously-pushed chord's `Chord::alternate` field rather than as a new chord on the bar. The renderer stacks the alternate above the primary at a smaller size. |
| `,` `.` `:` `;` | Punctuation — discard. |
| `[A-GW][quality]*[/Bass]?` | Chord. `W` is the iReal "invisible slash" — repeats the previous root with this quality. |

Anything else is dropped one char at a time, matching
pianosnake's fall-through path.

### Chord token grammar

A chord matches:

```
ROOT  ACCIDENTAL?  QUALITY*  ('/' BASS ACCIDENTAL?)?
```

with:

- `ROOT` = `A`..`G` or `W`
- `ACCIDENTAL` = `#` or `b`
- `QUALITY` = any of `+ - ^ h o # b 0..9 s u a d l t`
- `BASS` = `A`..`G`

The post-root, pre-slash quality token is normalised by
`parse_quality` against a small set of canonical iReal forms:

| Token | `ChordQuality` |
|---|---|
| (empty) | `Major` |
| `-`, `m`, `min` | `Minor` |
| `o` | `Diminished` |
| `+`, `aug` | `Augmented` |
| `^7`, `M7`, `maj7` | `Major7` |
| `-7`, `m7`, `min7` | `Minor7` |
| `7` | `Dominant7` |
| `h`, `h7`, `m7b5` | `HalfDiminished` |
| `o7` | `Diminished7` |
| `sus2` | `Suspended2` |
| `sus`, `sus4` | `Suspended4` |
| anything else | `Custom(token)` (verbatim) |

`Custom` exists so the AST does not have to track every notation
variant the iReal app permits; the renderer (#2057) and the
ChordPro converter (#2053) own the glyph / spelling mapping for
the long tail.

## Out of scope

The parser **records** the following structurally but does **not
expand** them — that is render- or convert-time work:

- Repeat bar count: `{ ... }` becomes `OpenRepeat` / `CloseRepeat`
  barlines, not duplicated bars.
- `D.C.` / `D.S.` / `Fine`: recorded as `MusicalSymbol`s on the
  bar that carries the directive, not unfolded.
- N-th endings: recorded as `Bar::ending: Some(Ending)`, not
  expanded.

The parser **drops** the following that the iReal app
distinguishes:

- `p` (Pause slash): no AST representation.
- `U` (Player-only ending): no AST representation.
- `Y+` (Vertical spacer): no AST representation (visual hint
  only).
- `f` (Fermata): the spec lists this alongside `S` (Segno) and
  `Q` (Coda) as a rehearsal-mark / bar-attached symbol; the
  parser falls through `f` to the chord-detection path and may
  consume it as part of a chord-quality token rather than
  recording it as a `MusicalSymbol`. Adding the AST variant and
  parser branch is a separate concern and is not blocking; until
  it lands, the spec's `f` token is a known gap relative to the
  published grammar.
- `*X*` closing-`*` sentinel: each `*X` greedily becomes a
  section marker, so `*m*X` parses as **two** sections (`m`
  followed by `X`). This mirrors pianosnake's behaviour — the
  closing `*` is not a documented terminator in the format.

The parser **rejects** as malformed:

- Truncated or non-hex `%XX` escapes (`InvalidPercentEscape`).
- Music body without the `1r34LbKcu7` sentinel
  (`MissingMusicPrefix`).
- A song body that does not match any of the documented part
  counts (`MalformedBody`).
- Empty collections (`NoSongs`).

## References

- [iReal Pro Custom Chord Chart Protocol][spec] — official
  spec for the chord-chart token grammar.
- [iReal Pro Developer Docs][devdocs] — overview of the
  `irealb://` / `irealbook://` URL prefixes (embedding /
  cross-app pasteboard).
- [`pianosnake/ireal-reader`][pianosnake] — JavaScript reference
  parser; source for the obfuscated body shape and the legacy
  6-field iRealBook layout.
- [`ironss/accompaniser`][accompaniser] — Lua port; original
  source of the `obfusc50` permutation algorithm.
- [`daumling/ireal-renderer`][daumling] — JavaScript reference
  renderer; the AST shape in `src/ast.rs` is modelled on this
  project's data model.

[daumling]: https://github.com/daumling/ireal-renderer
