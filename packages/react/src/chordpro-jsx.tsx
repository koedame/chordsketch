// AST → JSX walker for the ChordPro AST emitted by
// `@chordsketch/wasm`'s `parseChordpro` export.
//
// Mirrors the DOM structure produced by
// `chordsketch-render-html` (`crates/render-html/src/lib.rs`)
// closely enough that the existing CSS keyed off
// `.song`, `.line`, `.chord-block`, `.chord`, `.lyrics`,
// `.empty-line`, `.section-label`, `.comment`, `.comment-box`,
// `.chorus-recall`, `<section class="…">`, `<h1>`, `<h2>`,
// `<p class="meta">` continues to apply unchanged.
//
// The split between this file and `chordsketch-render-html` is
// the architectural one captured by
// [ADR-0017](../../docs/adr/0017-react-renders-from-ast.md):
// React surfaces render AST → JSX directly, while
// `chordsketch-render-html` stays as the canonical static-HTML
// emitter for the CLI / FFI / GitHub Action surfaces.
//
// Sanitizer parity is enforced via `isSafeHref` below — the
// same URI-scheme blocklist used by
// `crates/render-html/src/lib.rs::has_dangerous_uri_scheme`
// (`javascript:`, `vbscript:`, `data:`, `file:`, `blob:`).
// Any new scheme added in the Rust list MUST land in
// `DANGEROUS_URI_SCHEMES` here in the same PR per
// `.claude/rules/sanitizer-security.md` §"Security Asymmetry".

import { Fragment, cloneElement, isValidElement, useMemo, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, JSX, ReactNode } from 'react';

import { ChordDiagram } from './chord-diagram';
import {
  KeySignatureGlyph,
  MetronomeGlyph,
  RoleIcon,
  TimeSignatureGlyph,
  tempoMarkingFor,
} from './music-glyphs';
import type {
  ChordproChord,
  ChordproDirective,
  ChordproDirectiveKind,
  ChordproImageAttributes,
  ChordproLine,
  ChordproLyricsLine,
  ChordproLyricsSegment,
  ChordproMetadata,
  ChordproSong,
  ChordproTextSpan,
} from './chordpro-ast';
import type { ChordDiagramInstrument } from './use-chord-diagram';
import type { ChordRepositionEvent } from './chord-source-edit';

// ---- Sanitiser helpers --------------------------------------------

// Sister-site list to `crates/render-html/src/lib.rs::has_dangerous_uri_scheme`'s
// scheme set. Any new entry MUST land in both lists in the same PR
// per `.claude/rules/sanitizer-security.md` §"Security Asymmetry".
//
// - `javascript:` / `vbscript:` — code execution
// - `data:` — content injection
// - `file:` / `blob:` — local file access when the HTML is opened
//   as a local file
// - `mhtml:` — MIME HTML (IE-era; the static-HTML renderer also
//   blocks it explicitly even though `is_safe_image_src` would
//   reject it via its allowlist)
const DANGEROUS_URI_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'mhtml:',
];

// Zero-width / format / bidi-override codepoints that browsers may
// render as invisible inside a URI scheme but which an attacker can
// use to split a blocked scheme name (e.g. `java\u{200B}script:` or
// `java\u{FEFF}script:`). Stripped before scheme comparison so the
// JSX-side blocklist matches the static-HTML renderer's filter byte
// for byte (`is_invisible_format_char` in `crates/render-html/src/lib.rs`).
function isInvisibleFormatChar(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x200b || // zero-width space
    code === 0x200c || // zero-width non-joiner
    code === 0x200d || // zero-width joiner
    code === 0x200e || // left-to-right mark
    code === 0x200f || // right-to-left mark
    code === 0x2060 || // word joiner
    code === 0xfeff || // BOM
    (code >= 0x202a && code <= 0x202e) || // bidi embedding/override
    (code >= 0x2066 && code <= 0x2069) // isolate / pop directional
  );
}

// Mirrors `String::is_ascii_whitespace` + `is_ascii_control` from Rust.
function isAsciiWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}
function isAsciiControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

// Rust's `str::trim_start` strips the full Unicode `White_Space`
// property — not just ASCII whitespace. The JS port has to cover
// the same set so an `href` like `\u{00A0}javascript:alert(1)`
// (NBSP-prefixed) reaches the same prefix-check state in both
// implementations. Covers every codepoint in the Unicode 16.0
// `White_Space` property; the 5 ASCII members are picked up by
// `isAsciiWhitespace` separately so this helper only needs the
// non-ASCII ones plus VT (`\u{000B}`) — the one ASCII codepoint
// in `White_Space` that Rust's `is_ascii_whitespace` does NOT
// flag (Rust's `is_ascii_whitespace` is a curated tab / LF / FF
// / CR / SP set; `char::is_whitespace` is the bigger set used by
// `trim_start`). Folding VT in here keeps the leading-strip
// behaviour byte-for-byte identical to Rust on the off chance
// someone hand-crafts a `\v`-prefixed payload.
function isUnicodeNonAsciiWhitespace(code: number): boolean {
  return (
    code === 0x000b || // vertical tab — in `char::is_whitespace`, not in `is_ascii_whitespace`
    code === 0x0085 || // NEL — next line
    code === 0x00a0 || // NBSP — no-break space
    code === 0x1680 || // ogham space mark
    (code >= 0x2000 && code <= 0x200a) || // en-quad … hair space
    code === 0x2028 || // line separator
    code === 0x2029 || // paragraph separator
    code === 0x202f || // narrow no-break space
    code === 0x205f || // medium mathematical space
    code === 0x3000 // ideographic space
  );
}

/**
 * Returns true when `href` is safe to embed in an `href` / `src`
 * attribute.
 *
 * Mirrors `has_dangerous_uri_scheme` in
 * `crates/render-html/src/lib.rs` byte for byte:
 *
 *   1. Trim leading whitespace (full Unicode `White_Space` set,
 *      matching `str::trim_start`).
 *   2. Drop every embedded ASCII whitespace, ASCII control, and
 *      Unicode invisible / format / bidi-override codepoint —
 *      these are the obfuscations browsers tolerate inside scheme
 *      names (`java​script:`, `java\tscript:`).
 *   3. `take(30)` significant chars so a payload padded with
 *      thousands of invisibles still hits the cap before the
 *      comparison runs.
 *   4. Lowercase.
 *   5. Prefix-check against `DANGEROUS_URI_SCHEMES`.
 *
 * Iterates with the string iterator (`for (const c of href)`) so
 * supplementary-plane codepoints count as one position against
 * the `take(30)` cap — `for (let i = 0; i < href.length; i++)`
 * would split astral codepoints into two UTF-16 code units and
 * diverge from Rust's `chars()` semantics on emoji-padded inputs.
 *
 * Any change here MUST land in the Rust function in the same PR
 * (sister-site parity per `.claude/rules/fix-propagation.md`).
 */
