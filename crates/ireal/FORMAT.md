# `irealb://` URL format

Reverse-engineered notes on the iReal Pro export URL format. There
is no published spec; this document reflects what the
`chordsketch-ireal` parser (`src/parser.rs`) implements, derived
from the open-source [`pianosnake/ireal-reader`][1] JavaScript
parser and the [`ironss/accompaniser`][2] de-obfuscation routine
it cites. The grammar here covers the subset the parser handles —
features that the iReal app supports but our parser folds into
`ChordQuality::Custom` (or simply skips) are listed under
"Out of scope" at the bottom.

[1]: https://github.com/pianosnake/ireal-reader
[2]: https://github.com/ironss/accompaniser

## URL shape

```
irealb://<percent-encoded-body>
irealbook://<percent-encoded-body>
```

Both prefixes carry the same body grammar. iReal generates
`irealbook://` when the export holds a named playlist; `irealb://`
appears for single charts.

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
| 7 | `Title=Composer=Style=Key=Music=BPM=Repeats` |
| 8 (parts[4] starts with prefix) | `Title=Composer=Style=Key=Music=CompStyle=BPM=Repeats` |
| 8 (parts[5] starts with prefix) | `Title=Composer=Style=Key=Transpose=Music=BPM=Repeats` |
| 9 | `Title=Composer=Style=Key=Transpose=Music=CompStyle=BPM=Repeats` |

Anything outside `7..=9` parts is `ParseError::MalformedBody`.

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
| `Kcl` | Repeat previous bar; close current and open a new one. |
| `LZ\|` / `LZ` | Bar separator. |
| `*X` (`X` = single char) | Section marker. Lower-case `i / v / c / b / o` → `Intro / Verse / Chorus / Bridge / Outro`. Uppercase `A..Z` → `Letter(c)`. Anything else → `Custom(string)`. |
| `<...>` | Comment. Recognised text inside: `D.C.` → `MusicalSymbol::DaCapo`, `D.S.` → `DalSegno`, `Fine` → `Fine`. Any other comment is dropped. |
| `Tnd` | Time signature. Two-digit packed form (`T44` = 4/4, `T34` = 3/4, `T68` = 6/8); three-digit form when numerator is two digits (`T128` = 12/8). |
| `x` | Repeat previous measure (no AST impact at parse time). |
| `r` | Repeat previous two measures (no AST impact at parse time). |
| `Y+` | Vertical spacer — discard. |
| `n` | "No chord" placeholder — discard (AST has no `NC` variant). |
| `p` | Pause slash — discard. |
| `U` | Player ending marker — discard. |
| `S` | Segno mark on the next bar. |
| `Q` | Coda mark on the next bar. |
| `{` / `}` | Open / close repeat — sets `BarLine::OpenRepeat` / `BarLine::CloseRepeat` on the boundary bars. |
| `\|` | Bar separator. |
| `[` / `]` | Double bar open / close — sets `BarLine::Double`. |
| `Nd` (`d` = digit) | N-th ending bracket on the next bar (`N1` = first ending, etc.); rejects digit `0`. |
| `Z` | Final bar (`BarLine::Final`). |
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

- `n` (No Chord): no `NC` variant in the AST.
- `p` (Pause slash): no AST representation.
- `U` (Player-only ending): no AST representation.
- `Y+` (Vertical spacer): no AST representation (visual hint
  only).
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

- pianosnake/ireal-reader — JavaScript reference parser.
- ironss/accompaniser — Lua port; original obfuscation source.
- daumling/ireal-renderer — JavaScript reference renderer (the
  AST shape in `src/ast.rs` is modelled on this project's data
  model).