function isSafeHref(href: string): boolean {
  const out: string[] = [];
  let started = false;
  for (const ch of href) {
    if (out.length >= 30) break;
    const code = ch.codePointAt(0)!;
    if (!started) {
      if (isAsciiWhitespace(code) || isUnicodeNonAsciiWhitespace(code)) continue;
      started = true;
    }
    if (isAsciiWhitespace(code) || isAsciiControl(code) || isInvisibleFormatChar(code)) {
      continue;
    }
    out.push(ch);
  }
  const lower = out.join('').toLowerCase();
  return !DANGEROUS_URI_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

// ---- Inline span rendering ----------------------------------------

function renderSpan(span: ChordproTextSpan, key: number): ReactNode {
  // Element choices match `crates/render-html/src/lib.rs::render_spans`
  // byte for byte (`<b>` / `<i>` / `<mark>` / `<span class="comment">`)
  // so the existing host-page CSS keyed off those selectors lights
  // up across both surfaces (sister-site parity per
  // `.claude/rules/renderer-parity.md`). The `b` / `i` choice over
  // the more "modern" `strong` / `em` is deliberate — a future
  // change MUST update both sites in lockstep.
  switch (span.kind) {
    case 'plain':
      return span.value;
    case 'bold':
      return <b key={key}>{span.children.map(renderSpan)}</b>;
    case 'italic':
      return <i key={key}>{span.children.map(renderSpan)}</i>;
    case 'highlight':
      return <mark key={key}>{span.children.map(renderSpan)}</mark>;
    case 'comment':
      return (
        <span key={key} className="comment">
          {span.children.map(renderSpan)}
        </span>
      );
    case 'span': {
      // Inline-markup `{span}` attribute values are caller-supplied
      // (they originate from the parsed ChordPro document), so
      // route every value through `sanitizeCssValue` before
      // committing it to the React `style` object. Sister-site to
      // `crates/render-html/src/lib.rs::render_spans`, which
      // filters every CSS value through the same allowlist
      // (alphanumeric + `# . - <space> , % +`) before writing it
      // into the inline `style="…"` attribute. Without this, a
      // ChordPro payload like
      // `{span foreground=red); background-image: url(//evil.example/?leak`
      // is harmless to React's per-property style API but creates
      // a sanitizer asymmetry between the two surfaces — flagged
      // by `.claude/rules/sanitizer-security.md` §"Security
      // Asymmetry" and `renderer-parity.md` §"Sanitizer Parity
      // (React JSX surface)".
      const style: CSSProperties = {};
      if (span.attributes.fontFamily) {
        style.fontFamily = sanitizeCssValue(span.attributes.fontFamily);
      }
      if (span.attributes.size) style.fontSize = sanitizeCssValue(span.attributes.size);
      if (span.attributes.foreground) style.color = sanitizeCssValue(span.attributes.foreground);
      if (span.attributes.background) {
        style.backgroundColor = sanitizeCssValue(span.attributes.background);
      }
      if (span.attributes.weight) style.fontWeight = sanitizeCssValue(span.attributes.weight);
      if (span.attributes.style) style.fontStyle = sanitizeCssValue(span.attributes.style);
      return (
        <span key={key} style={style}>
          {span.children.map(renderSpan)}
        </span>
      );
    }
    default: {
      // Exhaustiveness guard — if a future Rust-side `TextSpan`
      // variant ships before the walker is taught to render it,
      // TypeScript flags the missing arm here at compile time
      // and the runtime falls back to a tagged placeholder
      // instead of silently rendering `undefined`. Both halves
      // matter: TS catches the lockstep regression on the
      // typechecking sister-site, while the placeholder makes
      // the missing rendering visible in the running app
      // instead of disappearing the lyric content.
      const _exhaustive: never = span;
      void _exhaustive;
      const unknownKind = (span as { kind?: string } | null | undefined)?.kind ?? 'unknown';
      if (typeof console !== 'undefined') {
        console.warn(
          `[@chordsketch/react] AST walker has no renderer for TextSpan.kind="${unknownKind}" — placeholder emitted`,
        );
      }
      return (
        <span key={key} data-chordsketch-unknown-span={unknownKind} aria-hidden="true" />
      );
    }
  }
}

function renderSegmentText(segment: ChordproLyricsSegment): ReactNode {
  if (segment.spans.length > 0) {
    return segment.spans.map(renderSpan);
  }
  return segment.text;
}

/**
 * Render a lyric segment as a sequence of per-character spans
 * with optional caret and drop-target highlights.
 *
 * Per-character spans give two things the previous single-text-
 * node rendering could not:
 *
 * 1. **Precise caret placement.** The caret marker is rendered
 *    as a sibling between character spans at the given
 *    `caretCharOffset`. Inline flow positions it EXACTLY on a
 *    character boundary, regardless of proportional-font width
 *    variation — the previous `left: X%` approximation drifted
 *    onto a glyph for offsets near the line center.
 * 2. **Per-character drop highlight.** When the user drags a
 *    chord over a specific character, that character span picks
 *    up `lyric-char--drop-target` and its dashed crimson outline
 *    makes it unambiguous which character the chord will land
 *    above. Far more legible than a thin vertical bar at an
 *    approximate position.
 *
 * Segments that carry structured `{textfont}` spans
 * (`segment.spans.length > 0`) fall back to the simple span
 * renderer — those segments are a vanishingly small fraction of
 * real-world lyrics lines and don't need the affordance.
 */
function renderLyricsTextWithChars(
  segment: ChordproLyricsSegment,
  caretCharOffset: number | null,
  dropCharOffset: number | null,
): ReactNode {
  if (segment.spans.length > 0) {
    return segment.spans.map(renderSpan);
  }
  // Unicode-aware split so combining marks and surrogate pairs
  // stay grouped with their base character.
  const chars = Array.from(segment.text);
  const renderCaret = (key: string): JSX.Element => (
    <span key={key} className="caret-marker" aria-hidden="true" />
  );
  // Drop-target "after the last char" indicator: a zero-width
  // span with the same dashed outline pinned to the right edge.
  // Without this an offset past the segment end would not
  // highlight anything, leaving the user wondering where their
  // chord will land.
  const renderDropEnd = (): JSX.Element => (
    <span
      key="__drop-end"
      className="lyric-char lyric-char--drop-target lyric-char--drop-target-end"
      aria-hidden="true"
    >
      {'​'}
    </span>
  );
  const out: ReactNode[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (caretCharOffset === i) {
      out.push(renderCaret(`__caret-${i}`));
    }
    const isDropTarget = dropCharOffset === i;
    out.push(
      <span
        key={i}
        className={
          isDropTarget ? 'lyric-char lyric-char--drop-target' : 'lyric-char'
        }
      >
        {chars[i]}
      </span>,
    );
  }
  if (caretCharOffset === chars.length) {
    out.push(renderCaret('__caret-end'));
  }
  if (dropCharOffset !== null && dropCharOffset >= chars.length) {
    out.push(renderDropEnd());
  }
  return out;
}

// ---- Chord rendering ----------------------------------------------

/**
 * Replace ASCII accidentals (`b` / `#`) on note letters and
 * chord-quality digits with the proper Unicode musical symbols
 * (`♭` U+266D / `♯` U+266F). Two cases are converted:
 *
 * 1. **Root accidentals** — `[A-G]b` / `[A-G]#` for flat-side
 *    and sharp-side keys (`Bb`, `Eb`, `F#`, …).
 * 2. **Extension accidentals** — `b<digit>` / `#<digit>` for
 *    chord-quality alterations (`b9`, `#11`, `b13`, …),
 *    typically inside parens like `Gb7(b9)` or after a degree
 *    marker like `Cmaj7#11`.
 *
 * Chord-quality letters (`m`, `dim`, `sus`, etc.) and lyrics
 * survive unchanged because they don't match either pattern.
 *
 * Sister-site to `unicode_accidentals` in
 * `crates/chordpro/src/typography.rs`. The two functions MUST
 * produce byte-for-byte identical output for every input — the
 * React JSX walker and every Rust renderer pick up the same
 * typography this way.
 */
export function unicodeAccidentals(name: string): string {
  return name
    .replace(/([A-G])b/g, '$1♭')
    .replace(/([A-G])#/g, '$1♯')
    // After the root pass, any remaining ASCII `b` / `#` that
    // sits IMMEDIATELY before a digit is a quality-alteration
    // marker. Negative lookbehind on `[A-G]` is unnecessary —
    // the root pass already consumed those pairs and replaced
    // the `b`/`#` with their unicode forms, so they can no
    // longer match this regex.
    .replace(/b(?=\d)/g, '♭')
    .replace(/#(?=\d)/g, '♯');
}

function renderChord(chord: ChordproChord): string {
  return unicodeAccidentals(chord.display ?? chord.name);
}

// ---- Grid line tokeniser ------------------------------------------

type GridToken =
  | { kind: 'repeat-start' } // `|:`
  | { kind: 'repeat-end' } // `:|`
  | { kind: 'repeat-both' } // `:|:` (combined repeat end + start)
  | { kind: 'double' } // `||`
  | { kind: 'final' } // `|.`
  | { kind: 'volta'; ending: number } // `|1`, `|2`
  | { kind: 'barline' } // bare `|`
  | { kind: 'cell'; names: string[] } // chord cell (may contain `~`-separated multi-chord)
  | { kind: 'percent1' } // `%` — repeat previous measure
  | { kind: 'percent2' } // `%%` — repeat previous two measures
  | { kind: 'continuation' } // `.`
  | { kind: 'no-chord' } // `n` (rare, but iRealPro convention)
  | { kind: 'space' };

/**
 * Tokenise a ChordPro grid line into structured pieces the
 * walker can lay out as iReal Pro-style bars. Handles every
 * spec-defined barline marker (`|:` / `:|` / `:|:` / `||` /
 * `|.` / `|1` / `|2`), beat continuation (`.`), and the
 * spec-defined measure-repeat cells `%` (repeat previous
 * measure) and `%%` (repeat previous two measures).
 *
 * Cells (chord names + strum tokens + custom dialect tokens)
 * are emitted as `{ kind: 'cell', names: [...] }`; the names
 * array carries the `~`-separated parts so a `C~G` cell
 * yields `names: ['C', 'G']`. The renderer decides chord-vs-
 * strum rendering by inspecting the row's first cell
 * (a leading `s` / `S` marks a strum row).
 *
 * Anything else that survives falls through as a single-name
 * cell carrying the raw text — unrecognised dialect tokens
 * (`~ux`, `d+`, etc.) still render visibly without crashing
 * the tokeniser.
 */
export function tokenizeGridLine(input: string): GridToken[] {
  const out: GridToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t') {
      // Coalesce whitespace runs into one "space" token — the
      // CSS handles the visual gap, we don't need N adjacent
      // spaces in the DOM.
      while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
      out.push({ kind: 'space' });
      continue;
    }
    if (ch === '|') {
      const next = input[i + 1];
      if (next === ':') {
        out.push({ kind: 'repeat-start' });
        i += 2;
        continue;
      }
      if (next === '.') {
        out.push({ kind: 'final' });
        i += 2;
        continue;
      }
      if (next === '|') {
        out.push({ kind: 'double' });
        i += 2;
        continue;
      }
      if (next != null && /[1-9]/.test(next)) {
        out.push({ kind: 'volta', ending: Number.parseInt(next, 10) });
        i += 2;
        continue;
      }
      out.push({ kind: 'barline' });
      i += 1;
      continue;
    }
    if (ch === ':' && input[i + 1] === '|') {
      // `:|:` is the combined end-of-repeat + start-of-repeat
      // marker (a single visual glyph in standard notation).
      // Must be checked BEFORE the bare `:|` arm so the
      // trailing `:` is consumed in the same token.
      if (input[i + 2] === ':') {
        out.push({ kind: 'repeat-both' });
        i += 3;
        continue;
      }
      out.push({ kind: 'repeat-end' });
      i += 2;
      continue;
    }
    // Standalone `%` / `%%` measure-repeat markers. Spec-
    // defined: `%` repeats the previous measure, `%%` repeats
    // the previous two measures. They occupy a cell slot in
    // their own right, so they parse here ahead of the
    // generic cell-text path.
    if (ch === '%') {
      if (input[i + 1] === '%') {
        out.push({ kind: 'percent2' });
        i += 2;
        continue;
      }
      out.push({ kind: 'percent1' });
      i += 1;
      continue;
    }
    if (ch === '.') {
      out.push({ kind: 'continuation' });
      i += 1;
      continue;
    }
    if (ch === 'n' && (i + 1 >= input.length || /[\s|]/.test(input[i + 1]!))) {
      out.push({ kind: 'no-chord' });
      i += 1;
      continue;
    }
    // Read a cell token — any contiguous run of non-whitespace
    // non-bar / non-colon characters. Chord brackets `[X]` are
    // unwrapped: the parser produces a chord-bearing lyrics
    // segment, but for grid lines we get the raw text, so let
    // `[`...`]` survive as a chord name and trim the brackets
    // ourselves.
    let j = i;
    while (j < input.length && !/[\s|:]/.test(input[j]!)) j++;
    let raw = input.slice(i, j);
    if (raw.startsWith('[') && raw.endsWith(']')) {
      raw = raw.slice(1, -1);
    }
    if (raw.length > 0) {
      // Split on `~` to surface the spec's cell-internal
      // multi-chord separator. `C~G` → ['C', 'G']. Bare
      // tokens with no `~` produce a single-element array.
      // Empty parts (from a leading or trailing `~`) are
      // preserved as empty strings — the renderer can decide
      // how to display them (typically an anticipation tick).
      const names = raw.split('~');
      out.push({ kind: 'cell', names });
    }
    i = j;
  }
  return out;
}

/**
 * Render a `{start_of_grid}` body line as a structured row of
 * bars + barlines + chord cells. Sister-site to the Rust HTML
 * renderer — the markup matches what `crates/render-html`'s
 * grid-line emitter produces so both surfaces pick up the same
 * `.grid-*` CSS rules.
 */
function renderGridLine(line: ChordproLyricsLine, key: number): JSX.Element {
  // Reconstruct the raw source text from the AST. Chord segments
  // re-acquire their `[name]` brackets so the tokeniser can
  // recognise them; pure-text segments pass through verbatim.
  const raw = line.segments
    .map((s) => {
      if (s.chord) {
        return `[${unicodeAccidentals(renderChord(s.chord))}]${s.text}`;
      }
      return s.text;
    })
    .join('');
  const tokens = tokenizeGridLine(raw);

  // Split the flat token stream into three buckets:
  //
  // 1. `labelTokens` — content BEFORE the first barline. These
  //    are dialect "row labels" (e.g. `A`, `Coda`) commonly
  //    seen at the start of a grid row in jazz lead-sheet
  //    style. Not formally in the ChordPro spec but widely
  //    used; rendered as a left-side label cell.
  // 2. `bodyTokens` — the actual bar/cell stream between the
  //    first and last barlines.
  // 3. `commentTokens` — content AFTER the last barline. These
  //    are dialect "trailing comments" (e.g. `repeat 4 times`)
  //    that annotate the row's musical meaning. Rendered as a
  //    right-side comment cell.
  const BARLINE_KINDS: Array<GridToken['kind']> = [
    'barline',
    'repeat-start',
    'repeat-end',
    'repeat-both',
    'double',
    'final',
    'volta',
  ];
  const firstBar = tokens.findIndex((t) => BARLINE_KINDS.includes(t.kind));
  const lastBar = (() => {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (BARLINE_KINDS.includes(tokens[i]!.kind)) return i;
    }
    return -1;
  })();
  const labelTokens = firstBar > 0 ? tokens.slice(0, firstBar) : [];
  const bodyTokens =
    firstBar >= 0 && lastBar >= firstBar ? tokens.slice(firstBar, lastBar + 1) : tokens;
  const commentTokens = lastBar >= 0 && lastBar < tokens.length - 1
    ? tokens.slice(lastBar + 1)
    : [];

  // Strum row detection: a `s` / `S` cell IMMEDIATELY after the
  // opening barline marks the row as a strum-pattern row (per
  // the ChordPro spec's strum-row convention). Detect by
  // scanning bodyTokens — skip the leading barline + any space,
  // then check if the next cell's first name is `s` / `S`.
  let isStrumRow = false;
  let strumMarkerIndex = -1;
  for (let i = 0; i < bodyTokens.length; i++) {
    const t = bodyTokens[i]!;
    if (BARLINE_KINDS.includes(t.kind)) continue;
    if (t.kind === 'space') continue;
    if (t.kind === 'cell' && t.names.length === 1 && /^[sS]$/.test(t.names[0]!)) {
      isStrumRow = true;
      strumMarkerIndex = i;
    }
    break;
  }

  // Drop the `s` strum-row marker from the body stream — it's
  // not a musical cell, just a row-type marker.
  const renderableBody = isStrumRow
    ? bodyTokens.filter((_, i) => i !== strumMarkerIndex)
    : bodyTokens;

  // Group the body stream into bars + barlines. Each cell-bearing
  // token (cell / percent1 / percent2 / continuation / no-chord)
  // contributes a beat slot to the current bar; barline tokens
  // flush the current bar and emit a marker.
  type BeatSlot =
    | { kind: 'chord'; names: string[] }
    | { kind: 'strum'; raw: string }
    | { kind: 'continuation' }
    | { kind: 'percent1' }
    | { kind: 'percent2' };
  type Bar = { kind: 'bar'; beats: BeatSlot[]; noChord: boolean };
  type Marker =
    | { kind: 'repeat-start' }
    | { kind: 'repeat-end' }
    | { kind: 'repeat-both' }
    | { kind: 'double' }
    | { kind: 'final' }
    | { kind: 'volta'; ending: number }
    | { kind: 'barline' };
  type Cell = Bar | Marker;
  const cells: Cell[] = [];
  let current: Bar | null = null;
  const ensureBar = (): Bar => {
    if (!current) current = { kind: 'bar', beats: [], noChord: false };
    return current;
  };
  const flush = () => {
    if (current && (current.beats.length > 0 || current.noChord)) {
      cells.push(current);
    }
    current = null;
  };
  for (const tok of renderableBody) {
    switch (tok.kind) {
      case 'space':
        // No content; ignore — whitespace is presentation only.
        break;
      case 'cell':
        if (isStrumRow) {
          ensureBar().beats.push({ kind: 'strum', raw: tok.names.join('~') });
        } else {
          ensureBar().beats.push({ kind: 'chord', names: tok.names });
        }
        break;
      case 'percent1':
        ensureBar().beats.push({ kind: 'percent1' });
        break;
      case 'percent2':
        ensureBar().beats.push({ kind: 'percent2' });
        break;
      case 'continuation':
        // A `.` beat keeps the previous chord ringing — emit a
        // continuation slot so the bar layout still allocates
        // space for this beat.
        ensureBar().beats.push({ kind: 'continuation' });
        break;
      case 'no-chord':
        ensureBar().noChord = true;
        break;
      case 'repeat-start':
      case 'repeat-end':
      case 'repeat-both':
      case 'double':
      case 'final':
      case 'volta':
      case 'barline':
        flush();
        cells.push(tok);
        break;
    }
  }
  flush();

  const renderMarker = (m: Marker, idx: number): JSX.Element => {
    switch (m.kind) {
      case 'repeat-start':
        return (
          <span
            key={idx}
            className="grid-barline grid-barline--repeat-start"
            aria-label="repeat start"
          >
            <span className="grid-barline__line grid-barline__line--thick" />
            <span className="grid-barline__line" />
            <span className="grid-barline__dots">
              <span />
              <span />
            </span>
          </span>
        );
      case 'repeat-end':
        return (
          <span
            key={idx}
            className="grid-barline grid-barline--repeat-end"
            aria-label="repeat end"
          >
            <span className="grid-barline__dots">
              <span />
              <span />
            </span>
            <span className="grid-barline__line" />
            <span className="grid-barline__line grid-barline__line--thick" />
          </span>
        );
      case 'repeat-both':
        // Combined end + start: dots on both sides of a
        // thick-line pair. Reads as a single glyph in
        // standard music notation.
        return (
          <span
            key={idx}
            className="grid-barline grid-barline--repeat-both"
            aria-label="repeat end and start"
          >
            <span className="grid-barline__dots">
              <span />
              <span />
            </span>
            <span className="grid-barline__line grid-barline__line--thick" />
            <span className="grid-barline__line grid-barline__line--thick" />
            <span className="grid-barline__dots">
              <span />
              <span />
            </span>
          </span>
        );
      case 'double':
        return (
          <span key={idx} className="grid-barline grid-barline--double" aria-hidden="true">
            <span className="grid-barline__line" />
            <span className="grid-barline__line" />
          </span>
        );
      case 'final':
        return (
          <span key={idx} className="grid-barline grid-barline--final" aria-label="final barline">
            <span className="grid-barline__line" />
            <span className="grid-barline__line grid-barline__line--thick" />
          </span>
        );
      case 'volta':
        return (
          <span key={idx} className="grid-volta" aria-label={`${m.ending} ending`}>
            <span className="grid-volta__bracket">
              <span className="grid-volta__cap" />
              <span className="grid-volta__label">{m.ending}.</span>
            </span>
            <span className="grid-barline__line" />
          </span>
        );
      case 'barline':
        return <span key={idx} className="grid-barline" aria-hidden="true" />;
    }
  };

  // Render the contents of a single beat slot (chord-row or
  // strum-row variant) inside a `.grid-beat` cell.
  const renderBeat = (slot: BeatSlot, idx: number): JSX.Element => {
    switch (slot.kind) {
      case 'chord':
        if (slot.names.length === 1) {
          return (
            <span key={idx} className="grid-beat">
              <span className="grid-chord">{unicodeAccidentals(slot.names[0]!)}</span>
            </span>
          );
        }
        // Multi-chord cell (`C~G` etc.): chords separated by a
        // thin glyph so the reader still sees them as one
        // beat-slot worth of harmonic content.
        return (
          <span key={idx} className="grid-beat grid-beat--multi">
            {slot.names.map((name, ni) => (
              <Fragment key={ni}>
                {ni > 0 ? (
                  <span className="grid-chord__sep" aria-hidden="true">
                    ~
                  </span>
                ) : null}
                <span className="grid-chord">
                  {name.length > 0 ? unicodeAccidentals(name) : ''}
                </span>
              </Fragment>
            ))}
          </span>
        );
      case 'strum':
        return (
          <span key={idx} className={`grid-beat grid-strum ${strumClassFor(slot.raw)}`}>
            <span className="grid-strum__glyph" aria-hidden="true">
              {strumGlyphFor(slot.raw)}
            </span>
            <span className="sr-only">{slot.raw}</span>
          </span>
        );
      case 'continuation':
        return <span key={idx} className="grid-beat" />;
      case 'percent1':
        return (
          <span key={idx} className="grid-beat grid-beat--percent1" aria-label="repeat previous bar">
            <span className="grid-percent" aria-hidden="true">%</span>
          </span>
        );
      case 'percent2':
        return (
          <span key={idx} className="grid-beat grid-beat--percent2" aria-label="repeat previous two bars">
            <span className="grid-percent" aria-hidden="true">%%</span>
          </span>
        );
    }
  };

  // Render row label / trailing comment text (whitespace stripped,
  // tokens rejoined with single spaces). The label / comment
  // bucket can contain stray spaces, dots, cells — preserve them
  // joined as text.
  const renderLabel = (toks: GridToken[]): string =>
    toks
      .map((t) => {
        if (t.kind === 'space') return ' ';
        if (t.kind === 'cell') return t.names.join('~');
        if (t.kind === 'continuation') return '.';
        if (t.kind === 'percent1') return '%';
        if (t.kind === 'percent2') return '%%';
        return '';
      })
      .join('')
      .trim();
  const labelText = renderLabel(labelTokens);
  const commentText = renderLabel(commentTokens);

  return (
    <div key={key} className={isStrumRow ? 'grid-line grid-line--strum' : 'grid-line'}>
      {labelText.length > 0 ? (
        <span className="grid-row__label">{labelText}</span>
      ) : null}
      {cells.map((cell, idx) => {
        if (cell.kind === 'bar') {
          // Each bar lays out one beat slot per source token
          // (`cell` or `.`). The bar width is split equally
          // between slots so a `G . C .` bar puts G under
          // beat 1 and C under beat 3 — matching standard
          // chord-chart engraving where the chord prints over
          // the beat it starts on. A pure `G . . .` bar
          // anchors G in slot 1 and leaves the rest empty
          // (the chord continues to ring).
          const beats = cell.beats.length > 0 ? cell.beats : [{ kind: 'continuation' as const }];
          return (
            <span key={idx} className="grid-bar" data-beats={beats.length}>
              {cell.noChord ? (
                <span className="grid-no-chord" aria-label="no chord">
                  N.C.
                </span>
              ) : (
                beats.map((b, bi) => renderBeat(b, bi))
              )}
            </span>
          );
        }
        return renderMarker(cell, idx);
      })}
      {commentText.length > 0 ? (
        <span className="grid-row__comment">{commentText}</span>
      ) : null}
    </div>
  );
}

/**
 * Map a strum token to a CSS class suffix. Spec-defined tokens
 * (`up`/`u`, `dn`/`d`, `u+`, `d+`, `ua`, `da`) map directly;
 * tilde-prefixed and dialect variants (`~dn`, `dn~up`, `~ux`,
 * `d+~u+`) inherit a `--custom` class that the renderer styles
 * as a free-form token. Always returns at least
 * `grid-strum--token`.
 */
function strumClassFor(raw: string): string {
  // Strip a leading `~` (anticipation prefix) for class-naming
  // purposes; keep the modifier as a separate class.
  const anticipated = raw.startsWith('~');
  const stripped = anticipated ? raw.slice(1) : raw;
  const base = (() => {
    if (/^(up|u)$/i.test(stripped)) return 'grid-strum--up';
    if (/^(dn|d)$/i.test(stripped)) return 'grid-strum--down';
    if (/^u\+$/i.test(stripped)) return 'grid-strum--up-accent';
    if (/^d\+$/i.test(stripped)) return 'grid-strum--down-accent';
    if (/^ua$/i.test(stripped)) return 'grid-strum--up-arpeggio';
    if (/^da$/i.test(stripped)) return 'grid-strum--down-arpeggio';
    return 'grid-strum--custom';
  })();
  return anticipated ? `${base} grid-strum--anticipated` : base;
}

/**
 * Visual glyph for a strum token. Returns a short arrow / mark
 * sequence the renderer drops into a `.grid-strum__glyph` span.
 * Spec-defined tokens get the conventional arrow glyphs; tilde-
 * prefixed and dialect-only tokens fall back to the raw text
 * (with `~` rendered as a leading tilde so the reader sees the
 * source intent).
 */
function strumGlyphFor(raw: string): string {
  const anticipated = raw.startsWith('~');
  const stripped = anticipated ? raw.slice(1) : raw;
  const ant = anticipated ? '~' : '';
  if (/^(up|u)$/i.test(stripped)) return `${ant}↑`;
  if (/^(dn|d)$/i.test(stripped)) return `${ant}↓`;
  if (/^u\+$/i.test(stripped)) return `${ant}↑+`;
  if (/^d\+$/i.test(stripped)) return `${ant}↓+`;
  if (/^ua$/i.test(stripped)) return `${ant}↑·`;
  if (/^da$/i.test(stripped)) return `${ant}↓·`;
  // Dialect variants (`dn~up`, `~ux`, `d+~u+`, etc.) — pass
  // through verbatim so the reader still sees the source intent.
  return raw;
}

/**
 * Caret-marker positioning for a lyrics line. Source-column /
 * source-length is a poor proxy for the rendered position on a
 * chord-bearing lyrics line — `[Am]Hello` is 8 source characters
 * but renders as just "Hello" (5 visible characters) with "Am"
 * floating in the chord row above. A naive `column / length`
 * places the caret several characters to the RIGHT of where the
 * editor actually sits.
 *
 * Walk the segments and remap the source column to its
 * "lyrics column" (counting only characters that survive into
 * the rendered lyrics row). Returns a 0..1 ratio of
 * `lyrics_column / total_lyrics_length`. Falls back to the
 * naive source-column ratio when the line has no chords (in
 * which case the two are equivalent anyway).
 */
export function lyricsCaretRatio(
  line: ChordproLyricsLine,
  caretColumn: number,
  caretLineLength: number,
): number {
  // Total rendered-lyrics character count.
  let totalLyrics = 0;
  for (const seg of line.segments) totalLyrics += seg.text.length;
  if (totalLyrics === 0) {
    // Chord-only line (no lyrics text at all). Fall back to the
    // raw source ratio so the marker isn't pinned to the left.
    return Math.min(1, Math.max(0, caretColumn / Math.max(1, caretLineLength)));
  }
  // Reconstruct each segment's source span by simulating the
  // `[chord]text` source layout the parser consumed. The AST
  // doesn't record per-segment source offsets, so we compute
  // them assuming the canonical chord-bracket form
  // (`[name]text`). This holds for the editor's source text
  // (which is what the caret column refers to).
  let sourcePos = 0;
  let lyricsCount = 0;
  for (const seg of line.segments) {
    if (seg.chord) {
      const chordSourceLen = (seg.chord.name?.length ?? 0) + 2; // `[` + name + `]`
      const chordStart = sourcePos;
      const chordEnd = sourcePos + chordSourceLen;
      if (caretColumn >= chordStart && caretColumn < chordEnd) {
        // Caret sits inside the chord bracket — visually it
        // belongs at the lyrics column where the chord sits, i.e.
        // the START of this segment's text in the lyrics row.
        return totalLyrics === 0 ? 0 : lyricsCount / totalLyrics;
      }
      sourcePos = chordEnd;
    }
    const textStart = sourcePos;
    const textEnd = sourcePos + seg.text.length;
    if (caretColumn >= textStart && caretColumn <= textEnd) {
      const within = caretColumn - textStart;
      return (lyricsCount + within) / totalLyrics;
    }
    sourcePos = textEnd;
    lyricsCount += seg.text.length;
  }
  // Caret is past the last segment (trailing whitespace / line
  // end) — pin to the rightmost lyrics column.
  return 1;
}

/**
 * Two-lane caret placement for a chord-bearing lyrics line. A
 * chord-bearing line renders as two stacked rows per segment:
 * the upper `.chord` row (e.g. "Am") and the lower `.lyrics`
 * row (e.g. "Hello"). The editor caret sits in one or the other
 * depending on whether it's inside the source `[chord]` bracket
 * or in the lyric text — collapsing both rows into a single
 * horizontal ratio (as `lyricsCaretRatio` does) loses that
 * upper-vs-lower distinction, which is the information a singer
 * or transcriber actually wants to see in the preview.
 *
 * Returns one of:
 * - `{ row: 'chord', segmentIdx, withinRatio }` — caret inside
 *   `[Am]`; marker goes on the chord row of segment `segmentIdx`
 *   at `withinRatio` across the chord text width.
 * - `{ row: 'lyrics', segmentIdx, charOffset, segmentLength }` —
 *   caret on lyric text; the marker is inserted BETWEEN the
 *   `(charOffset-1)`-th and `charOffset`-th character spans so
 *   it sits exactly on a character boundary (no proportional-
 *   font drift onto a glyph).
 * - `{ row: 'line', lineRatio }` — chord-less line; the
 *   underlying `.chord-block` has no chord row, so the marker
 *   falls back to a single line-level horizontal position.
 *   `lineRatio` is the raw source-column / line-length ratio.
 */
export type CaretPlacement =
  | { row: 'chord'; segmentIdx: number; withinRatio: number }
  | {
      row: 'lyrics';
      segmentIdx: number;
      /**
       * 0-indexed character offset within the segment's lyric
       * text. `0` = before the first character, `text.length` =
       * after the last character. Used to position the caret
       * BETWEEN character spans precisely — the previous
       * `withinRatio` approximation drifted into the middle of
       * a character under proportional fonts.
       */
      charOffset: number;
      /** Segment's lyric text length. */
      segmentLength: number;
    }
  | { row: 'line'; lineRatio: number };

/**
 * Walk a lyrics line's segments and decide where the in-preview
 * caret marker should land — chord row, lyrics row, or
 * fallback-line. See `CaretPlacement` for the shape of the
 * answer.
 *
 * Source-column mapping mirrors `lyricsCaretRatio`: each chord
 * bracket occupies `[name].length + 2` source columns; the lyric
 * text follows immediately. Caret columns that fall past the
 * last segment pin to the right edge of the last lyric row (or
 * the chord row for chord-only lines).
 */
export function caretPlacement(
  line: ChordproLyricsLine,
  caretColumn: number,
  caretLineLength: number,
): CaretPlacement {
  const lineHasChords = line.segments.some((s) => s.chord !== null);
  if (!lineHasChords) {
    return {
      row: 'line',
      lineRatio: Math.min(1, Math.max(0, caretColumn / Math.max(1, caretLineLength))),
    };
  }
  let sourcePos = 0;
  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    if (seg.chord) {
      const nameLen = seg.chord.name?.length ?? 0;
      const chordSourceLen = nameLen + 2; // `[` + name + `]`
      const chordStart = sourcePos;
      const chordEnd = sourcePos + chordSourceLen;
      if (caretColumn >= chordStart && caretColumn < chordEnd) {
        // Position the marker across the rendered chord-name text
        // (not the source bracket). Caret on `[` lands at the
        // chord's left edge; on `]` lands at its right edge;
        // anywhere inside maps linearly.
        const insideBracket = Math.max(0, Math.min(nameLen, caretColumn - chordStart - 1));
        return {
          row: 'chord',
          segmentIdx: i,
          withinRatio: nameLen === 0 ? 0 : insideBracket / nameLen,
        };
      }
      sourcePos = chordEnd;
    }
    const textStart = sourcePos;
    const textEnd = sourcePos + seg.text.length;
    if (caretColumn >= textStart && caretColumn <= textEnd) {
      const within = caretColumn - textStart;
      return {
        row: 'lyrics',
        segmentIdx: i,
        charOffset: within,
        segmentLength: seg.text.length,
      };
    }
    sourcePos = textEnd;
  }
  // Past the last segment (trailing whitespace / line end).
  // Pin to the rightmost row of the last segment — prefer
  // lyrics row when present, fall back to chord row for chord-
  // only segments.
  const lastIdx = line.segments.length - 1;
  const lastSeg = line.segments[lastIdx];
  if (lastSeg && lastSeg.text.length === 0 && lastSeg.chord) {
    return { row: 'chord', segmentIdx: lastIdx, withinRatio: 1 };
  }
  return {
    row: 'lyrics',
    segmentIdx: lastIdx,
    charOffset: lastSeg?.text.length ?? 0,
    segmentLength: lastSeg?.text.length ?? 0,
  };
}

// ---- Lyrics line ---------------------------------------------------

function renderLyricsLine(
  line: ChordproLyricsLine,
  key: number,
  fmt: FormattingState,
  /** Override style applied to `.lyrics` when the line sits
   * inside a `section.tab` / `section.grid` — those families
   * use the `tab` / `grid` element styles for body content
   * instead of `text`. */
  lyricsOverride: CSSProperties | null = null,
  /** Caret placement for the in-preview marker. */
  caret: CaretPlacement | null = null,
  /** Chord drag-and-drop context. */
  reposition: {
    sourceLine: number;
    onChordReposition: (event: ChordRepositionEvent) => void;
  } | null = null,
): JSX.Element {
  return (
    <LyricsLine
      key={key}
      line={line}
      fmt={fmt}
      lyricsOverride={lyricsOverride}
      caret={caret}
      reposition={reposition}
      className="line"
    />
  );
}

interface LyricsLineProps {
  line: ChordproLyricsLine;
  fmt: FormattingState;
  lyricsOverride: CSSProperties | null;
  caret: CaretPlacement | null;
  reposition: {
    sourceLine: number;
    onChordReposition: (event: ChordRepositionEvent) => void;
  } | null;
  /** Class name applied to the root `.line` div. `pushElement`
   * threads `line line--active` here when the line matches
   * `activeSourceLine`; otherwise the caller passes `"line"`. */
  className?: string;
  /** 1-indexed source line decoration applied to the root `.line`
   * div by `pushElement` for the editor↔preview caret-sync wire. */
  'data-source-line'?: number;
}

interface DropTarget {
  segmentIdx: number;
  charOffset: number;
}

/**
 * Stateful body of a chord-bearing or chord-less lyrics line.
 * Promoted from a plain function builder to a real component so
 * it can hold the drag-over drop-indicator state — without
 * that state every dragover would have to re-render the whole
 * walker tree.
 *
 * The `.line` root is the drop target (not individual `.lyrics`
 * spans) so dropping ANYWHERE on the line — chord row, lyric
 * row, or the visual gap between segments — works. The drop
 * coordinate is computed by walking from `event.target` up to
 * the nearest `.chord-block` ancestor, locating its `.lyrics`
 * sibling, and mapping the pointer X to a character offset
 * inside that lyric text via the standard caret-from-point
 * APIs. So a drop on the chord row "Am" lands on the lyric
 * character DIRECTLY BELOW "Am" — what the eye expects.
 *
 * While a drag is active, a `<span class="drop-indicator">` is
 * rendered inside the matching `.lyrics` so the user sees
 * precisely which lyric character the chord will land on.
 */
function LyricsLine({
  line,
  fmt,
  lyricsOverride,
  caret,
  reposition,
  className,
  'data-source-line': dataSourceLine,
}: LyricsLineProps): JSX.Element {
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Pre-walk segments to record per-chord source columns and
  // per-segment lyrics-offset starts. Memoised so dragover-driven
  // re-renders don't re-walk on every event.
  const segmentLayout = useMemo(() => {
    const layout: Array<{
      chordSourceColumn: number;
      chordBracketLength: number;
      lyricsOffsetStart: number;
    }> = [];
    let srcCol = 0;
    let lyricsCount = 0;
    for (const seg of line.segments) {
      const bracketLen = seg.chord ? (seg.chord.name?.length ?? 0) + 2 : 0;
      layout.push({
        chordSourceColumn: srcCol,
        chordBracketLength: bracketLen,
        lyricsOffsetStart: lyricsCount,
      });
      srcCol += bracketLen + seg.text.length;
      lyricsCount += seg.text.length;
    }
    return layout;
  }, [line.segments]);

  const lineHasChords = line.segments.some((s) => s.chord !== null);
  const chordStyle = elementStyleToCss(fmt.chord);
  const textStyle = lyricsOverride ?? elementStyleToCss(fmt.text);

  // Caret marker injection — chord row vs lyrics row. The
  // marker uses `position: absolute` and relies on the parent
  // `.chord` / `.lyrics` being `position: relative` (set in
  // `styles.css`).
  const renderMarker = (ratio: number): JSX.Element => (
    <span
      key="__caret-marker"
      className="caret-marker"
      aria-hidden="true"
      style={{ left: `${ratio * 100}%` }}
    />
  );

  // Line-level drop handlers. Attached to the `.line` root so a
  // drop on EITHER row (chord or lyrics) of EITHER segment lands
  // on the correct character. Without this consolidation,
  // dropping on the chord-row `.chord` span would be a no-op
  // and the user would have to aim at the narrow `.lyrics` row.
  const handleLineDragOver = reposition
    ? (event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes(CHORD_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
        const target = findDropTargetInLine(event, line.segments);
        if (target) setDropTarget(target);
      }
    : undefined;

  const handleLineDragLeave = reposition
    ? (event: ReactDragEvent<HTMLDivElement>) => {
        // Only clear when leaving the whole line. Crossing into a
        // descendant fires dragleave on the parent with
        // `relatedTarget` set to the descendant; the indicator
        // should stay visible in that case.
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDropTarget(null);
      }
    : undefined;

  const handleLineDrop = reposition
    ? (event: ReactDragEvent<HTMLDivElement>) => {
        const raw = event.dataTransfer.getData(CHORD_DRAG_MIME);
        if (!raw) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          setDropTarget(null);
          return;
        }
        // Validate the payload before touching the editor
        // source. A cross-origin drag source can forge our
        // mime; the schema check is the trust boundary.
        if (!isValidChordDragPayload(parsed)) {
          setDropTarget(null);
          return;
        }
        const payload = parsed;
        event.preventDefault();
        const target = findDropTargetInLine(event, line.segments);
        setDropTarget(null);
        if (!target) return;
        const segLayout = segmentLayout[target.segmentIdx];
        reposition.onChordReposition({
          fromLine: payload.fromLine,
          fromColumn: payload.fromColumn,
          fromLength: payload.fromLength,
          toLine: reposition.sourceLine,
          toLyricsOffset: segLayout.lyricsOffsetStart + target.charOffset,
          chord: payload.chord,
          copy: event.altKey,
        });
      }
    : undefined;

  // Line-level caret marker for chord-less lines (`caret.row ===
  // 'line'`). For chord-bearing lines this branch is unused —
  // the marker is embedded inside the matching `.chord` /
  // `.lyrics` sub-element below.
  const lineMarker =
    caret && caret.row === 'line' ? renderMarker(caret.lineRatio) : null;
  return (
    <div
      className={className ?? 'line'}
      data-source-line={dataSourceLine}
      onDragOver={handleLineDragOver}
      onDragLeave={handleLineDragLeave}
      onDrop={handleLineDrop}
    >
      {lineMarker}
      {line.segments.map((segment, i) => {
        const chordMarker =
          caret && caret.row === 'chord' && caret.segmentIdx === i
            ? renderMarker(caret.withinRatio)
            : null;
        const segLayout = segmentLayout[i];
        const chordDragProps =
          reposition && segment.chord
            ? buildChordDragProps(
                segment.chord,
                segLayout.chordSourceColumn,
                segLayout.chordBracketLength,
                reposition.sourceLine,
              )
            : null;
        // Per-segment lyrics-row caret offset (0-indexed
        // character) when the caret lands inside this segment.
        // Inline char-span placement (in `renderLyricsTextWithChars`)
        // uses this to drop the marker BETWEEN characters
        // exactly, rather than at a `left: X%` approximation
        // that drifts onto a glyph under proportional fonts.
        const caretCharOffset =
          caret && caret.row === 'lyrics' && caret.segmentIdx === i
            ? caret.charOffset
            : null;
        // Per-segment drop-target character offset when the
        // user is dragging another chord over this segment.
        // Outlines the targeted character span in a dashed
        // crimson border so the user sees WHICH character
        // the chord will land above, instead of a thin
        // vertical bar at an approximate position.
        const dropCharOffset =
          dropTarget && dropTarget.segmentIdx === i
            ? dropTarget.charOffset
            : null;
        return (
          <span key={i} className="chord-block">
            {segment.chord ? (
              <span
                className="chord"
                style={chordStyle ?? undefined}
                {...(chordDragProps ?? {})}
              >
                {chordMarker}
                {renderChord(segment.chord)}
              </span>
            ) : lineHasChords ? (
              <span
                className="chord"
                aria-hidden="true"
                style={chordStyle ?? undefined}
              >
                {chordMarker}
                {' '}
              </span>
            ) : null}
            <span className="lyrics" style={textStyle ?? undefined}>
              {renderLyricsTextWithChars(segment, caretCharOffset, dropCharOffset)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * From a dragover/drop event, locate which chord-block segment
 * the pointer is over and the character offset (in lyric
 * coordinates) within that segment. Walks up from
 * `event.target` to find the nearest `.chord-block`, then uses
 * the chord-block's `.lyrics` rect — NOT the `.chord` rect — to
 * map the pointer X to a character offset. So a drop on the
 * chord row resolves to the lyric character vertically below
 * it. Returns `null` when no chord-block ancestor is found
 * (the pointer is in the gap between blocks or has left the
 * line).
 */
function findDropTargetInLine(
  event: ReactDragEvent<HTMLDivElement>,
  segments: ChordproLyricsSegment[],
): DropTarget | null {
  let el = event.target as HTMLElement | null;
  while (el && !el.classList?.contains('chord-block')) {
    if (el === event.currentTarget) return null;
    el = el.parentElement;
  }
  if (!el || !el.parentElement) return null;
  const blocks = Array.from(el.parentElement.children).filter((c) =>
    (c as HTMLElement).classList?.contains('chord-block'),
  );
  const segmentIdx = blocks.indexOf(el);
  if (segmentIdx < 0 || segmentIdx >= segments.length) return null;
  const lyricsEl = el.querySelector(':scope > .lyrics') as HTMLElement | null;
  if (!lyricsEl) return null;
  const segmentTextLength = segments[segmentIdx].text.length;
  const charOffset = pointerToLyricCharOffset(
    lyricsEl,
    event.clientX,
    event.clientY,
    segmentTextLength,
  );
  return { segmentIdx, charOffset };
}

/**
 * Build the `draggable` / `onDragStart` props for a `.chord`
 * span. Sets `dataTransfer` with a custom JSON payload
 * describing the chord's source location and the chord name so
 * the drop handler can reconstruct a full
 * `ChordRepositionEvent`. `effectAllowed = 'copyMove'` lets the
 * user's Alt-modifier at drop time select between move and
 * copy semantics.
 */
function buildChordDragProps(
  chord: ChordproChord,
  sourceColumn: number,
  bracketLength: number,
  sourceLine: number,
): {
  draggable: true;
  onDragStart: (event: ReactDragEvent<HTMLSpanElement>) => void;
} {
  const payload: ChordDragPayload = {
    fromLine: sourceLine,
    fromColumn: sourceColumn,
    fromLength: bracketLength,
    chord: chord.name ?? '',
  };
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.setData(CHORD_DRAG_MIME, JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'copyMove';
    },
  };
}

/**
 * Build the `onDragOver` / `onDrop` props for a `.lyrics` span.
 * `onDragOver` gates drops to our own chord drags (no OS-file
 * drags / cross-tab text drags) and reflects the Alt-modifier
 * in the cursor; `onDrop` reads the dragged payload, maps the
 * pointer position to a character offset inside the segment's
 * text, and fires `onChordReposition` with absolute
 * coordinates.
 */
function buildLyricsDropProps(
  onChordReposition: (event: ChordRepositionEvent) => void,
  destinationLine: number,
  lyricsOffsetStart: number,
  segmentTextLength: number,
): {
  onDragOver: (event: ReactDragEvent<HTMLSpanElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLSpanElement>) => void;
} {
  return {
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(CHORD_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    },
    onDrop: (event) => {
      const raw = event.dataTransfer.getData(CHORD_DRAG_MIME);
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      // Schema gate — see `isValidChordDragPayload` doc-comment.
      if (!isValidChordDragPayload(parsed)) return;
      const payload = parsed;
      event.preventDefault();
      const target = event.currentTarget;
      const charOffset = pointerToLyricCharOffset(
        target,
        event.clientX,
        event.clientY,
        segmentTextLength,
      );
      onChordReposition({
        fromLine: payload.fromLine,
        fromColumn: payload.fromColumn,
        fromLength: payload.fromLength,
        toLine: destinationLine,
        toLyricsOffset: lyricsOffsetStart + charOffset,
        chord: payload.chord,
        copy: event.altKey,
      });
    },
  };
}

/** Custom mime type for the chord drag payload — disambiguates
 * our drags from OS file drags and from `text/plain` payloads
 * that other tabs might emit. Kept private to the package. */
const CHORD_DRAG_MIME = 'application/x-chordsketch-chord';

interface ChordDragPayload {
  fromLine: number;
  fromColumn: number;
  fromLength: number;
  chord: string;
}

/**
 * Validate a parsed `ChordDragPayload`. The dataTransfer mime
 * gate (`application/x-chordsketch-chord`) only proves the
 * payload claims to be ours — a cross-origin drag source can
 * forge that mime and stuff arbitrary content into the JSON
 * blob. Without validation, `applyChordReposition` would
 * happily interpolate the payload's `chord` field into the
 * ChordPro source, letting an attacker inject directives like
 * `{image: src="https://evil/?leak"}` via a drag-and-drop
 * gesture.
 *
 * Accepted shape:
 * - `fromLine` — integer ≥ 1
 * - `fromColumn` — integer ≥ 0
 * - `fromLength` — integer ≥ 0
 * - `chord` — non-empty string containing none of `[]{}<\n\r`
 *   (which would corrupt the ChordPro source structure).
 */
function isValidChordDragPayload(value: unknown): value is ChordDragPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (
    typeof p.fromLine !== 'number' ||
    !Number.isInteger(p.fromLine) ||
    p.fromLine < 1
  )
    return false;
  if (
    typeof p.fromColumn !== 'number' ||
    !Number.isInteger(p.fromColumn) ||
    p.fromColumn < 0
  )
    return false;
  if (
    typeof p.fromLength !== 'number' ||
    !Number.isInteger(p.fromLength) ||
    p.fromLength < 0
  )
    return false;
  if (typeof p.chord !== 'string' || p.chord.length === 0) return false;
  // Reject characters that would corrupt the ChordPro source
  // structure when interpolated as `[${chord}]`. ChordPro chord
  // names never contain these characters in any spec form, so
  // rejecting them is safe and prevents directive-injection
  // attacks through the drag payload.
  if (/[\[\]{}<\n\r]/.test(p.chord)) return false;
  return true;
}

/**
 * Resolve a clientX/Y pointer into a character offset within
 * the `<span class="lyrics">` element's text. Uses
 * `caretPositionFromPoint` (Firefox) / `caretRangeFromPoint`
 * (WebKit / Chromium) with a graceful fallback to a
 * width-proportional offset when neither is available. The
 * result is clamped to `[0, segmentTextLength]` so a drop past
 * the segment's visible edge maps to "right after the last
 * character" instead of overshooting into the next segment.
 */
function pointerToLyricCharOffset(
  target: HTMLElement,
  clientX: number,
  clientY: number,
  segmentTextLength: number,
): number {
  // Per-character rendering wraps each lyric char in its own
  // `.lyric-char` span (so each char is a distinct text node).
  // Walking `.lyric-char` siblings and picking the one whose
  // horizontal extent contains the pointer is the most direct
  // way to resolve a drop offset — `caretPositionFromPoint`
  // returns an offset RELATIVE TO whichever single-char text
  // node it lands on (so it's always 0 or 1) and not the full
  // segment offset we need.
  const charSpans = Array.from(
    target.querySelectorAll(':scope > .lyric-char'),
  ) as HTMLElement[];
  if (charSpans.length > 0) {
    for (let i = 0; i < charSpans.length; i++) {
      const r = charSpans[i].getBoundingClientRect();
      // If pointer is past the right edge of this char, keep
      // walking; the next char (or end-of-segment) is the
      // target.
      if (clientX > r.right) continue;
      // Pointer is at or before this char's right edge. Decide
      // which side of the char it lies on: < midpoint → before
      // this char (offset i); ≥ midpoint → after this char
      // (offset i+1).
      const mid = r.left + r.width / 2;
      return clientX < mid ? i : i + 1;
    }
    // Past all chars: pointer is at the far right of the
    // segment.
    return Math.min(segmentTextLength, charSpans.length);
  }
  // Fallback for legacy callers / segments rendered without
  // per-char wrapping (structured-span lyrics). Use the caret-
  // from-point APIs first, then a width-proportional ratio.
  const docAny = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let nodeOffset: number | null = null;
  if (typeof docAny.caretPositionFromPoint === 'function') {
    const pos = docAny.caretPositionFromPoint(clientX, clientY);
    if (pos && target.contains(pos.offsetNode)) nodeOffset = pos.offset;
  } else if (typeof docAny.caretRangeFromPoint === 'function') {
    const range = docAny.caretRangeFromPoint(clientX, clientY);
    if (range && target.contains(range.startContainer)) {
      nodeOffset = range.startOffset;
    }
  }
  if (nodeOffset === null) {
    const rect = target.getBoundingClientRect();
    const ratio =
      rect.width > 0
        ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
        : 0;
    nodeOffset = Math.round(ratio * segmentTextLength);
  }
  return Math.max(0, Math.min(segmentTextLength, nodeOffset));
}

// ---- Comment line --------------------------------------------------

function renderComment(
  style: 'normal' | 'italic' | 'boxed' | 'highlight',
  text: string,
  key: number,
  fmt: FormattingState,
): JSX.Element {
  // Comments pick up the running `.text` style — they sit in the
  // body flow alongside lyric lines, so a `{textfont: ...}` /
  // `{textsize: ...}` directive should affect them in lockstep
  // with the surrounding lyrics. Mirror of the Rust renderer's
  // comment-body style attribution.
  const textStyle = elementStyleToCss(fmt.text);
  if (style === 'boxed') {
    return (
      <div key={key} className="comment-box" style={textStyle ?? undefined}>
        {text}
      </div>
    );
  }
  if (style === 'italic') {
    return (
      <p key={key} className="comment" style={textStyle ?? undefined}>
        <em>{text}</em>
      </p>
    );
  }
  if (style === 'highlight') {
    // `{highlight}` is the spec's stronger sibling of `{comment}` —
    // emit a `.comment.comment--highlight` so consumer stylesheets
    // can paint it distinctly (bold weight + yellow background,
    // etc.) without forking the base `.comment` rules. Sister-site
    // to the HTML renderer's `comment--highlight` class. The text
    // sits inside a `<mark>` so the HTML5 highlight semantics
    // (relevant text marked for reader attention) are conveyed to
    // assistive tech.
    return (
      <p
        key={key}
        className="comment comment--highlight"
        style={textStyle ?? undefined}
      >
        <mark>{text}</mark>
      </p>
    );
  }
  return (
    <p key={key} className="comment" style={textStyle ?? undefined}>
      {text}
    </p>
  );
}

// ---- Image directive -----------------------------------------------

function renderImage(attrs: ChordproImageAttributes, key: number): JSX.Element | null {
  if (!attrs.src || !isSafeHref(attrs.src)) {
    return null;
  }
  // Emit `width` / `height` as HTML attributes — sister-site to
  // `crates/render-html/src/lib.rs::render_image`, which writes
  // `width="64" height="64"` on the `<img>` tag. The previous
  // inline-style path passed unit-less numeric strings to React's
  // `style.width`, which the browser dropped as invalid CSS — so
  // `{image: ... width=64 height=64}` rendered at the asset's
  // natural size instead of the requested box.
  return (
    <img
      key={key}
      src={attrs.src}
      alt={attrs.title ?? ''}
      title={attrs.title ?? undefined}
      width={attrs.width ?? undefined}
      height={attrs.height ?? undefined}
    />
  );
}

// ---- Section state machine ----------------------------------------

const SECTION_TAG_TO_NAME: Partial<Record<ChordproDirectiveKind['tag'], string>> = {
  startOfChorus: 'chorus',
  startOfVerse: 'verse',
  startOfBridge: 'bridge',
  startOfTab: 'tab',
  startOfGrid: 'grid',
  startOfAbc: 'abc',
  startOfLy: 'ly',
  startOfTextblock: 'textblock',
  startOfMusicxml: 'musicxml',
  startOfSvg: 'svg',
};

const END_TAG_TO_NAME: Partial<Record<ChordproDirectiveKind['tag'], string>> = {
  endOfChorus: 'chorus',
  endOfVerse: 'verse',
  endOfBridge: 'bridge',
  endOfTab: 'tab',
  endOfGrid: 'grid',
  endOfAbc: 'abc',
  endOfLy: 'ly',
  endOfTextblock: 'textblock',
  endOfMusicxml: 'musicxml',
  endOfSvg: 'svg',
};

// Default labels for sections that the parser leaves
// label-less. Mirrors the labels emitted by
// `chordsketch-render-html`'s `render_section_open` call sites
// for each section family.
const SECTION_LABEL_DEFAULT: Record<string, string> = {
  chorus: 'Chorus',
  verse: 'Verse',
  bridge: 'Bridge',
  tab: 'Tab',
  grid: 'Grid',
  abc: 'ABC',
  ly: 'Lilypond',
  textblock: 'Textblock',
  musicxml: 'MusicXML',
};

/**
 * CSS-class sanitiser for custom section names — JS port of
 * `crates/render-html/src/lib.rs::sanitize_css_class`. Replaces
 * every non-alphanumeric / non-`-_` character with `-`. Used so
 * `{start_of_my custom section}` lands as
 * `<section class="section-my-custom-section">` on both
 * surfaces (sister-site parity).
 */
function sanitizeCssClass(s: string): string {
  let out = '';
  for (const c of s) {
    if (/[A-Za-z0-9_-]/.test(c)) {
      out += c;
    } else {
      out += '-';
    }
  }
  return out;
}

interface SectionState {
  name: string;
  /** Optional override label from the section-start directive's `value`. */
  label: string | null;
  children: JSX.Element[];
  /** 1-indexed source line of the `start_of_*` directive. */
  startLine: number;
  /**
   * For `{start_of_grid shape="L+MxB+R"}` sections, the parsed
   * shape (margin-left cells + measures × beats + margin-right
   * cells). `null` for non-grid sections or grids without a
   * shape attribute. Per the ChordPro spec the default when
   * omitted is `1+4x4+1`.
   */
  gridShape: GridShape | null;
}

/**
 * Parsed `shape="L+MxB+R"` attribute on `{start_of_grid}`.
 *
 * - `marginLeft` / `marginRight` — cells before / after the
 *   musical content (typically used for the label column and
 *   trailing-comment column).
 * - `measures` × `beats` — body grid dimensions (number of
 *   measures per row × beats per measure).
 *
 * Per the ChordPro spec the default when no shape is given is
 * `1+4x4+1`. Returned by {@link parseGridShape} so renderers
 * can lay out cell columns consistently.
 */
export interface GridShape {
  marginLeft: number;
  measures: number;
  beats: number;
  marginRight: number;
}

/**
 * Extract a `label="..."` attribute from a grid directive's
 * inline value. Sister-site to
 * `chordsketch_chordpro::grid::extract_grid_label`. Returns
 * `null` when no `label` attribute is present so callers can
 * fall back to a default heading.
 */
export function extractGridLabel(raw: string): string | null {
  const quoted = raw.match(/label\s*=\s*"([^"]*)"/i);
  if (quoted) return quoted[1]!;
  const bare = raw.match(/label\s*=\s*([^\s]+)/i);
  if (bare) return bare[1]!;
  return null;
}

/**
 * Parse a `shape="..."` attribute string into a structured
 * `GridShape`. Three spec-defined forms are accepted (sister-
 * site to `chordsketch_chordpro::grid::parse_shape_body`):
 *
 * - `L+MxB+R` — full form (margin-left + measures × beats +
 *   margin-right).
 * - `MxB` — body only; margins default to 0.
 * - `N` — bare cell count; treated as a single measure of N
 *   beats with no margins.
 *
 * Accepts both the bare value and the attribute form
 * (`shape="..."` or `shape=...`). Falls back to the spec
 * default `1+4x4+1` on parse failure.
 */
export function parseGridShape(raw: string): GridShape {
  const DEFAULT: GridShape = { marginLeft: 1, measures: 4, beats: 4, marginRight: 1 };
  const inner = extractShapeInner(raw);
  // Try the full L+MxB+R form first.
  const plus = inner.split('+').map((s) => s.trim());
  if (plus.length === 3) {
    const left = Number.parseInt(plus[0]!, 10);
    const right = Number.parseInt(plus[2]!, 10);
    const body = splitBodyMeasuresBeats(plus[1]!);
    if (Number.isFinite(left) && Number.isFinite(right) && body) {
      return { marginLeft: left, measures: body[0], beats: body[1], marginRight: right };
    }
  } else if (plus.length === 1) {
    // Body-only `MxB` or bare `N` form (margins default to 0).
    const body = splitBodyMeasuresBeats(plus[0]!);
    if (body) {
      return { marginLeft: 0, measures: body[0], beats: body[1], marginRight: 0 };
    }
  }
  return DEFAULT;
}

/** Extract the inner value from `shape="..."` / `shape=...` /
 * bare token. */
function extractShapeInner(raw: string): string {
  const quoted = raw.match(/shape\s*=\s*"([^"]*)"/i);
  if (quoted) return quoted[1]!;
  const bare = raw.match(/shape\s*=\s*([^\s]+)/i);
  if (bare) return bare[1]!;
  return raw.trim();
}

/** Split a body specifier into `[measures, beats]`. */
function splitBodyMeasuresBeats(body: string): [number, number] | null {
  const parts = body.split(/[x*]/i).map((s) => s.trim());
  if (parts.length === 2) {
    const m = Number.parseInt(parts[0]!, 10);
    const b = Number.parseInt(parts[1]!, 10);
    if (Number.isFinite(m) && Number.isFinite(b)) return [m, b];
    return null;
  }
  if (parts.length === 1) {
    // Bare cell count `N` → 1 measure × N beats.
    const n = Number.parseInt(parts[0]!, 10);
    if (Number.isFinite(n)) return [1, n];
  }
  return null;
}

// ---- Header rendering ----------------------------------------------

/** Optional render hints the walker accepts from its caller. */
export interface RenderChordproAstOptions {
  /**
   * Transposed key string when the song has been transposed
   * (computed library-side by `parseChordproWithWarnings*` and
   * returned via `useChordproAst`'s `transposedKey`). When
   * present alongside `metadata.key`, the metadata strip shows
   * "Original Key X · Play Key Y" instead of "Key X" so the
   * user sees both the source and the now-playing key at a
   * glance. Pass `null` to fall back to the single-key form.
   */
  transposedKey?: string | null;
  /**
   * Append a chord-diagram grid showing each unique chord used in
   * the lyrics + each chord declared via `{define}`. Mirrors the
   * `<section class="chord-diagrams">` block
   * `chordsketch-render-html` emits.
   *
   * The directive's value is interpreted per the ChordPro spec
   * (https://www.chordpro.org/chordpro/directives-diagrams/):
   *
   * - **Visibility**: `{diagrams: off}` and `{no_diagrams}`
   *   suppress the grid; any other value (including no value)
   *   re-enables it. Defaults to on per the spec.
   * - **Position**: `bottom` (default), `top`, `right`, `below`
   *   are read off the directive value and forwarded to the
   *   emitted `<section>` as `data-position`. The walker places
   *   `top` at the head of `<div class="song">`; the other three
   *   stay at the tail (CSS in `styles.css` distinguishes
   *   `bottom` vs `below` vs `right` visually).
   * - **Instrument**: `guitar`, `ukulele` / `uke`, `piano` /
   *   `keys` / `keyboard` override the `instrument` field below
   *   for the remainder of the song (mirrors
   *   `chordsketch_chordpro::resolve_diagrams_instrument`).
   *
   * Pass `null` / omit to skip the grid entirely regardless of
   * directive (callers who don't want it never opt in).
   */
  chordDiagrams?: {
    /**
     * Instrument family forwarded to `<ChordDiagram>`. AST values
     * (`{diagrams: piano}` etc.) override this on a song-by-song
     * basis.
     */
    instrument?: ChordDiagramInstrument;
  } | null;
  /**
   * 1-indexed source line that the consumer's editor caret is
   * currently on. The walker tags every body element it emits with
   * a `data-source-line="<n>"` attribute (the `n` is the line's
   * 1-indexed position in the original ChordPro source), and the
   * line whose number matches `activeSourceLine` additionally
   * picks up a `line--active` class on its root element.
   *
   * Pair with the `SourceEditor`'s `onCaretLineChange` callback to
   * wire up bidirectional caret tracking. Omit to disable the
   * tagging entirely (the walker skips both the attribute and the
   * class). The AST's `lines: ChordproLine[]` array is in
   * source-line order, so the walker just passes the array index
   * + 1 through as the attribute value — no separate location
   * metadata is required on the AST itself.
   */
  activeSourceLine?: number;
  /**
   * Optional caret column + line length info paired with
   * `activeSourceLine`. When both are present, the walker drops a
   * thin `<span class="caret-marker">` into the active element at
   * `left: <column / lineLength * 100>%` so the preview shows
   * approximately where the editor caret is, not just which line.
   *
   * Mapping is intentionally approximate: ChordPro source uses
   * `[chord]lyric` notation whose rendered width does NOT line up
   * one-to-one with source columns. The linear approximation is
   * the cheapest visual feedback that still helps readers locate
   * themselves within a long line. Omit either field to fall back
   * to line-only highlighting.
   */
  caretColumn?: number;
  caretLineLength?: number;
  /**
   * Optional callback enabling chord drag-and-drop
   * repositioning. When set, every `.chord` span that carries a
   * real chord becomes a drag source, and every `.lyrics` span
   * becomes a drop target. On drop the walker computes
   * source-coordinate information about the move (from-line +
   * column of the original `[chord]`, target-line + lyrics
   * character offset where the chord should land) and invokes
   * this callback so the consumer can mutate the editor source.
   *
   * Pair with {@link applyChordReposition} (re-exported from
   * `@chordsketch/react/chord-source-edit`) to compute the new
   * source string from a `ChordRepositionEvent`. The default
   * gesture is "move"; users holding Alt/Option get "copy"
   * semantics (the `copy` field on the event reflects this).
   *
   * Omit (or pass `undefined`) to disable drag-and-drop —
   * `.chord` elements stay non-draggable and `.lyrics`
   * elements take no drop handlers.
   */
  onChordReposition?: (event: ChordRepositionEvent) => void;
}

/**
 * Position values the `{diagrams: …}` directive recognises per the
 * ChordPro spec. Forwarded onto the emitted `<section>` as the
 * `data-position` attribute so host CSS can lay the grid out.
 */
export type DiagramsPosition = 'bottom' | 'top' | 'right' | 'below';

/**
 * Result of walking every `{diagrams: …}` / `{no_diagrams}` line in
 * source order and resolving the final visibility / position /
 * instrument the diagram grid should use. Position-dependent values
 * follow last-wins semantics (the spec text says "applies forward
 * until reset", and a single section is emitted at song end with
 * the last value that won).
 */
interface DiagramsState {
  visible: boolean;
  position: DiagramsPosition;
  instrument?: ChordDiagramInstrument;
}

// Collect unique chord names used in lyrics, plus any chord
// names declared via `{define}` / `{chord}`. Mirrors
// `chordsketch-render-html`'s `chord_names` accumulator —
// preserving order of first appearance so the diagram grid
// reads top-to-bottom in source order.
function collectChordNames(song: ChordproSong): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    if (!name) return;
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const line of song.lines) {
    if (line.kind === 'lyrics') {
      for (const seg of line.value.segments) {
        if (seg.chord) add(seg.chord.display ?? seg.chord.name);
      }
    } else if (line.kind === 'directive') {
      const kind = line.value.kind;
      // `{define}` / `{chord}` values lead with the chord name —
      // pluck it so the grid lists explicitly-defined chords
      // even when they don't appear in the lyrics.
      if ((kind.tag === 'define' || kind.tag === 'chordDirective') && line.value.value) {
        const firstWord = line.value.value.trim().split(/\s+/)[0];
        if (firstWord) {
          // Strip the R6.100.0 transposable `[name]` bracket form.
          const unwrapped = firstWord.startsWith('[') && firstWord.endsWith(']')
            ? firstWord.slice(1, -1)
            : firstWord;
          add(unwrapped);
        }
      }
    }
  }
  return out;
}

/**
 * Pull every `{define: <name> <raw>}` directive into a list of
 * `[name, raw]` tuples the wasm `chordDiagramSvgWithDefines`
 * boundary can consume. Mirrors the Rust-side
 * `Song::fretted_defines()` accessor — the rest of the value
 * (`base-fret 1 frets …`) is the diagram spec, the first word
 * is the chord name.
 */
function collectDefines(song: ChordproSong): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of song.lines) {
    if (line.kind !== 'directive') continue;
    if (line.value.kind.tag !== 'define') continue;
    const value = line.value.value;
    if (!value) continue;
    const trimmed = value.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue; // no body → cannot render a diagram
    const rawName = trimmed.substring(0, spaceIdx);
    const raw = trimmed.substring(spaceIdx + 1).trim();
    // Strip the R6.100.0 transposable `[name]` bracket form so
    // the wasm lookup matches the chord names in
    // `collectChordNames` above.
    const name =
      rawName.startsWith('[') && rawName.endsWith(']')
        ? rawName.slice(1, -1)
        : rawName;
    out.push([name, raw]);
  }
  return out;
}

// Font-size clamping range, mirroring `MIN_FONT_SIZE` and
// `MAX_FONT_SIZE` in `crates/render-html/src/lib.rs` and the PDF
// renderer's matching constants. Out-of-range `{textsize: …}` etc.
// values clamp to this band so a degenerate input (e.g.
// `textsize: 99999`) does not blow up the layout.
const MIN_FONT_SIZE = 0.5;
const MAX_FONT_SIZE = 200;

// CSS-value sanitiser. Mirror of
// `crates/render-html/src/lib.rs::sanitize_css_value` —
// alphanumerics + `# . - <space> , % +` survive; everything else
// is dropped. Stops directive payloads from injecting `;`, `}`,
// or url(...) escapes into the inline style we emit.
function sanitizeCssValue(s: string): string {
  let out = '';
  for (const c of s) {
    if (/[A-Za-z0-9]/.test(c) || c === '#' || c === '.' || c === '-' ||
        c === ' ' || c === ',' || c === '%' || c === '+') {
      out += c;
    }
  }
  return out;
}

/** Per-element formatting state for the walker — mirrors
 * `chordsketch-render-html::ElementStyle`. `null` fields fall
 * back to the host's CSS. */
interface ElementStyle {
  font: string | null;
  size: string | null;
  colour: string | null;
}

function emptyElementStyle(): ElementStyle {
  return { font: null, size: null, colour: null };
}

/** Convert an `ElementStyle` to a `React.CSSProperties` object,
 * sanitising values along the way and treating bare-numeric size
 * values as point sizes (matching the Rust renderer). Returns
 * `null` when no style has been set — callers can skip the
 * `style={…}` prop in that case. */
function elementStyleToCss(style: ElementStyle): CSSProperties | null {
  const css: CSSProperties = {};
  if (style.font) css.fontFamily = sanitizeCssValue(style.font);
  if (style.size) {
    const safe = sanitizeCssValue(style.size);
    if (/^\d+$/.test(safe)) {
      css.fontSize = `${safe}pt`;
    } else if (safe.length > 0) {
      css.fontSize = safe;
    }
  }
  if (style.colour) css.color = sanitizeCssValue(style.colour);
  return Object.keys(css).length > 0 ? css : null;
}

/** Snapshot of all element styles tracked by the walker. Each
 * `{Xfont,Xsize,Xcolour}` directive updates the matching field;
 * downstream emitted elements pick up the corresponding inline
 * style. `Header`/`Footer`/`Toc` directives are intentionally
 * absent — they are PDF-only concerns. */
interface FormattingState {
  text: ElementStyle;
  chord: ElementStyle;
  tab: ElementStyle;
  title: ElementStyle;
  chorus: ElementStyle;
  label: ElementStyle;
  grid: ElementStyle;
}

function emptyFormattingState(): FormattingState {
  return {
    text: emptyElementStyle(),
    chord: emptyElementStyle(),
    tab: emptyElementStyle(),
    title: emptyElementStyle(),
    chorus: emptyElementStyle(),
    label: emptyElementStyle(),
    grid: emptyElementStyle(),
  };
}

function cloneFormattingState(s: FormattingState): FormattingState {
  return {
    text: { ...s.text },
    chord: { ...s.chord },
    tab: { ...s.tab },
    title: { ...s.title },
    chorus: { ...s.chorus },
    label: { ...s.label },
    grid: { ...s.grid },
  };
}

/** Clamp a numeric font-size directive payload to the
 * `[MIN_FONT_SIZE, MAX_FONT_SIZE]` band. Non-numeric values
 * pass through unchanged. */
function clampSize(raw: string | null): string | null {
  if (raw === null) return null;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return raw;
  const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, n));
  return String(clamped);
}

/** Apply a `{Xfont}`/`{Xsize}`/`{Xcolour}` directive to the
 * walker's running `FormattingState`. Unrecognised tags are
 * no-ops (the body of `handleDirective` already filters by
 * `tag`). */
function applyFormattingDirective(
  state: FormattingState,
  tag: ChordproDirectiveKind['tag'],
  rawValue: string | null,
): void {
  switch (tag) {
    case 'textFont': state.text.font = rawValue; break;
    case 'textSize': state.text.size = clampSize(rawValue); break;
    case 'textColour': state.text.colour = rawValue; break;
    case 'chordFont': state.chord.font = rawValue; break;
    case 'chordSize': state.chord.size = clampSize(rawValue); break;
    case 'chordColour': state.chord.colour = rawValue; break;
    case 'tabFont': state.tab.font = rawValue; break;
    case 'tabSize': state.tab.size = clampSize(rawValue); break;
    case 'tabColour': state.tab.colour = rawValue; break;
    case 'titleFont': state.title.font = rawValue; break;
    case 'titleSize': state.title.size = clampSize(rawValue); break;
    case 'titleColour': state.title.colour = rawValue; break;
    case 'chorusFont': state.chorus.font = rawValue; break;
    case 'chorusSize': state.chorus.size = clampSize(rawValue); break;
    case 'chorusColour': state.chorus.colour = rawValue; break;
    case 'labelFont': state.label.font = rawValue; break;
    case 'labelSize': state.label.size = clampSize(rawValue); break;
    case 'labelColour': state.label.colour = rawValue; break;
    case 'gridFont': state.grid.font = rawValue; break;
    case 'gridSize': state.grid.size = clampSize(rawValue); break;
    case 'gridColour': state.grid.colour = rawValue; break;
    // Header / footer / toc directives are PDF-only — silently
    // skip on the React surface.
    default: break;
  }
}

/** Pre-walk the AST to compute the formatting state at the
 * *start* of the song body — for `renderHeader`, which fires
 * before line-walking begins. Title-related directives that
 * appear before the first lyric / section line take effect on
 * the header; anything after that point shows up after the
 * header is emitted, so the headline keeps the pre-body state. */
function computeHeaderFormattingState(song: ChordproSong): FormattingState {
  const state = emptyFormattingState();
  for (const line of song.lines) {
    if (line.kind === 'lyrics') break;
    if (line.kind !== 'directive') continue;
    applyFormattingDirective(state, line.value.kind.tag, line.value.value);
  }
  return state;
}

// Sets of recognised `{diagrams: <ctl>}` arguments. Pulled out as
// module-level constants so the parser arms and the test suite can
// share a single source of truth.
const DIAGRAMS_OFF_VALUES = new Set(['off', 'false', '0', 'no']);
const DIAGRAMS_POSITIONS = new Set<DiagramsPosition>([
  'bottom',
  'top',
  'right',
  'below',
]);

// Translate AST-stored instrument shorthand to the canonical
// `ChordDiagramInstrument` value. Mirrors the equivalent map in
// `chordsketch_chordpro::resolve_diagrams_instrument` so a
// `{diagrams: piano}` line behaves identically in Rust and React
// surfaces (per `.claude/rules/renderer-parity.md` §Sanitizer /
// AST-arm parity). Returns `undefined` for values that are NOT
// instrument names — the caller falls back to the consumer's
// `chordDiagramsInstrument` prop.
function diagramsValueAsInstrument(
  raw: string,
): ChordDiagramInstrument | undefined {
  switch (raw) {
    case 'guitar':
      return 'guitar';
    case 'ukulele':
    case 'uke':
      return 'ukulele';
    case 'piano':
    case 'keyboard':
    case 'keys':
      return 'piano';
    default:
      return undefined;
  }
}

// Resolve every `{diagrams: …}` / `{no_diagrams}` directive in
// source order into the final state the diagram grid renders with.
// Defaults: visible = true (ChordPro spec — diagrams enabled by
// default), position = 'bottom' (spec default), instrument =
// undefined (caller falls back to `chordDiagrams.instrument`).
//
// Each directive overrides the running state last-wins; positional
// and instrument values stack independently (a `{diagrams: top}`
// followed by `{diagrams: piano}` keeps both — position `top`,
// instrument `piano`).
function resolveDiagramsState(song: ChordproSong): DiagramsState {
  const state: DiagramsState = { visible: true, position: 'bottom' };
  for (const line of song.lines) {
    if (line.kind !== 'directive') continue;
    const kind = line.value.kind;
    if (kind.tag === 'noDiagrams') {
      state.visible = false;
      continue;
    }
    if (kind.tag !== 'diagrams') continue;
    const value = (line.value.value ?? '').trim().toLowerCase();
    if (value === '') {
      // Bare `{diagrams}` — spec says this is the same as `on`.
      state.visible = true;
      continue;
    }
    if (DIAGRAMS_OFF_VALUES.has(value)) {
      state.visible = false;
      continue;
    }
    // Anything that isn't an explicit "off" enables visibility per
    // spec — including position keywords (`is_true("bottom")` is
    // truthy in the Perl reference implementation, see
    // `lib/ChordPro/Song.pm::dir_diagrams`).
    state.visible = true;
    if (DIAGRAMS_POSITIONS.has(value as DiagramsPosition)) {
      state.position = value as DiagramsPosition;
      continue;
    }
    const instr = diagramsValueAsInstrument(value);
    if (instr) {
      state.instrument = instr;
      continue;
    }
    // Unknown value: treat as bare `on` (visibility already set
    // above). Avoids regressing existing samples whose value
    // happens to be e.g. `true`.
  }
  return state;
}

/**
 * Source-line index for every metadata directive in the song.
 * Single-value directives store one number; multi-value (subtitle /
 * artist / composer / lyricist / arranger / tag) store an array
 * positionally aligned with the corresponding `metadata.*[]` array
 * — `metadata.subtitles[0]` was emitted by the directive on
 * `subtitleLines[0]`, etc.
 */
interface MetadataLines {
  title?: number;
  subtitles: number[];
  artists: number[];
  composers: number[];
  lyricists: number[];
  arrangers: number[];
  album?: number;
  year?: number;
  /**
   * `{key}` / `{tempo}` / `{time}` are spec'd as `[Nx] [Pos]`, so
   * each holds *every* source line of the directive — caret on any
   * one of them lights the header chip.
   */
  key: number[];
  tempo: number[];
  time: number[];
  capo?: number;
  duration?: number;
  copyright?: number;
  tags: number[];
}

/**
 * Walk `song.lines` once and capture the 1-indexed source line of
 * each metadata directive. The walker treats `Meta(key, value)`
 * forms (`{meta: artist Jane}`) the same as the dedicated kinds
 * (`{artist: Jane}`), so the caret-on-meta highlight works
 * regardless of which directive syntax the user typed.
 */
function collectMetadataLines(song: ChordproSong): MetadataLines {
  const out: MetadataLines = {
    subtitles: [],
    artists: [],
    composers: [],
    lyricists: [],
    arrangers: [],
    key: [],
    tempo: [],
    time: [],
    tags: [],
  };
  song.lines.forEach((line, i) => {
    if (line.kind !== 'directive') return;
    const sourceLine = i + 1;
    const kind = line.value.kind;
    switch (kind.tag) {
      case 'title':
        out.title = sourceLine;
        return;
      case 'subtitle':
        out.subtitles.push(sourceLine);
        return;
      case 'artist':
        out.artists.push(sourceLine);
        return;
      case 'composer':
        out.composers.push(sourceLine);
        return;
      case 'lyricist':
        out.lyricists.push(sourceLine);
        return;
      case 'arranger':
        out.arrangers.push(sourceLine);
        return;
      case 'album':
        out.album = sourceLine;
        return;
      case 'year':
        out.year = sourceLine;
        return;
      case 'key':
        out.key.push(sourceLine);
        return;
      case 'tempo':
        out.tempo.push(sourceLine);
        return;
      case 'time':
        out.time.push(sourceLine);
        return;
      case 'capo':
        out.capo = sourceLine;
        return;
      case 'duration':
        out.duration = sourceLine;
        return;
      case 'copyright':
        out.copyright = sourceLine;
        return;
      case 'tag':
        out.tags.push(sourceLine);
        return;
      // `{meta: <key> <value>}` — the parser routes recognised
      // meta keys onto the dedicated metadata fields and stores
      // the directive as `Meta(<key>)`. We don't have the parsed
      // key here without an extra round-trip through the value,
      // so this branch is a no-op; the dedicated-kind branches
      // above already cover the common case. A future enhancement
      // could split `Meta(<key>)` and attribute the line to the
      // corresponding parts.
      default:
        return;
    }
  });
  return out;
}

/**
 * Build a `<span>` for a single metadata value, decorated with the
 * source line attribute + `line--active` modifier when the caret
 * is on that line. Returns the value text alone when no source
 * line is provided (e.g. transposedKey, which has no directive of
 * its own).
 */
function metaSpan(
  key: string,
  text: string,
  sourceLine: number | undefined,
  activeSourceLine: number | undefined,
): JSX.Element {
  const isActive = sourceLine !== undefined && sourceLine === activeSourceLine;
  return (
    <span
      key={key}
      className={isActive ? 'line--active' : undefined}
      data-source-line={sourceLine}
    >
      {text}
    </span>
  );
}

function renderHeader(
  metadata: ChordproMetadata,
  options: RenderChordproAstOptions,
  fmt: FormattingState,
  metaLines: MetadataLines,
): JSX.Element[] {
  const out: JSX.Element[] = [];
  const titleStyle = elementStyleToCss(fmt.title);
  const active = options.activeSourceLine;
  if (metadata.title) {
    const isActive = metaLines.title !== undefined && metaLines.title === active;
    out.push(
      <h1
        key="title"
        style={titleStyle ?? undefined}
        className={isActive ? 'line--active' : undefined}
        data-source-line={metaLines.title}
      >
        {metadata.title}
      </h1>,
    );
  }
  if (metadata.subtitles.length > 0) {
    // Each subtitle gets its own `<span>` so the caret-on-subtitle
    // highlight matches only the one being edited. Spans are
    // joined by " · " text nodes.
    const subtitleNodes: JSX.Element[] = [];
    metadata.subtitles.forEach((sub, i) => {
      if (i > 0) {
        subtitleNodes.push(
          <Fragment key={`sep-${i}`}> · </Fragment>,
        );
      }
      subtitleNodes.push(
        metaSpan(`sub-${i}`, sub, metaLines.subtitles[i], active),
      );
    });
    out.push(<h2 key="subtitle">{subtitleNodes}</h2>);
  }
  // Metadata strip — split into three visual tiers so the eye
  // can scan the header without parsing 16 dot-separated cells:
  //   * `.meta--attribution`  — who made the song. Two lines:
  //       "by Artist" on its own, then "Music X · Lyrics Y ·
  //       Arr. Z" below at the same weight.
  //   * `.meta--params`       — what to play. Chip-shaped Key /
  //       Capo / BPM / Time / Duration tags so the values you
  //       glance at before performing are visually distinct.
  //   * `.meta--supplementary` — where it came from. Album /
  //       Year / Copyright at a smaller, muted weight beneath
  //       everything else.
  // Each individual value still lives in its own
  // `<span data-source-line>` so the editor-caret highlight
  // pinpoints exactly the value being edited.

  function buildMultiValueRow(
    label: string,
    values: string[],
    sources: number[],
    baseKey: string,
    /**
     * Role icon shown to the left of the row. Omit when the
     * directive has no meaningful icon (e.g. `Arr.` reuses
     * `composer` since arrangers are also "the music side").
     */
    iconKind?: 'artist' | 'composer' | 'lyricist',
  ): JSX.Element {
    return (
      <Fragment key={baseKey}>
        {iconKind ? <RoleIcon kind={iconKind} className="meta__role-icon" /> : null}
        {label && (
          <span className="meta__label" aria-hidden="true">
            {label}{' '}
          </span>
        )}
        {values.map((v, i) => (
          <Fragment key={i}>
            {i > 0 ? ', ' : ''}
            {metaSpan(`${baseKey}-${i}`, v, sources[i], active)}
          </Fragment>
        ))}
      </Fragment>
    );
  }

  // Tier 1 — attribution (artists primary, others on a 2nd line)
  if (metadata.artists.length > 0) {
    out.push(
      <p key="meta-attribution-primary" className="meta meta--attribution">
        {buildMultiValueRow('', metadata.artists, metaLines.artists, 'artist', 'artist')}
      </p>,
    );
  }
  const attributionSecondary: JSX.Element[] = [];
  const pushAttribution = (node: JSX.Element): void => {
    if (attributionSecondary.length > 0) {
      attributionSecondary.push(
        <Fragment key={`asep-${attributionSecondary.length}`}> · </Fragment>,
      );
    }
    attributionSecondary.push(node);
  };
  if (metadata.composers.length > 0) {
    pushAttribution(
      buildMultiValueRow(
        'Composer',
        metadata.composers,
        metaLines.composers,
        'composer',
        'composer',
      ),
    );
  }
  if (metadata.lyricists.length > 0) {
    pushAttribution(
      buildMultiValueRow(
        'Lyrics',
        metadata.lyricists,
        metaLines.lyricists,
        'lyricist',
        'lyricist',
      ),
    );
  }
  if (metadata.arrangers.length > 0) {
    // Arrangers share the composer-side icon — they're the
    // "music arrangement" role, distinct from "lyrics" or
    // "performer", and giving them their own glyph would
    // overcrowd this small attribution row.
    pushAttribution(
      buildMultiValueRow(
        'Arranger',
        metadata.arrangers,
        metaLines.arrangers,
        'arranger',
        'composer',
      ),
    );
  }
  if (attributionSecondary.length > 0) {
    out.push(
      <p key="meta-attribution-secondary" className="meta meta--attribution meta--attribution-secondary">
        {attributionSecondary}
      </p>,
    );
  }

  // Tier 2 — musical params (chips)
  // `sourceLine` accepts either a single line number (single-value
  // metadata like `{capo}`) or an array of lines (multi-value
  // `[Nx]` metadata like `{key}` / `{tempo}` / `{time}`). When the
  // caret sits on any one of the recorded lines the chip lights
  // up, so a song with multiple `{key}` declarations highlights
  // its key chip regardless of which `{key}` line the caret is on.
  function chipSpan(
    keyName: string,
    text: string,
    sourceLine: number | readonly number[] | undefined,
  ): JSX.Element {
    let activeLine: number | undefined;
    let isActive = false;
    if (Array.isArray(sourceLine)) {
      isActive = sourceLine.some((l) => l === active);
      // `data-source-line` is single-valued; pick the first match
      // when active so caret-tracking tools can resolve back to a
      // declaration, otherwise the first declaration as a stable
      // anchor.
      activeLine = sourceLine.find((l) => l === active) ?? sourceLine[0];
    } else if (typeof sourceLine === 'number') {
      isActive = sourceLine === active;
      activeLine = sourceLine;
    }
    return (
      <span
        key={keyName}
        className={isActive ? 'meta__chip line--active' : 'meta__chip'}
        data-source-line={activeLine}
      >
        {text}
      </span>
    );
  }
  // `{key}` / `{tempo}` / `{time}` are now surfaced inline at
  // each directive's source position via the `.meta-inline`
  // markers (key signature glyph, animated metronome, time
  // signature with conductor dot), so duplicating them in the
  // header chip strip is pure redundancy. The chip row keeps
  // ONLY the values that have no positional marker — `{capo}`
  // (modelled as a song-global, with a "Multiple capo settings"
  // warning when declared more than once) and `{duration}`
  // (purely informational, no inline representation).
  const paramChips: JSX.Element[] = [];
  if (metadata.capo) paramChips.push(chipSpan('capo', `Capo ${metadata.capo}`, metaLines.capo));
  if (metadata.duration)
    paramChips.push(chipSpan('duration', metadata.duration, metaLines.duration));
  if (paramChips.length > 0) {
    out.push(
      <p key="meta-params" className="meta meta--params">
        {paramChips}
      </p>,
    );
  }

  // Tier 3 — supplementary (album / year / copyright)
  const supplementary: JSX.Element[] = [];
  const pushSupp = (node: JSX.Element): void => {
    if (supplementary.length > 0) {
      supplementary.push(
        <Fragment key={`ssep-${supplementary.length}`}> · </Fragment>,
      );
    }
    supplementary.push(node);
  };
  if (metadata.album) {
    // `{album}` gets a record/CD icon + "Album:" label so the
    // supplementary row reads as a labelled attribute rather
    // than a bare title. Year and copyright stay unlabelled —
    // their visual form (a 4-digit year, a `©` glyph) carries
    // the role on its own.
    pushSupp(
      <Fragment key="album">
        <RoleIcon kind="album" className="meta__role-icon" />
        <span className="meta__label" aria-hidden="true">
          Album:{' '}
        </span>
        {metaSpan('album', metadata.album, metaLines.album, active)}
      </Fragment>,
    );
  }
  if (metadata.year) pushSupp(metaSpan('year', metadata.year, metaLines.year, active));
  if (metadata.copyright)
    pushSupp(metaSpan('copyright', metadata.copyright, metaLines.copyright, active));
  if (supplementary.length > 0) {
    out.push(
      <p key="meta-supplementary" className="meta meta--supplementary">
        {supplementary}
      </p>,
    );
  }
  // Tags get their own row — `{tag}` is a categorization
  // signal (genre / mood / capo-style) rather than a song
  // attribute, so visually separating it from the main meta
  // strip keeps the eye-flow clean.
  if (metadata.tags.length > 0) {
    out.push(
      <p key="tags" className="meta meta--tags">
        {metadata.tags.map((tag, i) => {
          const sourceLine = metaLines.tags[i];
          const isActive = sourceLine !== undefined && sourceLine === active;
          return (
            <span
              key={i}
              className={isActive ? 'tag line--active' : 'tag'}
              data-source-line={sourceLine}
            >
              <RoleIcon kind="tag" className="tag__icon" />
              {tag}
            </span>
          );
        })}
      </p>,
    );
  }
  return out;
}

// ---- Top-level walker ----------------------------------------------

interface WalkContext {
  /** When non-null, lines are pushed into this section's children. */
  section: SectionState | null;
  /**
   * Running font/size/colour state — updated by `{Xfont}` /
   * `{Xsize}` / `{Xcolour}` directives, picked up by every line
   * emitted afterwards. Mirrors `chordsketch-render-html`'s
   * `FormattingState` so the same state-machine semantics apply
   * (in-chorus directives are scoped via the save/restore
   * pattern below).
   */
  fmt: FormattingState;
  /**
   * Saved formatting state captured on `{start_of_chorus}` so
   * in-chorus directives don't leak out — restored on
   * `{end_of_chorus}`. Matches the Rust renderer's behaviour.
   */
  savedFmt: FormattingState | null;
  /**
   * Output buffer for top-level (non-section) elements. The walker
   * appends a finished section's `<section>` into this buffer when
   * the section closes.
   */
  out: JSX.Element[];
  /**
   * Buffered body of the most recently closed chorus section,
   * captured so `{chorus}` recall directives can replay the
   * chorus inline. Mirrors `chordsketch-render-html`'s
   * "remember-last-chorus" state machine. `null` until the
   * first `{start_of_chorus}` / `{end_of_chorus}` pair has been
   * walked.
   */
  lastChorusBody: JSX.Element[] | null;
  /**
   * Display label of the last chorus, so a `{chorus}` recall
   * with no override label can reuse it instead of defaulting to
   * the generic "Chorus".
   */
  lastChorusLabel: string | null;
  /**
   * 1-indexed source line whose corresponding rendered element
   * should pick up the `line--active` modifier (see
   * `RenderChordproAstOptions.activeSourceLine`). `undefined`
   * disables the marker.
   */
  activeSourceLine?: number;
  /**
   * Approximate caret column ratio (0..1) the walker uses to drop
   * a `<span class="caret-marker">` inside the active element.
   * `undefined` skips the marker. Pre-computed from
   * `caretColumn / max(caretLineLength, 1)` so the walker doesn't
   * need to clamp on the hot path. Used as the default for line
   * kinds that don't supply a more accurate per-line ratio (see
   * `lyricsCaretRatio` for the lyrics-line override that
   * compensates for `[chord]` brackets not occupying rendered
   * space).
   */
  caretRatio?: number;
  /**
   * Raw caret column reported by the editor (0-indexed,
   * SOURCE characters). Kept alongside `caretRatio` so
   * per-line overrides (currently lyrics lines) can recompute a
   * line-specific ratio instead of using the linear source-
   * column fallback.
   */
  caretColumn?: number;
  /** Raw line length (SOURCE characters) for the same purpose. */
  caretLineLength?: number;
  /**
   * The song's PRIMARY `{key}` value (last-wins `metadata.key`),
   * cached here so the body's `{key}` inline marker can detect
   * whether a given `{key}` directive is the song-primary one
   * and therefore the target of the host's `transposedKey`
   * option. Pre-computed to avoid passing `song.metadata`
   * through the body-line walker. `null` when no key is set.
   */
  primaryKey: string | null;
  /**
   * Sounding key (concert pitch) after the host's
   * `RenderChordproAstOptions.transposedKey` was applied to the
   * primary written key. When set AND different from
   * `primaryKey`, the body's `{key}` inline marker emits a
   * paired "Written / Sounding" display matching the Perl
   * `key_print` / `key_sound` distinction. `null` when no
   * transposition is active or it lands on the same key.
   */
  soundingKey: string | null;
  /**
   * Chord drag-and-drop callback (see
   * `RenderChordproAstOptions.onChordReposition`). When
   * `undefined`, the walker emits inert `.chord` / `.lyrics`
   * elements; when set, `.chord` becomes draggable and
   * `.lyrics` becomes a drop target.
   */
  onChordReposition?: (event: ChordRepositionEvent) => void;
}

function flushSection(ctx: WalkContext, key: number): void {
  if (!ctx.section) return;
  const { name, label, children, startLine } = ctx.section;
  const labelText = label ?? SECTION_LABEL_DEFAULT[name];
  const labelStyle = elementStyleToCss(ctx.fmt.label);
  // Each section gets a stable `id` derived from its start line so
  // the `<section>` can `aria-labelledby` the heading. Without the
  // heading being inside the section, screen readers wouldn't pick
  // up the section name; with `aria-labelledby` they announce it.
  const labelId = labelText ? `cs-section-${startLine}` : undefined;
  const labelNode = labelText ? (
    <h3
      key="label"
      id={labelId}
      className="section-label"
      style={labelStyle ?? undefined}
    >
      {labelText}
    </h3>
  ) : null;
  // The chorus section as a whole picks up the `chorus` element
  // style. Other section families don't have a dedicated style
  // entry in `FormattingState` — they inherit `.text` via their
  // lyric lines.
  const sectionStyle = name === 'chorus' ? elementStyleToCss(ctx.fmt.chorus) : null;
  // Whole-section highlight: when the caret sits on the
  // `start_of_*` directive that opened this section OR on the
  // `end_of_*` directive that closes it (key = endLine here,
  // since flushSection is invoked from `handleDirective` on the
  // end directive), tag the wrapper `<section>` with both
  // `line--active` and the start-line's `data-source-line`. The
  // child lines retain their own per-line `data-source-line`
  // attributes — clicking inside the section body still
  // highlights only that lyric row, as before.
  const endLine = key;
  const sectionActive =
    ctx.activeSourceLine !== undefined &&
    (ctx.activeSourceLine === startLine || ctx.activeSourceLine === endLine);
  const sectionClassName = sectionActive ? `${name} line--active` : name;
  ctx.out.push(
    <section
      key={key}
      className={sectionClassName}
      style={sectionStyle ?? undefined}
      data-source-line={startLine}
      aria-labelledby={labelId}
    >
      {labelNode}
      {children}
    </section>,
  );
  // Capture the chorus body for `{chorus}` recall replay. Other
  // section families (verse / bridge / tab / grid / delegate)
  // don't have a recall directive in ChordPro, so only the
  // chorus family is buffered.
  if (name === 'chorus') {
    ctx.lastChorusBody = children;
    ctx.lastChorusLabel = labelText ?? null;
  }
  ctx.section = null;
}

function pushElement(
  ctx: WalkContext,
  element: JSX.Element,
  sourceLine?: number,
  /**
   * Per-line override for the caret marker's `left:` ratio:
   * - `undefined` — no override; inherit the linear
   *   source-column fallback stored on `ctx.caretRatio`.
   * - `0..1` — explicit horizontal ratio on the line element.
   * - `null` — explicitly suppress the line-level marker. Used
   *   when the marker has already been embedded inside a
   *   sub-element (e.g. a chord-bearing lyrics line where the
   *   marker is placed inside the matching `.chord` or
   *   `.lyrics` row by `renderLyricsLine`). Without this
   *   sentinel, `pushElement` would fall through to
   *   `ctx.caretRatio` and inject a duplicate line-level
   *   marker on top of the per-row one.
   */
  caretRatioOverride?: number | null,
): void {
  // When a 1-indexed source-line marker is provided, decorate the
  // root element of the line with:
  //   - a `data-source-line="<n>"` attribute so consumers can map
  //     DOM nodes back to source positions (used by the
  //     editor↔preview caret sync in the playground).
  //   - a `line--active` class on the element's existing `className`
  //     when the line matches `ctx.activeSourceLine`. The class is
  //     additive — pre-existing classes (`line`, `comment`,
  //     `comment-box`, etc.) survive.
  //   - a `<span class="caret-marker">` child positioned via
  //     `left: <caretRatio * 100>%` when the line is active AND a
  //     caret ratio is set. Lets the preview show "where in the
  //     line" the editor caret is, not just which line.
  let decorated = element;
  if (sourceLine !== undefined && isValidElement(element)) {
    const props = element.props as {
      className?: string;
      children?: ReactNode;
      [key: string]: unknown;
    };
    const isActive =
      ctx.activeSourceLine !== undefined && ctx.activeSourceLine === sourceLine;
    const nextClass = isActive
      ? `${props.className ? `${props.className} ` : ''}line--active`
      : props.className;
    // Resolve the marker's horizontal ratio:
    // - explicit `null` from the caller suppresses the marker
    //   (sub-element already owns it — chord-bearing lyrics
    //   line);
    // - explicit number overrides the walker default;
    // - `undefined` falls through to `ctx.caretRatio`.
    const effectiveRatio =
      caretRatioOverride === null
        ? undefined
        : caretRatioOverride ?? ctx.caretRatio;
    const markerSuppressed = caretRatioOverride === null;
    // Skip the in-element caret marker for narrow inline chips
    // (`{key}` / `{tempo}` / `{time}` `.meta-inline` markers).
    // Their visual width has no relationship to the source line's
    // character count, so a `left: ratio%` positioned inside the
    // chip lands somewhere meaningless — typically pinned to the
    // chip's right edge for any caret column past the chip's
    // narrow span. The `line--active` background highlight on the
    // chip itself is enough to signal which line the editor caret
    // is on; the in-element marker is reserved for full-width
    // elements (lyrics rows, comments, grid bars) where chip-
    // relative positioning IS meaningful.
    const classStr = typeof props.className === 'string' ? props.className : '';
    const isInlineChip = /\bmeta-inline\b/.test(classStr);
    const shouldInjectMarker =
      isActive && effectiveRatio !== undefined && !isInlineChip && !markerSuppressed;
    decorated = cloneElement(
      element,
      {
        'data-source-line': sourceLine,
        ...(nextClass !== undefined ? { className: nextClass } : {}),
      } as Partial<typeof props>,
      ...(shouldInjectMarker
        ? [
            <span
              key="__caret-marker"
              className="caret-marker"
              aria-hidden="true"
              style={{ left: `${(effectiveRatio ?? 0) * 100}%` }}
            />,
            props.children as ReactNode,
          ]
        : []),
    );
  }
  if (ctx.section) {
    ctx.section.children.push(decorated);
  } else {
    ctx.out.push(decorated);
  }
}

// Set of directive tags that mutate the running `FormattingState`
// — used by `handleDirective` to dispatch to
// `applyFormattingDirective` without re-listing the 21 cases.
// The set covers element styles handled by the React surface;
// header / footer / toc are PDF-only and silently drop through
// `applyFormattingDirective`'s `default` arm.
const FORMATTING_TAGS: ReadonlySet<ChordproDirectiveKind['tag']> = new Set<
  ChordproDirectiveKind['tag']
>([
  'textFont', 'textSize', 'textColour',
  'chordFont', 'chordSize', 'chordColour',
  'tabFont', 'tabSize', 'tabColour',
  'titleFont', 'titleSize', 'titleColour',
  'chorusFont', 'chorusSize', 'chorusColour',
  'labelFont', 'labelSize', 'labelColour',
  'gridFont', 'gridSize', 'gridColour',
]);

function handleDirective(
  ctx: WalkContext,
  directive: ChordproDirective,
  key: number,
): void {
  // Switch on `directive.kind` directly so TypeScript narrows to
  // the discriminated-union member at every branch. Destructuring
  // `tag` into a plain `string` would lose the narrowing and
  // force casts at every payload-bearing branch.
  const kind = directive.kind;

  // Font / size / colour directive — mutate the walker's running
  // `FormattingState` so subsequent lines / sections pick up the
  // new style. No DOM emit on its own; the next emitted element
  // reads from `ctx.fmt`. Mirrors
  // `chordsketch-render-html::FormattingState::apply`.
  if (FORMATTING_TAGS.has(kind.tag)) {
    applyFormattingDirective(ctx.fmt, kind.tag, directive.value);
    return;
  }

  // Section open — named (chorus / verse / bridge / tab / grid /
  // delegate) and custom (`{start_of_<name>}`).
  if (kind.tag in SECTION_TAG_TO_NAME) {
    // If a previous section was still open, flush it before
    // opening a new one — `<section>` nesting is not part of the
    // ChordPro grammar, so the lenient path is "implicit close".
    flushSection(ctx, key * 1000);
    // On `{start_of_chorus}`, save the current formatting state so
    // any in-chorus `{Xfont}` / `{Xsize}` / `{Xcolour}` directives
    // don't leak out when the chorus closes. Matches the Rust
    // renderer's save / restore semantics. Other section families
    // do not establish a formatting scope — their directives
    // affect the rest of the song.
    if (kind.tag === 'startOfChorus') {
      ctx.savedFmt = cloneFormattingState(ctx.fmt);
    }
    // For grid sections the directive's `value` may carry an
    // attribute payload (`shape="..." label="..."`) or a
    // legacy colon-form label. Resolve the human-readable
    // label by preferring `label="..."` when present, falling
    // back to the value when it doesn't contain `=`, otherwise
    // null so the section heading defaults to "Grid". Sister-
    // site to the Rust renderers' `extract_grid_label` flow.
    const isGrid = kind.tag === 'startOfGrid';
    const gridLabel = isGrid
      ? (() => {
          const v = directive.value ?? '';
          const extracted = extractGridLabel(v);
          if (extracted !== null) return extracted;
          if (!v.includes('=')) return v.length > 0 ? v : null;
          return null;
        })()
      : (directive.value ?? null);
    ctx.section = {
      name: SECTION_TAG_TO_NAME[kind.tag]!,
      label: gridLabel,
      children: [],
      startLine: key,
      gridShape: isGrid ? parseGridShape(directive.value ?? '') : null,
    };
    return;
  }
  if (kind.tag === 'startOfSection') {
    flushSection(ctx, key * 1000);
    ctx.section = {
      // Custom section name lands as `section-<sanitized_name>`
      // — matches `chordsketch-render-html`'s
      // `<section class="section-<sanitized_name>">` contract for
      // `{start_of_<name>}` directives. Sanitisation is the same
      // JS port as `sanitize_css_class` above.
      name: `section-${sanitizeCssClass(kind.value)}`,
      label: directive.value ?? null,
      children: [],
      startLine: key,
      gridShape: null,
    };
    return;
  }

  // Section close — named + custom.
  if (kind.tag in END_TAG_TO_NAME || kind.tag === 'endOfSection') {
    // Restore the pre-chorus formatting state captured on
    // `{start_of_chorus}` so in-chorus styles don't leak out. A
    // mismatched `{end_of_chorus}` (no matching `{start_of_chorus}`)
    // falls through with `savedFmt === null`, leaving the running
    // state untouched — same as the Rust renderer.
    if (kind.tag === 'endOfChorus' && ctx.savedFmt !== null) {
      ctx.fmt = ctx.savedFmt;
      ctx.savedFmt = null;
    }
    flushSection(ctx, key);
    return;
  }

  // `{chorus}` recall — replay the most-recently-closed chorus's
  // body inline. Matches `chordsketch-render-html`'s recall
  // behaviour: a `{chorus}` directive with no body emits a
  // `<div class="chorus-recall">` containing a label + a fresh
  // copy of the buffered chorus children. Until a chorus has
  // been declared the recall has nothing to replay; emit just
  // the label so the CSS hook still lands.
  if (kind.tag === 'chorus') {
    const labelText = directive.value ?? ctx.lastChorusLabel ?? 'Chorus';
    const replay = ctx.lastChorusBody;
    pushElement(
      ctx,
      <div key={key} className="chorus-recall">
        <h3 className="section-label">{labelText}</h3>
        {replay
          ? // Children are re-keyed under a `recall-` namespace so
            // a single song with multiple `{chorus}` recalls does
            // not produce duplicate keys on the same level.
            replay.map((child, i) => (
              <Fragment key={`recall-${i}`}>{child}</Fragment>
            ))
          : null}
      </div>,
    );
    return;
  }

  // Image directive — narrowing on `kind.tag === 'image'` lets
  // TypeScript see `kind.value` as `ChordproImageAttributes`.
  if (kind.tag === 'image') {
    const img = renderImage(kind.value, key);
    if (img) pushElement(ctx, img);
    return;
  }

  // `{key}` / `{tempo}` / `{time}` are spec'd as `[Nx] [Pos]` —
  // every declaration applies forward from its position in the
  // song. Phase B of #2454 renders a small inline marker at the
  // directive's source position so a reader can see *where*
  // mid-song key / tempo / meter changes happen. The header chip
  // (Phase A) shows the joined list of every value; this marker
  // is what makes the *position* aspect visible. Sister-site to
  // `crates/render-html/src/lib.rs::render_song_body_into` (Rust
  // emits the matching `<p class="meta-inline …">` shape).
  // Each kind ships a music-notation icon next to the text label
  // (Phase B follow-up of #2454): treble-clef + key signature for
  // `{key}`, an animated mini metronome for `{tempo}`, and a
  // stacked numerator / denominator glyph for `{time}`. The
  // glyphs live in `music-glyphs.tsx`; styles for the metronome
  // animation and the stacked time-signature typography live in
  // `styles.css` (gated on `prefers-reduced-motion: reduce` for
  // the metronome).
  if (kind.tag === 'key' && directive.value && directive.value.trim().length > 0) {
    const keyName = directive.value.trim();
    // When transposition is active AND this `{key}` directive
    // matches the song-primary key (the one the host's
    // `transposedKey` was computed against), render a paired
    // "Original / Playing" display so the player can see both
    // the source-authored key and the resulting capo / transposed
    // key. "Original" / "Playing" reads more naturally for
    // guitar-style chord sheets than the technically correct
    // "Written" / "Sounding" pair (the latter trips up readers
    // who haven't internalised the music-theory distinction).
    //
    // Mid-song `{key}` changes (and any `{key}` whose value
    // doesn't match the primary) fall through to the single
    // chip — the host's `transposedKey` only knows the primary
    // key's transposition, so applying it blindly to a
    // different `{key}` would be incorrect.
    const showSounding =
      ctx.soundingKey != null && ctx.primaryKey != null && keyName === ctx.primaryKey;
    if (showSounding && ctx.soundingKey != null) {
      pushElement(
        ctx,
        <span key={key} className="meta-inline meta-inline--key meta-inline--key-pair">
          <span className="meta-inline__group">
            <KeySignatureGlyph keyName={keyName} className="meta-inline__glyph" />
            <span className="meta-inline__label">Original:</span>{' '}
            <span className="meta-inline__value">{unicodeAccidentals(keyName)}</span>
          </span>
          <span className="meta-inline__separator" aria-hidden="true">
            →
          </span>
          <span className="meta-inline__group">
            <KeySignatureGlyph keyName={ctx.soundingKey} className="meta-inline__glyph" />
            <span className="meta-inline__label">Playing:</span>{' '}
            <span className="meta-inline__value">
              {unicodeAccidentals(ctx.soundingKey)}
            </span>
          </span>
        </span>,
        key, // source-line for `line--active` decoration
      );
      return;
    }
    pushElement(
      ctx,
      <span key={key} className="meta-inline meta-inline--key">
        <KeySignatureGlyph keyName={keyName} className="meta-inline__glyph" />
        <span className="meta-inline__label">Key:</span>{' '}
        <span className="meta-inline__value">{unicodeAccidentals(keyName)}</span>
      </span>,
      key, // source-line for `line--active` decoration
    );
    return;
  }
  if (kind.tag === 'tempo' && directive.value && directive.value.trim().length > 0) {
    const bpmRaw = directive.value.trim();
    const bpm = Number.parseInt(bpmRaw, 10);
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 60;
    pushElement(
      ctx,
      // The metronome glyph carries the meaning of the marker
      // on its own — "Tempo:" duplicates the icon's signal and
      // crowds the chip, so we drop the textual label and keep
      // only the BPM value. When the BPM matches a conventional
      // Italian tempo marking (Allegro, Andante, …) we append
      // it in parens so the reader sees both numeric and
      // descriptive tempos at a glance.
      <span key={key} className="meta-inline meta-inline--tempo">
        <MetronomeGlyph bpm={safeBpm} className="meta-inline__glyph" />
        <span className="meta-inline__value">
          {bpmRaw} BPM
          {tempoMarkingFor(safeBpm) != null ? (
            <span className="meta-inline__marking">{` (${tempoMarkingFor(safeBpm)})`}</span>
          ) : null}
        </span>
      </span>,
      key, // source-line for `line--active` decoration
    );
    return;
  }
  if (kind.tag === 'time' && directive.value && directive.value.trim().length > 0) {
    const timeValue = directive.value.trim();
    pushElement(
      ctx,
      <span key={key} className="meta-inline meta-inline--time">
        <span className="meta-inline__label">Time:</span>{' '}
        <TimeSignatureGlyph value={timeValue} className="meta-inline__glyph" />
      </span>,
      key, // source-line for `line--active` decoration
    );
    return;
  }

  // Page-control / song-boundary directives — no DOM impact on the
  // React preview (pagination is renderer-specific to PDF; song
  // boundaries are split-at-parse-time).
  // Font / size / colour directives — these affect the Rust
  // renderer's emitted `<style>` block. The React preview lives
  // inside the consumer's stylesheet and does not read these
  // directives; consumers that need per-song style overrides can
  // walk the AST themselves.
  // Diagrams toggle / config override / generic meta / chord
  // definitions — consumed by the renderer's setup phase, no body
  // output. Metadata-class directives (title, artist, etc.) are
  // surfaced via the `metadata` block, not as inline lines, so
  // ignore them here too.
  // Unknown directives — fail-soft drop, matching
  // `chordsketch-render-html`'s behaviour for unknown directive
  // names (the parser still preserves them in `Metadata.custom`).
}

function renderLine(ctx: WalkContext, line: ChordproLine, key: number): void {
  // `key` doubles as the 1-indexed source-line number — the AST's
  // `lines: ChordproLine[]` array is in source order, so the
  // walker's natural `index + 1` is the line number consumers can
  // use to map preview elements back to editor positions.
  const sourceLine = key;
  switch (line.kind) {
    case 'lyrics': {
      // Inside `{start_of_grid}` we replace the plain lyrics row
      // with an iReal Pro-style structured grid: bars separated
      // by vertical barlines, repeat / volta / final markers
      // rendered as glyphs, chord names typeset, beat dots
      // (`.`) shown as muted continuation marks.
      if (ctx.section?.name === 'grid') {
        const gridLine = renderGridLine(line.value, key);
        const gridRatio =
          ctx.activeSourceLine === sourceLine &&
          ctx.caretColumn !== undefined &&
          ctx.caretLineLength !== undefined
            ? Math.min(1, Math.max(0, ctx.caretColumn / Math.max(1, ctx.caretLineLength)))
            : undefined;
        pushElement(ctx, gridLine, sourceLine, gridRatio);
        return;
      }
      // Inside a `section.tab`, the body picks up the `tab`
      // element style instead of the running `.text` style —
      // mirrors `chordsketch-render-html`'s per-section style
      // override.
      let lyricsOverride: CSSProperties | null = null;
      if (ctx.section?.name === 'tab') {
        lyricsOverride = elementStyleToCss(ctx.fmt.tab);
      }
      // Compute the per-line caret placement. A chord-bearing
      // line renders as two stacked rows per segment (`.chord`
      // above `.lyrics`); the editor caret belongs to exactly
      // one of those rows depending on whether it sits inside a
      // `[chord]` bracket or in the lyric text. `caretPlacement`
      // disambiguates and returns either a per-row placement
      // (`row: 'chord'|'lyrics'`) — embedded inside the matching
      // `.chord-block` sub-element by `renderLyricsLine` — or
      // `row: 'line'` for chord-less lines, where the line-level
      // marker is injected by `pushElement` via the
      // `caretRatioOverride` parameter.
      const placement =
        ctx.activeSourceLine === sourceLine &&
        ctx.caretColumn !== undefined &&
        ctx.caretLineLength !== undefined
          ? caretPlacement(line.value, ctx.caretColumn, ctx.caretLineLength)
          : null;
      // `LyricsLine` now renders every caret-marker variant
      // internally (chord row / lyrics row / line row), so
      // `pushElement` must NOT inject a line-level marker on
      // top of the one inside the component. `null` is the
      // sentinel that says "marker is already placed, leave the
      // element alone". `pushElement` still applies the
      // `line--active` className and `data-source-line` attr
      // via `cloneElement` — the component forwards those onto
      // its root `.line` div.
      const repositionCtx = ctx.onChordReposition
        ? { sourceLine, onChordReposition: ctx.onChordReposition }
        : null;
      pushElement(
        ctx,
        renderLyricsLine(
          line.value,
          key,
          ctx.fmt,
          lyricsOverride,
          placement,
          repositionCtx,
        ),
        sourceLine,
        null,
      );
      return;
    }
    case 'comment':
      pushElement(ctx, renderComment(line.style, line.text, key, ctx.fmt), sourceLine);
      return;
    case 'empty':
      // Empty lines are visual spacing; hide them from assistive
      // tech so screen readers don't announce a blank pause.
      pushElement(
        ctx,
        <div key={key} className="empty-line" aria-hidden="true" />,
        sourceLine,
      );
      return;
    case 'directive':
      handleDirective(ctx, line.value, key);
      return;
  }
}

/**
 * Top-level renderer: AST → React tree. The output is wrapped in
 * `<div class="song">` to match `chordsketch-render-html`'s
 * top-level container so existing CSS (and any consumer
 * stylesheet keyed on `.song`) lights up unchanged.
 *
 * @param song    Parsed AST returned by
 *                `@chordsketch/wasm::parseChordpro*`.
 * @param options Optional render hints — currently just the
 *                transposed key string so the metadata strip can
 *                show "Original Key X · Play Key Y". Pass `{}`
 *                (or omit) to keep the legacy single-key form.
 */
export function renderChordproAst(
  song: ChordproSong,
  options: RenderChordproAstOptions = {},
): JSX.Element {
  const ctx: WalkContext = {
    section: null,
    out: [],
    lastChorusBody: null,
    lastChorusLabel: null,
    fmt: emptyFormattingState(),
    savedFmt: null,
    activeSourceLine: options.activeSourceLine,
    caretRatio:
      options.caretColumn !== undefined && options.caretLineLength !== undefined
        ? // Clamp to 0..1 so a column that overruns the reported
          // line length (e.g. caret at end-of-line trailing
          // whitespace stripped by the AST) doesn't push the
          // marker past the right edge.
          Math.min(
            1,
            Math.max(0, options.caretColumn / Math.max(1, options.caretLineLength)),
          )
        : undefined,
    caretColumn: options.caretColumn,
    caretLineLength: options.caretLineLength,
    primaryKey: song.metadata.key,
    // `transposedKey` is the host-computed sounding key for the
    // song-primary written key. Only treat it as a real
    // sounding-key value when it actually differs from the
    // primary; otherwise downstream code can skip the dual
    // display.
    soundingKey:
      options.transposedKey && options.transposedKey !== song.metadata.key
        ? options.transposedKey
        : null,
    onChordReposition: options.onChordReposition,
  };
  // Emit header first so metadata lands above the body even when
  // the source has metadata directives interleaved with lines.
  // Header uses a pre-walked formatting snapshot — only
  // directives that appear BEFORE the first lyric / section line
  // affect the header title (matches the Rust renderer's
  // behaviour where the title styling is fixed at file start).
  const headerFmt = computeHeaderFormattingState(song);
  // Collect 1-indexed source lines for each metadata directive so
  // the header renderer can map per-value spans back to the editor
  // caret position (#2466 active-line follow-up).
  const metadataLines = collectMetadataLines(song);
  const headerNodes = renderHeader(song.metadata, options, headerFmt, metadataLines);
  // Wrap title + subtitle + meta strip + tags in a single
  // `<header>` so the song's header content registers as a
  // landmark for screen readers. Skip the wrapper entirely
  // when there's nothing to emit (empty AST) to avoid an empty
  // `<header>` element in the output.
  if (headerNodes.length > 0) {
    ctx.out.push(
      <header key="song-header" className="song-header">
        {headerNodes}
      </header>,
    );
  }
  // Snapshot the head-of-song boundary BEFORE walking the body, so
  // a `{diagrams: top}` resolved further down can splice its
  // <section> in after the header but before the first body element.
  // `renderHeader` writes title / subtitle / meta strip into a
  // wrapping `<header>` element above, so ctx.out.length is exactly
  // the count of header wrappers (0 or 1) when the body walk
  // begins.
  const headEnd = ctx.out.length;
  song.lines.forEach((line, i) => renderLine(ctx, line, i + 1));
  // Final close: if the song ends inside an open section, flush
  // it so the user sees their lines instead of dropping them.
  flushSection(ctx, song.lines.length + 1);

  // Chord-diagrams section. Mirrors
  // `chordsketch-render-html`'s `<section class="chord-diagrams">`
  // emit, but each diagram is a `<ChordDiagram>` component
  // (which calls `chord_diagram_svg` from `@chordsketch/wasm`
  // internally) so the React surface gets per-cell loading /
  // error / not-found states for free.
  //
  // The state is resolved once over the entire song (visibility +
  // position + instrument), then a single `<section>` is emitted
  // at the position-appropriate boundary. Per spec, all four
  // position keywords (`bottom` default, `top`, `right`, `below`)
  // are recognised; the React walker maps them to the
  // `data-position` attribute and to either head- or tail-of-body
  // insertion. Concrete visual layout (column-on-the-right for
  // `right`, etc.) lives in `styles.css`.
  // `resolveDiagramsState` walks the lines once; capture it here so
  // the song-class modifier below shares the same state object
  // without re-walking.
  const diagramsState = options.chordDiagrams ? resolveDiagramsState(song) : null;
  // `right` requires a different DOM shape (two-column flex with
  // the body wrapped in a single flow container) so the diagram
  // column sits beside the body without forcing the body's line
  // rows to stretch to the section's full height. Track that
  // here so the rendering branch downstream can wrap the body.
  let rightSection: ReactNode = null;
  let bottomSection: ReactNode = null;
  if (diagramsState?.visible && options.chordDiagrams) {
    const names = collectChordNames(song);
    if (names.length > 0) {
      const instrument =
        diagramsState.instrument ?? options.chordDiagrams.instrument ?? 'guitar';
      // Collect every `{define}` in the song so user-defined
      // voicings reach the wasm `lookup_diagram` call. Mirrors
      // the Rust HTML renderer's `song.fretted_defines()` path.
      const defines = collectDefines(song);
      const diagramsLabelId = 'cs-chord-diagrams-label';
      const section = (
        <section
          key="chord-diagrams"
          className="chord-diagrams"
          data-position={diagramsState.position}
          aria-labelledby={diagramsLabelId}
        >
          <h3 id={diagramsLabelId} className="section-label">
            Chord Diagrams
          </h3>
          <div className="chord-diagrams-grid">
            {names.map((name) => (
              // Each diagram is a self-contained figure — the
              // rendered SVG includes the chord name as a label
              // glyph so a separate `<figcaption>` would visually
              // duplicate it. `<ChordDiagram>` itself sets
              // `role="img"` + `aria-label` on its wrapper
              // (see chord-diagram.tsx) so the figure exposes
              // an accessible name to screen readers.
              <figure key={name} className="chord-diagram-container">
                <ChordDiagram
                  chord={name}
                  instrument={instrument}
                  defines={defines}
                />
              </figure>
            ))}
          </div>
        </section>
      );
      if (diagramsState.position === 'top') {
        // Splice between the header (title / subtitle / meta
        // strip) and the song body. Per spec, `top` puts diagrams
        // in the page-top region; on the Web there is no
        // page-margin concept, so "between header and body" is
        // the natural analogue.
        ctx.out.splice(headEnd, 0, section);
      } else if (diagramsState.position === 'right') {
        // Hold the section out of the linear body — the wrapper
        // construction below will place it next to a flex sibling
        // that holds the body content. Keeping the section out of
        // `ctx.out` (rather than appending and then trying to
        // reshape via CSS Grid) avoids the row-stretching trap
        // where the section's tall height inflates the row the
        // first body element lives in.
        rightSection = section;
      } else if (diagramsState!.position === 'bottom') {
        // `bottom`: pinned to the bottom of the preview pane
        // (mimics PDF page-bottom layout). Tracked separately
        // from the body flow so the wrapper logic below can
        // make `.song__body` a single flex item alongside the
        // pinned diagrams section. Pushing into `ctx.out`
        // would mix body and diagrams in the same column and
        // defeat the bottom pin.
        bottomSection = section;
      } else {
        // `below`: natural block flow after the last lyric
        // line. `data-position="below"` on the section + the
        // `song--diagrams-below` modifier on the wrapper let
        // CSS distinguish it from `bottom` without separate
        // layout requirements.
        ctx.out.push(section);
      }
    }
  }

  // Position-aware wrapper class. The modifier lets CSS reach the
  // wrapper itself — `right` flips `.song` to a row-flex with the
  // body wrapped in `.song__body` (see below); the other
  // modifiers (`top` / `bottom` / `below`) only need the section
  // to carry `data-position` and the wrapper class.
  const songClass = diagramsState?.visible
    ? `song song--diagrams-${diagramsState.position}`
    : 'song';

  if (rightSection !== null) {
    // Right-column layout. `.song__body` is a single flex item
    // wrapping the entire body flow (header + lines + sections),
    // and `.chord-diagrams[data-position='right']` is the
    // sibling pinned to the right. The body element retains
    // normal block flow internally, so chord-line rows do not
    // get stretched by the diagrams column's intrinsic height.
    return (
      <article className={songClass}>
        <div className="song__body">{ctx.out}</div>
        {rightSection}
      </article>
    );
  }
  if (bottomSection !== null) {
    // `bottom` diagrams: `.song--diagrams-bottom` declares
    // `display: flex; flex-direction: column` so a
    // `margin-top: auto` on the diagrams section pushes it to
    // the bottom of a tall preview pane. Without the wrapper
    // every body element (lines, sections, meta-inline chips)
    // would become an independent flex column item — each
    // taking a full row of the article — and consecutive
    // `{key}` / `{tempo}` / `{time}` chips that should flow
    // inline would stack vertically instead. Wrap the body so
    // the flex columnification only touches two children: the
    // body wrapper + the diagrams section. Inside the wrapper,
    // chips flow inline normally.
    return (
      <article className={songClass}>
        <div className="song__body">{ctx.out}</div>
        {bottomSection}
      </article>
    );
  }
  // `<article>` is the semantic root for a self-contained song —
  // a single ChordPro document is a "composition complete in
  // itself", which is the HTML5 article definition. Carries the
  // existing `.song` class so consumer CSS keyed on `.song`
  // still hits.
  return <article className={songClass}>{ctx.out}</article>;
}
