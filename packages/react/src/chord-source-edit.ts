/**
 * Source-side edit helpers for the drag-to-reposition chord
 * feature and the performance-toolbar capo control. The React
 * surface emits a `ChordRepositionEvent` describing what the
 * user did (drag from line A column X → drop at line B
 * lyrics-offset Y); the consumer applies the event to the
 * ChordPro source string via `applyChordReposition` and
 * dispatches the result into its editor.
 *
 * The same `ChordRepositionEvent` pipeline backs the
 * click-to-focus + nudge interaction (#2614): tapping a chord
 * selects it, and the ◀ / ▶ buttons (or the keyboard arrow
 * keys) move it one lyric character at a time. The pure offset
 * math for that gesture lives here — {@link nudgeChordPosition}
 * computes the destination lyrics offset + disambiguation
 * ordinal, {@link findChordByOffsetOrdinal} re-locates the
 * selected chord after a re-render, and
 * {@link sourceColumnToLyricsOffset} is the inverse of
 * {@link lyricsOffsetToSourceColumn} — so the interaction logic
 * has unit coverage independent of the DOM. The capo helpers
 * (`readCapo` / `setCapoInSource`) round-trip a `{capo: N}`
 * directive through the source so the `<Capo>` control stays
 * a thin wrapper over the document — no parallel state.
 *
 * Kept here (not inside the JSX walker) so the math has unit
 * coverage independent of the DOM and so external consumers
 * (VS Code extension host, custom editor shells) can drive the
 * same transformations without rendering a sheet.
 */

/** Minimum semitone offset the `<Transpose>` control emits by default. */
export const TRANSPOSE_MIN = -11;
/** Maximum semitone offset the `<Transpose>` control emits by default. */
export const TRANSPOSE_MAX = 11;
/** Minimum capo fret position the `<Capo>` control emits. */
export const CAPO_MIN = 0;
/** Maximum capo fret position the `<Capo>` control emits. */
export const CAPO_MAX = 12;

// Matches `{capo: N}` (or `{capo:-N}`) with optional whitespace
// around the value and an optional trailing newline. The trailing
// newline is captured so removal does not leave a blank line where
// the directive used to be.
const CAPO_DIRECTIVE_RE = /\{capo:\s*(-?\d+)\s*\}\s*\n?/;

// Anchor for inserting a new `{capo: N}` next to the other top-of-
// document metadata directives. We slot it AFTER any run of
// `{title}` / `{subtitle}` / `{artist}` / `{key}` / `{tempo}` /
// `{time}` at the very top of the source, so a freshly inserted
// capo keeps the metadata block contiguous instead of landing
// inside the lyrics.
const CAPO_ANCHOR_RE = /^(\{(?:title|subtitle|artist|key|tempo|time)[^}]*\}\s*\n)+/;

/** Characters that would corrupt the ChordPro source structure when
 * interpolated into a `[chord]` token. Shared by every chord-writing
 * helper so the editor surface cannot inject directives / brackets /
 * line breaks. `/` is intentionally allowed — it is the slash-chord
 * separator. */
const CHORD_FORBIDDEN_RE = /[[\]{}<>\n\r]/;

// ---- ChordPro escape handling (raw-source scanning) ----------------
// The raw-source scanners below (`scanLineChords`, `lyricsOffsetToSourceColumn`,
// `sourceColumnToLyricsOffset`) walk the ChordPro source string directly, so
// they must understand the lexer's escape rule or they mis-detect an escaped
// `\[` as a chord open — the #2634 bug. A backslash before one of the four
// structural specials (`[ ] { }`) escapes it: the backslash is dropped and the
// special becomes a single literal lyric character occupying two source
// columns. (Colon is special only inside directives, which lyric lines are
// not, so it is excluded here.) This list is the JS sister of the Rust lexer's
// `is_special` (`crates/chordpro/src/lexer.rs`); keep the two in lockstep.
const ESCAPABLE_SPECIALS = new Set(['[', ']', '{', '}']);

/** True when `line[i]` begins an escaped special (`\[`, `\]`, `\{`, `\}`). The
 * escaped unit spans columns `i` and `i + 1` and counts as one lyric char. */
function isEscapedSpecial(line: string, i: number): boolean {
  return line[i] === '\\' && ESCAPABLE_SPECIALS.has(line[i + 1] ?? '');
}

/**
 * Index of the `]` that closes a chord opened at `open` (`line[open] === '['`),
 * skipping any escaped `\]` inside the chord body so a chord name containing an
 * escaped bracket is not split early. Returns `-1` when the bracket is
 * unterminated.
 */
function chordCloseIndex(line: string, open: number): number {
  let i = open + 1;
  while (i < line.length) {
    if (isEscapedSpecial(line, i)) {
      i += 2;
      continue;
    }
    if (line[i] === ']') return i;
    i++;
  }
  return -1;
}

function clampInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Parse the `{capo: N}` directive out of a ChordPro source string.
 *
 * Returns `0` when no directive is present, when the value is
 * malformed, or when `N` is negative. Out-of-range positive values
 * are clamped into `[CAPO_MIN, CAPO_MAX]` so a stale or hand-edited
 * source cannot make the `<Capo>` control display a value its
 * `+` / `−` buttons would refuse to emit.
 *
 * Only the first `{capo}` occurrence is honoured — a second
 * directive mid-document is ignored (ChordPro's reference
 * implementation treats `{capo}` as song metadata, so multiple
 * declarations have no defined meaning).
 */
export function readCapo(source: string): number {
  const match = source.match(CAPO_DIRECTIVE_RE);
  if (!match) return CAPO_MIN;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n < 0) return CAPO_MIN;
  return clampInt(n, CAPO_MIN, CAPO_MAX);
}

/**
 * Read the capo value the **core renderer / parser** folds into the
 * effective transpose for `source`, mirroring
 * `Metadata::capo_validated` (`crates/chordpro/src/ast.rs`): only a
 * `{capo: N}` with `N ∈ 1..=24` contributes; anything else (absent,
 * out of range, non-integer, negative) contributes `0`.
 *
 * This is deliberately NOT {@link readCapo}: that helper clamps into
 * `[CAPO_MIN, CAPO_MAX]` (0..=12) so the `<Capo>` control never shows a
 * value its `+` / `−` buttons cannot emit. Reusing that display clamp
 * for the edit-safety gate is a bug — a hand-edited `{capo: 18}` would
 * clamp to `12` here while the core transposes the AST by `18`, so the
 * gate would (wrongly) think the rendered chords still match the raw
 * source and enable source-coordinate editing on a transposed AST,
 * corrupting the song. The gate must mirror the core's `1..=24`
 * accept-or-zero semantics exactly, with no clamping.
 *
 * @see chordSourceEditableUnderTranspose for the gate that consumes this.
 */
export function capoTransposeOffset(source: string): number {
  const match = source.match(CAPO_DIRECTIVE_RE);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  if (!Number.isInteger(n) || n < 1 || n > 24) return 0;
  return n;
}

/**
 * Whether source-coordinate chord editing is safe for `source` under a
 * given CLI `transpose`. Editing rewrites the raw `[chord]` tokens by
 * source column, but the wasm parse path transposes the AST in place —
 * folding `{capo}` into the effective transpose (ADR-0023) — so under a
 * non-zero **effective** transpose the rendered chord names are the
 * transposed spelling, not the raw source, and editing by source
 * coordinates would corrupt the song.
 *
 * Effective transpose mirrors the core's `effective_transpose(0, cli,
 * capo)`: `cli_transpose − capoTransposeOffset(source)`. Editing is safe
 * exactly when that is `0` (including coincidental cancellation such as
 * `transpose +2` with `{capo: 2}`, a genuine no-op transpose). The file
 * `{transpose}` directive is intentionally excluded because the wasm
 * parse path itself does not fold it (see `do_parse_chordpro`).
 */
export function chordSourceEditableUnderTranspose(
  source: string,
  transpose: number | undefined,
): boolean {
  return (transpose ?? 0) - capoTransposeOffset(source) === 0;
}

/**
 * Round-trip a capo value into a ChordPro source string.
 *
 * - When `capo === 0`, any existing `{capo: N}` directive is
 *   removed (including the trailing newline). A source that
 *   never had a `{capo}` directive is returned unchanged.
 * - When `capo !== 0` and a directive already exists, the value
 *   is replaced in place.
 * - When `capo !== 0` and no directive exists, a new
 *   `{capo: N}\n` line is inserted **after** the run of top-of-
 *   document metadata directives (`{title}` / `{subtitle}` /
 *   `{artist}` / `{key}` / `{tempo}` / `{time}`) — or at the
 *   start of the source if no such run exists.
 *
 * `capo` is clamped into `[CAPO_MIN, CAPO_MAX]` before being
 * written, mirroring the `<Capo>` control's button bounds so a
 * caller cannot persist a value the UI would refuse to display.
 */
export function setCapoInSource(source: string, capo: number): string {
  const clamped = clampInt(Math.trunc(capo), CAPO_MIN, CAPO_MAX);
  const directive = clamped === CAPO_MIN ? '' : `{capo: ${clamped}}\n`;
  if (CAPO_DIRECTIVE_RE.test(source)) {
    return source.replace(CAPO_DIRECTIVE_RE, directive);
  }
  if (clamped === CAPO_MIN) return source;
  const anchor = source.match(CAPO_ANCHOR_RE);
  if (anchor) {
    const idx = (anchor.index ?? 0) + anchor[0].length;
    return `${source.slice(0, idx)}${directive}${source.slice(idx)}`;
  }
  return `${directive}${source}`;
}

/**
 * Describes a chord-reposition gesture in source-coordinate
 * terms. Emitted by `<ChordSheet>` / `renderChordproAst`'s
 * `onChordReposition` callback and consumed by
 * {@link applyChordReposition}.
 */
export interface ChordRepositionEvent {
  /** 1-indexed source line of the chord being moved or copied. */
  fromLine: number;
  /** 0-indexed source column of the `[` opening bracket. */
  fromColumn: number;
  /** Source-column span of `[chord]`, including both
   * brackets — i.e. `chord.length + 2` for the canonical
   * form. */
  fromLength: number;
  /** 1-indexed source line where the chord should land. May
   * equal `fromLine` (same-line drag) or differ (cross-line
   * drag). */
  toLine: number;
  /** 0-indexed character offset within the destination line's
   * rendered lyrics text where the chord should be inserted.
   * Chord brackets in source do NOT count toward this offset —
   * `toLyricsOffset === 0` means "before the first visible
   * lyric character on `toLine`", regardless of any leading
   * `[chord]` brackets. */
  toLyricsOffset: number;
  /** Chord name without brackets, e.g. `"Am"`. */
  chord: string;
  /** Copy vs move semantics. `true` keeps the original bracket
   * in place; `false` removes it. */
  copy: boolean;
  /** Optional optimistic-concurrency guard for the `from` span,
   * mirroring {@link ChordEditEvent.expected}. When provided on a
   * move (`copy: false`), the reposition is a no-op (source returned
   * unchanged) if the live source at `[fromColumn, fromColumn +
   * fromLength)` is not `[expected]`. This prevents a stale or
   * drifted span (e.g. a column miscomputed across an escaped
   * special — see {@link chordLayoutForLine}) from removing the
   * wrong bracket and corrupting the song. Omitted on copies (no
   * removal happens) and ignored then. */
  expected?: string;
}

/** Return value of {@link applyChordReposition}. */
export interface ChordRepositionResult {
  /** Updated full source text. */
  text: string;
  /** 0-indexed absolute character offset into `text` pointing
   * right after the freshly inserted `[chord]`. Lets the
   * consumer restore the editor caret to the natural "I just
   * dropped here" position. */
  caretOffset: number;
}

/**
 * Caret offset landing just inside the `[` of the `[chord]` bracket an
 * apply-helper ({@link applyChordReposition} / {@link applyChordInsert})
 * just wrote. Those helpers return {@link ChordRepositionResult.caretOffset}
 * pointing just PAST the bracket (`… + insertBracket.length`); this backs up
 * over `]` and the chord name to the position right after `[`.
 *
 * Editor surfaces use it to keep the just-moved / just-inserted chord
 * selected: the caret-driven selection re-resolves onto a chord only while
 * the caret sits inside its brackets — a caret past the `]` lands in the
 * lyrics and deselects it. Kept beside the helpers it inverts so the
 * forward and reverse caret conventions cannot drift apart (a single
 * change to where the apply-helpers place `caretOffset` updates both).
 *
 * @param chordName the chord body written between the brackets (without
 *   the brackets), e.g. `"Am7"` — its length plus the two brackets is the
 *   span backed over.
 */
export function caretInsideWrittenBracket(
  result: ChordRepositionResult,
  chordName: string,
): number {
  return result.caretOffset - (chordName.length + 2) + 1;
}

/**
 * Map a lyrics-character offset on a ChordPro source line to
 * the source column where a new `[chord]` should be inserted.
 *
 * Chord brackets (`[...]`) are zero-width to the lyrics count,
 * so inserting at `lyricsOffset = N` lands the new bracket
 * "before the Nth visible character". Brackets that the offset
 * passes over are skipped — the inserted bracket sits AFTER
 * any prior brackets at the same lyric position.
 *
 * Out-of-range offsets clamp to line end. Malformed brackets
 * (unterminated `[`) are treated as plain lyrics from that
 * point on.
 */
export function lyricsOffsetToSourceColumn(line: string, lyricsOffset: number): number {
  let lyricsCount = 0;
  let i = 0;
  while (i < line.length) {
    // An escaped special (`\[`, `\]`, …) is one lyric character occupying two
    // source columns — count it as lyric, never as a bracket (#2634).
    if (isEscapedSpecial(line, i)) {
      if (lyricsCount >= lyricsOffset) return i;
      lyricsCount++;
      i += 2;
      continue;
    }
    // Skip a real chord bracket so a drop at the "start of the lyric" lands
    // AFTER any leading `[chord]` brackets — i.e. the new chord becomes the
    // one sitting above the lyric, instead of being pushed into a zero-width
    // segment before the existing brackets. Continuing the loop skips
    // adjacent brackets like `[A][B]` before the lyric counter is checked.
    if (line[i] === '[') {
      const close = chordCloseIndex(line, i);
      if (close === -1) {
        // Malformed bracket — bail out, treat the rest as lyrics.
        return i;
      }
      i = close + 1;
      continue;
    }
    if (lyricsCount >= lyricsOffset) return i;
    lyricsCount++;
    i++;
  }
  return line.length;
}

/**
 * Apply a chord-reposition event to a ChordPro source string,
 * returning the updated source plus a suggested caret offset.
 *
 * Order of operations:
 *
 * 1. **Remove** the original `[chord]` at `(fromLine,
 *    fromColumn)` — unless the gesture is a copy.
 * 2. **Locate** the target source column on `toLine` by
 *    walking the (possibly modified) line text and counting
 *    `toLyricsOffset` lyric characters past any leading
 *    brackets.
 * 3. **Insert** the `[chord]` bracket at the target column.
 *
 * When `fromLine === toLine` and the original removal happens
 * before the target column, the target column is interpreted
 * AGAINST THE LINE-AFTER-REMOVAL, so callers do not need to
 * pre-adjust for the shift. The same is true for the caret
 * offset returned in the result.
 *
 * Throws if `fromLine` / `toLine` are out of range or if the
 * `from` range overflows the source line.
 */
export function applyChordReposition(
  source: string,
  evt: ChordRepositionEvent,
): ChordRepositionResult {
  // Defense-in-depth: the React walker already validates the
  // drag payload via `isValidChordDragPayload` before reaching
  // this function, but non-React callers (e.g. tests / future
  // host integrations) may pass an unchecked event. Reject
  // chord names that would corrupt the ChordPro source
  // structure when interpolated as `[${chord}]` — brackets,
  // braces, newlines.
  if (typeof evt.chord !== 'string' || evt.chord.length === 0) {
    throw new Error('chord must be a non-empty string');
  }
  // Shared structural denylist with buildChordName / applyChordEdit /
  // applyChordDelete (one constant for every chord-writing helper, so a
  // future denylist change cannot reach only some of them — the
  // sister-site divergence `.claude/rules/fix-propagation.md` warns
  // about; previously this site inlined a near-copy that omitted `>`).
  if (CHORD_FORBIDDEN_RE.test(evt.chord)) {
    throw new Error(
      `chord ${JSON.stringify(evt.chord)} contains forbidden character ` +
        '(brackets, braces, angle bracket, newline / carriage return)',
    );
  }
  // Use `\n` as the delimiter — the parser is `\n`-only too,
  // so the source coordinates the event carries refer to
  // `\n`-split lines.
  const lines = source.split('\n');
  const insertBracket = `[${evt.chord}]`;

  // 1. Remove the original bracket if move.
  if (!evt.copy) {
    const lineIdx = evt.fromLine - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) {
      throw new Error(`fromLine ${evt.fromLine} out of range (lines: ${lines.length})`);
    }
    const lineText = lines[lineIdx];
    if (evt.fromColumn < 0 || evt.fromColumn + evt.fromLength > lineText.length) {
      throw new Error(
        `from range [${evt.fromColumn}, ${evt.fromColumn + evt.fromLength}) ` +
          `exceeds line length ${lineText.length}`,
      );
    }
    // Optimistic-concurrency guard (parity with applyChordEdit /
    // applyChordDelete): if the caller told us which token to expect at
    // the `from` span and the live source no longer matches — a stale
    // event, or a column drifted across an escaped special — no-op
    // instead of removing the wrong bracket and corrupting the song.
    if (
      evt.expected !== undefined &&
      lineText.slice(evt.fromColumn, evt.fromColumn + evt.fromLength) !== `[${evt.expected}]`
    ) {
      let caret = 0;
      for (let i = 0; i < lineIdx; i++) caret += lines[i].length + 1;
      return { text: source, caretOffset: caret + evt.fromColumn };
    }
    lines[lineIdx] =
      lineText.slice(0, evt.fromColumn) + lineText.slice(evt.fromColumn + evt.fromLength);
  }

  // 2. Compute the insertion column on the (possibly modified)
  // destination line.
  const toLineIdx = evt.toLine - 1;
  if (toLineIdx < 0 || toLineIdx >= lines.length) {
    throw new Error(`toLine ${evt.toLine} out of range (lines: ${lines.length})`);
  }
  const toLineText = lines[toLineIdx];
  const targetColumn = lyricsOffsetToSourceColumn(toLineText, evt.toLyricsOffset);

  // 3. Insert the bracket.
  lines[toLineIdx] =
    toLineText.slice(0, targetColumn) + insertBracket + toLineText.slice(targetColumn);

  // 4. Compute caret offset (absolute, into the joined result).
  let caretOffset = 0;
  for (let i = 0; i < toLineIdx; i++) {
    caretOffset += lines[i].length + 1; // +1 for the `\n`
  }
  caretOffset += targetColumn + insertBracket.length;

  return { text: lines.join('\n'), caretOffset };
}

/**
 * Map a 0-indexed source column on a ChordPro line back to the
 * lyrics-character offset at that column — the inverse of
 * {@link lyricsOffsetToSourceColumn}.
 *
 * Counts the visible lyric characters strictly before `column`,
 * treating chord brackets (`[...]`) as zero-width (consistent
 * with the lyrics-offset convention used throughout this
 * module). A `column` that points at a `[` therefore yields the
 * offset of the chord that opens there — i.e. the number of
 * lyric characters preceding it.
 *
 * `column` is clamped to `[0, line.length]`. A bracket that
 * straddles `column` (an unterminated `[`, or `column` landing
 * inside `[...]`) counts the characters consumed up to `column`
 * as lyrics, which keeps the function total for malformed input
 * rather than throwing.
 */
export function sourceColumnToLyricsOffset(line: string, column: number): number {
  const limit = Math.max(0, Math.min(column, line.length));
  let lyricsCount = 0;
  let i = 0;
  while (i < limit) {
    // An escaped special is one lyric character (two source columns); count it
    // and step past both columns. If `limit` falls between the backslash and
    // the special, the escape still counts as the one lyric char consumed up
    // to the boundary (#2634).
    if (isEscapedSpecial(line, i)) {
      lyricsCount++;
      i += 2;
      continue;
    }
    if (line[i] === '[') {
      const close = chordCloseIndex(line, i);
      // A bracket that closes before `limit` is skipped whole
      // (zero-width). One that is unterminated or extends past
      // `limit` cannot be a complete chord within the counted
      // range, so fall through and count its characters as
      // lyrics — mirrors lyricsOffsetToSourceColumn's malformed-
      // bracket bail-out.
      if (close !== -1 && close < limit) {
        i = close + 1;
        continue;
      }
    }
    lyricsCount++;
    i++;
  }
  return lyricsCount;
}

/** One entry of {@link chordLayoutForLine}, parallel to the input
 * segment list (one per segment, in order). */
export interface SegmentLayout {
  /** 0-indexed source column of this segment's `[` opening bracket
   * (only meaningful when the segment carries a chord). */
  sourceColumn: number;
  /** Source-column span of this segment's `[chord]` including both
   * brackets (`name.length + 2`), or `0` when the segment has no
   * chord. */
  bracketLength: number;
  /** 0-indexed lyrics offset at which this segment's text begins —
   * i.e. the lyrics offset of the segment's chord, if any. */
  lyricsOffsetStart: number;
}

/** Minimal structural shape of a parsed lyrics segment, kept local so
 * this module stays free of an AST-type import. */
interface LayoutSegment {
  text: string;
  chord?: { name?: string | null } | null;
  /** 0-based UTF-16 source column of this segment's chord `[`, supplied
   * authoritatively by the parser (escape-safe — see {@link chordLayoutForLine}
   * and #2634). Absent / `null` when unknown, triggering reconstruction. */
  sourceColumn?: number | null;
}

/**
 * Compute the source-column / lyrics-offset layout of a lyrics line's
 * segments — the single source of truth for the chord-coordinate space
 * shared by the JSX walker (drag / nudge / drop targeting) and
 * `resolveSelectedChord` (inspector selection → source coordinates).
 *
 * Both surfaces previously walked `line.segments` with byte-identical
 * accumulation; keeping two copies risked silent desync (a future
 * change to bracket-length math applied to one and not the other would
 * resolve the wrong chord — exactly the sister-site hazard
 * `.claude/rules/fix-propagation.md` warns about).
 *
 * The chord column comes from the parser-supplied authoritative
 * {@link LayoutSegment.sourceColumn} (a 0-based UTF-16 column that survives
 * escaped specials such as `\[`). Reconstructing it from post-lex `seg.text`
 * lengths — as this helper used to — drifts after an escape: the lexer drops
 * the backslash of `\[` / `\]` / `\{`, so `seg.text` is shorter than the
 * source span and a chord after the escape gets a column that is too small
 * (#2634). When the AST does not carry the field (an older `@chordsketch/wasm`
 * build, or a non-parser-produced segment), it falls back to the running
 * reconstruction; the edit / delete / reposition `expected` guards keep a
 * stale fallback column a safe no-op rather than a corruption.
 *
 * @returns one {@link SegmentLayout} per input segment (same order) and
 *   the line's total visible lyric-character count.
 */
export function chordLayoutForLine(
  segments: ReadonlyArray<LayoutSegment>,
): { layout: SegmentLayout[]; totalLyrics: number } {
  const layout: SegmentLayout[] = [];
  let sourceColumn = 0;
  let lyricsOffset = 0;
  for (const seg of segments) {
    const bracketLength = seg.chord ? (seg.chord.name?.length ?? 0) + 2 : 0;
    // Prefer the parser's authoritative column for a chord segment; otherwise
    // use the running reconstruction. Resync the running counter to whichever
    // value won, so a chord's own authoritative column re-anchors the count
    // and a following field-less segment continues from there. A parser-
    // produced AST carries the column on every chord (or none, for an older
    // wasm build), so this resync only matters for a mixed AST; reconstruction
    // still cannot see escapes inside a segment's own text, but the next chord
    // that carries a column re-anchors past that drift, and the edit `expected`
    // guard keeps any residual drift a safe no-op.
    const col =
      seg.chord && seg.sourceColumn != null ? seg.sourceColumn : sourceColumn;
    layout.push({ sourceColumn: col, bracketLength, lyricsOffsetStart: lyricsOffset });
    sourceColumn = col + bracketLength + seg.text.length;
    lyricsOffset += seg.text.length;
  }
  return { layout, totalLyrics: lyricsOffset };
}

/** Destination of a single-step chord nudge, returned by
 * {@link nudgeChordPosition}. */
export interface NudgedChordPosition {
  /** New 0-indexed lyrics offset for the moved chord. */
  offset: number;
  /** Index of the moved chord among chords sharing `offset` on
   * the destination line, in left-to-right order. The nudged
   * chord always lands AFTER any chord already at `offset` (see
   * {@link lyricsOffsetToSourceColumn}, which skips leading
   * brackets), so this equals the count of other chords already
   * at `offset`. Used to disambiguate stacked chords like
   * `[A][B]word` when re-locating the selection after the move. */
  ordinal: number;
}

/**
 * Compute where a chord lands when nudged one lyric character in
 * `direction`, for the click-to-focus + arrow-key interaction
 * (#2614).
 *
 * @param currentOffset the chord's current 0-indexed lyrics
 *   offset (lyric characters before its `[` bracket).
 * @param otherOffsets the lyrics offsets of every OTHER chord on
 *   the same line (the moved chord excluded). Used only to
 *   compute the destination ordinal.
 * @param totalLyrics the total visible lyric characters on the
 *   line. A chord may legitimately sit at `offset === totalLyrics`
 *   (a trailing chord after the last lyric), so that bound is
 *   inclusive.
 * @param direction `-1` to move left, `+1` to move right.
 * @returns the destination offset + ordinal, or `null` when the
 *   move would push the chord off either end of the line (the
 *   caller disables the corresponding button).
 */
export function nudgeChordPosition(
  currentOffset: number,
  otherOffsets: readonly number[],
  totalLyrics: number,
  direction: -1 | 1,
): NudgedChordPosition | null {
  const offset = currentOffset + direction;
  if (offset < 0 || offset > totalLyrics) return null;
  return { offset, ordinal: ordinalAtOffset(offset, otherOffsets) };
}

/**
 * Count the chords whose lyrics offset equals `offset` — the
 * disambiguation ordinal a chord inserted there receives, since a
 * freshly written `[chord]` always lands AFTER any chords already at
 * the offset ({@link lyricsOffsetToSourceColumn} skips leading
 * brackets). Single source of the "ordinal = chords already at this
 * offset" rule shared by {@link nudgeChordPosition} and
 * {@link repositionedChordOrdinal}; `offsets` must already exclude the
 * chord being placed.
 */
function ordinalAtOffset(offset: number, offsets: readonly number[]): number {
  return offsets.reduce((n, o) => (o === offset ? n + 1 : n), 0);
}

/**
 * Find the index, into a line's left-to-right list of chord
 * lyrics offsets, of the chord identified by `(offset, ordinal)`
 * — the `ordinal`-th chord (0-indexed) whose offset equals
 * `offset`.
 *
 * Returns `-1` when no such chord exists, e.g. when the source
 * changed out from under a stale selection. Callers treat `-1`
 * as "selection no longer resolves" and render no controls.
 */
export function findChordByOffsetOrdinal(
  offsets: readonly number[],
  offset: number,
  ordinal: number,
): number {
  let seen = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] === offset) {
      if (seen === ordinal) return i;
      seen++;
    }
  }
  return -1;
}

/**
 * Compute the disambiguation ordinal a chord occupies after a
 * drag-and-drop reposition lands it at `destinationOffset` on the
 * destination line — so the consumer can keep the dropped chord selected
 * (parity with the nudge path, which advances the selection to the moved
 * chord via {@link buildChordNudge}'s returned `ordinal`).
 *
 * The dropped chord always lands AFTER any chords already sitting at
 * `destinationOffset` — {@link lyricsOffsetToSourceColumn} skips leading
 * `[...]` brackets at the target lyric position — so its ordinal is the
 * count of OTHER chords sharing that offset in the re-parsed source.
 *
 * Moving a chord shifts only bracket columns, never the zero-width lyrics
 * offsets of the other chords, so this count can be taken against the
 * pre-move layout. The only adjustment is the dragged chord itself: on a
 * same-line move it is removed from the destination line before the
 * re-insert, so it must be excluded from the count via `removedIndex`. On
 * a cross-line move or a copy nothing is removed from the destination
 * line, so every current chord there counts (`removedIndex < 0`).
 *
 * @param destinationOffset the lyrics offset the chord lands at (the
 *   event's `toLyricsOffset`, expected within `[0, totalLyrics]`).
 * @param destinationChordOffsets lyrics offsets of every chord currently
 *   on the destination line (pre-move layout), in source order.
 * @param removedIndex index into `destinationChordOffsets` of the dragged
 *   chord when the move removes it from the destination line (same-line
 *   move); `-1` for a cross-line move or a copy.
 */
export function repositionedChordOrdinal(
  destinationOffset: number,
  destinationChordOffsets: readonly number[],
  removedIndex: number,
): number {
  // Exclude the dragged chord on a same-line move, then count the
  // remaining chords at the offset — the shared ordinal rule.
  const others =
    removedIndex < 0
      ? destinationChordOffsets
      : destinationChordOffsets.filter((_, i) => i !== removedIndex);
  return ordinalAtOffset(destinationOffset, others);
}

/** Result of {@link buildChordNudge}: the reposition event to fire plus
 * the chord's new `(offset, ordinal)` so the caller can advance the
 * selection to track the moved chord. */
export interface ChordNudgeResult {
  event: ChordRepositionEvent;
  offset: number;
  ordinal: number;
}

/**
 * Build the reposition event + advanced selection coordinates for
 * moving one chord one lyric character in `direction`. Shared by the
 * keyboard arrow path (in the JSX walker) and the inspector's ◀ / ▶
 * buttons so both produce identical moves (one source of nudge logic).
 *
 * Returns `null` when the move is out of bounds (the caller disables
 * the control / drops the key press).
 */
export function buildChordNudge(params: {
  /** 1-indexed source line the chord lives on (move is same-line). */
  sourceLine: number;
  /** Chord name written back into the source, e.g. `"Am7"`. */
  chordName: string;
  /** 0-indexed source column of the chord's `[`. */
  sourceColumn: number;
  /** Source-column span of `[chord]` (`name.length + 2`). */
  bracketLength: number;
  /** The chord's current lyrics offset. */
  currentOffset: number;
  /** Lyrics offsets of every OTHER chord on the line (for the
   * destination ordinal). */
  otherOffsets: readonly number[];
  /** Total visible lyric characters on the line. */
  totalLyrics: number;
  /** `-1` left, `+1` right. */
  direction: -1 | 1;
}): ChordNudgeResult | null {
  const dest = nudgeChordPosition(
    params.currentOffset,
    params.otherOffsets,
    params.totalLyrics,
    params.direction,
  );
  if (!dest) return null;
  return {
    event: {
      fromLine: params.sourceLine,
      fromColumn: params.sourceColumn,
      fromLength: params.bracketLength,
      toLine: params.sourceLine,
      toLyricsOffset: dest.offset,
      chord: params.chordName,
      copy: false,
      // A nudge moves a chord in place, so the token at the `from`
      // span is exactly the chord being moved — guard the removal
      // against that, so a stale / drifted span no-ops instead of
      // corrupting (parity with the edit / delete guards).
      expected: params.chordName,
    },
    offset: dest.offset,
    ordinal: dest.ordinal,
  };
}

// ---- Chord editing (#2622) -----------------------------------------
// The click-to-focus inspector (#2614 follow-up) edits the selected
// chord in place: root, accidental, type (quality + extension), and an
// optional slash bass. The pure helpers below build the ChordPro chord
// token from those parts and splice it back over the original
// `[chord]` at a known source position — the same source-as-truth
// model the reposition pipeline uses (no parallel chord state).

// ===========================================================================
// Structured chord-type model (ADR-0037)
// ===========================================================================
//
// ChordSketch rejects ambiguous chord notation (a bare extended "stack" such
// as `G13`, or a seventh-less parenthesised tension such as `C(9)`). The
// editor therefore does NOT offer a flat palette of chord-type chips; it
// offers three orthogonal control groups whose composition only ever yields
// an explicit, unambiguous suffix:
//
//   - Triad quality (single-select): major / minor / dim / aug, plus the
//     third-replacement triads sus2 / sus4 and the power chord (5).
//   - Seventh (single-select): none / 7 (dominant) / maj7. The seventh type
//     is independent of the tension set, so `maj7(13)` is reachable.
//   - Tensions (multi-select): 6, 9, 11, 13 and the altered tones
//     b9 / #9 / #11 / b13 / b5 / #5. With a seventh present they render in
//     ascending, comma-separated parentheses (`7(9,11,13)`); with no seventh
//     a single natural tension renders as an add-tone chord (`add9`) and 6 /
//     6-9 render as the sixth chords (`6`, `m6`, `69`). Altered tones require
//     a seventh.
//
// `composeChordSuffix` is the single source of truth for the canonical
// spelling; `decomposeChordSuffix` is its (normalising) inverse, used by the
// inspector to light up the controls for an existing chord — including legacy
// ambiguous forms, which it normalises (`G13` → seventh 7 + tensions
// {9,11,13}) so editing one cleans it up.

/** Triad quality (and third-replacement) options, single-select. */
export type ChordTriad = 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | '5';

/** Seventh options, single-select. `7` is the dominant (minor) seventh;
 * `maj7` is the major seventh. Mutually exclusive by construction. */
export type ChordSeventh = 'none' | '7' | 'maj7';

/** Tension / alteration options, multi-select. */
export type ChordTension = '6' | '9' | '11' | '13' | 'b9' | '#9' | '#11' | 'b13' | 'b5' | '#5';

/** A structured chord-type selection the three control groups manipulate. */
export interface ChordTypeSelection {
  triad: ChordTriad;
  seventh: ChordSeventh;
  /** Selected tensions. Order is not significant on input — the canonical
   * ascending order is applied by {@link composeChordSuffix}. */
  tensions: ChordTension[];
}

/** A control option: `value` is the model token, `label` is the chip face
 * (may carry display accidentals like `♭` / `♯`). */
export interface ChordTypeOption<T extends string> {
  value: T;
  label: string;
}

/** Triad chips, in display order. */
export const TRIAD_OPTIONS: ReadonlyArray<ChordTypeOption<ChordTriad>> = [
  { value: 'maj', label: 'maj' },
  { value: 'min', label: 'min' },
  { value: 'dim', label: 'dim' },
  { value: 'aug', label: 'aug' },
  { value: 'sus2', label: 'sus2' },
  { value: 'sus4', label: 'sus4' },
  { value: '5', label: '5' },
];

/** Seventh chips, in display order. */
export const SEVENTH_OPTIONS: ReadonlyArray<ChordTypeOption<ChordSeventh>> = [
  { value: 'none', label: 'none' },
  { value: '7', label: '7' },
  { value: 'maj7', label: 'maj7' },
];

/** Tension chips, in display (ascending) order. */
export const TENSION_OPTIONS: ReadonlyArray<ChordTypeOption<ChordTension>> = [
  { value: '6', label: '6' },
  { value: '9', label: '9' },
  { value: '11', label: '11' },
  { value: '13', label: '13' },
  { value: 'b9', label: '♭9' },
  { value: '#9', label: '♯9' },
  { value: '#11', label: '♯11' },
  { value: 'b13', label: '♭13' },
  { value: 'b5', label: '♭5' },
  { value: '#5', label: '♯5' },
];

/** Canonical ascending order tensions are emitted in inside parentheses
 * (by scale degree, altered fifth first). */
const TENSION_ORDER: readonly ChordTension[] = [
  'b5',
  '#5',
  'b9',
  '9',
  '#9',
  '11',
  '#11',
  'b13',
  '13',
];

const TENSION_VALUES: ReadonlySet<string> = new Set(TENSION_OPTIONS.map((o) => o.value));

/** Natural upper tensions that read as an add-tone chord with no seventh. */
const NATURAL_UPPER: readonly ChordTension[] = ['9', '11', '13'];

/** Altered tones that are only meaningful with a seventh present. */
const ALTERED_TENSIONS: readonly ChordTension[] = ['b9', '#9', '#11', 'b13', 'b5', '#5'];

/** The empty / default selection: a bare major triad. */
export const DEFAULT_CHORD_SELECTION: ChordTypeSelection = {
  triad: 'maj',
  seventh: 'none',
  tensions: [],
};

/**
 * Whether a seventh option is available for the given triad.
 *
 * - The power chord (5) is root + fifth only, so it admits no seventh.
 * - A diminished triad's only conventional seventh is the diminished seventh
 *   (`dim7`); the diminished-major-seventh is too exotic to surface, so `maj7`
 *   is unavailable on `dim`.
 * - Major / minor / augmented / sus triads admit both `7` and `maj7`.
 */
export function isSeventhAvailable(triad: ChordTriad, seventh: ChordSeventh): boolean {
  if (seventh === 'none') return true;
  if (triad === '5') return false;
  if (triad === 'dim') return seventh === '7';
  return true;
}

/** Triads that carry a tension stack: only the plain major and minor triads.
 *
 * The power chord is two-note. The dim / aug triads' identity is their altered
 * fifth and conventional harmony respells rather than stacking tensions on
 * them — the augmented-dominant colour is reached on a major / minor triad via
 * the ♯5 tension. The sus triads put the sus note on the 2nd / 4th degree, so
 * a 9 (= 2nd) or 11 (= 4th) tension duplicates the sus note and an altered 9 /
 * 11 clashes a semitone away; tensions on sus are therefore both degenerate
 * and frequently unvoiceable, so they are not offered (the free-form field
 * still accepts `7sus4(9)` for the rare case).
 *
 * Constraining tensions to major / minor triads also keeps every producible
 * chord voiceable: with at most one altered fifth essential and one headline
 * tension on a plain triad, the essential-tone count never exceeds four, so a
 * playable shape exists even on a 4-string instrument. */
const TENSION_TRIADS: ReadonlySet<ChordTriad> = new Set<ChordTriad>(['maj', 'min']);

/**
 * Whether a tension chip is available given the current triad + seventh.
 *
 * - Only major / minor triads take tensions (see {@link TENSION_TRIADS}).
 * - `6` (the sixth / 6-9 chords) is offered only with no seventh; with a
 *   seventh a sixth becomes a 13.
 * - Altered tones (b9 / #9 / #11 / b13 / b5 / #5) require a seventh.
 * - Natural upper tensions (9 / 11 / 13) are available with or without a
 *   seventh (an add-tone chord when there is no seventh).
 */
export function isTensionAvailable(
  triad: ChordTriad,
  seventh: ChordSeventh,
  tension: ChordTension,
): boolean {
  if (!TENSION_TRIADS.has(triad)) return false;
  // Tensions stack on the three common seventh chords — dominant 7, major 7,
  // and minor 7. The rarer minor-major-7 (min + maj7) is offered as a plain
  // seventh form, like dim / aug: its tension stack is exotic and its 4
  // essential tones do not always fit a 4-string instrument.
  if (triad === 'min' && seventh === 'maj7') return false;
  if (tension === '6') {
    return seventh === 'none';
  }
  if ((ALTERED_TENSIONS as readonly string[]).includes(tension)) {
    return seventh !== 'none';
  }
  // Natural upper tensions (9 / 11 / 13).
  return true;
}

/** Renders the triad + seventh "quality core" of a canonical suffix. */
function qualityCore(triad: ChordTriad, seventh: ChordSeventh): string {
  if (triad === '5') return '5';
  if (triad === 'sus2' || triad === 'sus4') {
    if (seventh === '7') return `7${triad}`;
    if (seventh === 'maj7') return `maj7${triad}`;
    return triad;
  }
  const base = triad === 'min' ? 'm' : triad === 'dim' ? 'dim' : triad === 'aug' ? 'aug' : '';
  if (seventh === 'none') return base;
  if (seventh === '7') {
    return triad === 'min' ? 'm7' : `${base}7`;
  }
  // maj7 — the minor/major-seventh case is conventionally spelled `mMaj7`.
  return triad === 'min' ? 'mMaj7' : `${base}maj7`;
}

/** Sorts tensions into the canonical ascending order. */
function sortTensions(tensions: readonly ChordTension[]): ChordTension[] {
  const present = new Set(tensions);
  return TENSION_ORDER.filter((t) => present.has(t));
}

/**
 * Compose the canonical, unambiguous chord suffix (the text after the root +
 * accidental, before any `/bass`) from a structured selection.
 *
 * Tokens the current triad / seventh make unavailable (see
 * {@link isTensionAvailable}) are ignored, so a stale tension left in
 * `tensions` after the seventh is cleared never leaks into the output.
 */
export function composeChordSuffix(selection: ChordTypeSelection): string {
  const { triad, seventh: rawSeventh } = selection;
  const seventh = isSeventhAvailable(triad, rawSeventh) ? rawSeventh : 'none';
  const tensions = selection.tensions.filter((t) => isTensionAvailable(triad, seventh, t));
  const core = qualityCore(triad, seventh);

  if (seventh === 'none') {
    // Sixth chords and add-tone chords carry no parentheses.
    if (tensions.includes('6')) {
      // `6` / `m6`, plus the 6-9 chord when the 9 is also chosen.
      return `${core}6${tensions.includes('9') ? '9' : ''}`;
    }
    const add = NATURAL_UPPER.find((t) => tensions.includes(t));
    return add ? `${core}add${add}` : core;
  }

  // Seventh present: every selected tension renders in ascending parentheses.
  const inParens = sortTensions(tensions);
  return inParens.length > 0 ? `${core}(${inParens.join(',')})` : core;
}

/** Expands a bare-stack headline into its implied ascending tensions. */
function stackTensions(headline: '9' | '11' | '13'): ChordTension[] {
  if (headline === '9') return ['9'];
  if (headline === '11') return ['9', '11'];
  return ['9', '11', '13'];
}

/**
 * Decompose a chord suffix into a structured selection, or `null` when the
 * suffix is not one the structured controls can model (e.g. `7alt`, or any
 * free-form text) — in which case the inspector falls back to the free-form
 * field.
 *
 * Recognised inputs include every form {@link composeChordSuffix} emits, plus
 * the common equivalent / legacy spellings, which are **normalised**:
 * concatenated alterations (`7b9`, `m7b5`), bare extended stacks
 * (`9`, `m13`, `maj9`), and `9sus4` all decode to the explicit selection, so
 * re-composing yields the canonical spelling.
 */
export function decomposeChordSuffix(suffix: string): ChordTypeSelection | null {
  if (suffix === '5') {
    return { triad: '5', seventh: 'none', tensions: [] };
  }

  // 1. Split off a trailing parenthesised tension group, if any.
  const tensions: ChordTension[] = [];
  let base = suffix;
  if (suffix.includes('(') || suffix.includes(')')) {
    const m = suffix.match(/^([^()]*)\(([^()]+)\)$/);
    if (!m) return null;
    base = m[1];
    for (const tok of m[2].split(',')) {
      const t = tok.trim();
      if (!TENSION_VALUES.has(t)) return null;
      tensions.push(t as ChordTension);
    }
  }

  // 2. Pull out a sus2 / sus4 third-replacement (independent of triad word).
  let susKind: 'sus2' | 'sus4' | null = null;
  let b = base;
  if (b.includes('sus2')) {
    susKind = 'sus2';
    b = b.replace('sus2', '');
  } else if (b.includes('sus4')) {
    susKind = 'sus4';
    b = b.replace('sus4', '');
  }

  // 3. Triad word. `maj…` is left intact — `maj` is the seventh, not the triad.
  let triad: ChordTriad;
  let rest: string;
  if (b.startsWith('dim')) {
    triad = 'dim';
    rest = b.slice(3);
  } else if (b.startsWith('aug')) {
    triad = 'aug';
    rest = b.slice(3);
  } else if (b.startsWith('min')) {
    triad = 'min';
    rest = b.slice(3);
  } else if (b.startsWith('maj')) {
    triad = 'maj';
    rest = b;
  } else if (b.startsWith('m')) {
    triad = 'min';
    rest = b.slice(1);
  } else {
    triad = 'maj';
    rest = b;
  }
  if (susKind) triad = susKind;

  // 4. Seventh.
  let seventh: ChordSeventh = 'none';
  if (rest.startsWith('maj7') || rest.startsWith('Maj7')) {
    seventh = 'maj7';
    rest = rest.slice(4);
  } else if (rest.startsWith('maj')) {
    // Bare major-seventh stack: `maj9` / `maj11` / `maj13`.
    const after = rest.slice(3);
    if (after === '9' || after === '11' || after === '13') {
      seventh = 'maj7';
      for (const t of stackTensions(after)) tensions.push(t);
      rest = '';
    } else {
      return null;
    }
  } else if (rest.startsWith('7')) {
    seventh = '7';
    rest = rest.slice(1);
  }

  // 5. Remaining tail: a concatenated alteration, a bare stack, a sixth, or
  //    an add-tone marker. Anything else is unmodelled → free-form.
  if (rest !== '') {
    if (TENSION_VALUES.has(rest) && (ALTERED_TENSIONS as readonly string[]).includes(rest)) {
      tensions.push(rest as ChordTension);
    } else if (seventh === 'none' && (rest === '9' || rest === '11' || rest === '13')) {
      // Bare dominant stack (`C9`, `C13`): normalise to an explicit seventh.
      seventh = '7';
      for (const t of stackTensions(rest)) tensions.push(t);
    } else if (rest === '6') {
      tensions.push('6');
    } else if (rest === '69') {
      tensions.push('6', '9');
    } else if (rest.startsWith('add')) {
      const a = rest.slice(3);
      if (a === '9' || a === '11' || a === '13') {
        tensions.push(a as ChordTension);
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  // De-duplicate while preserving the model (order is normalised on compose).
  const unique = Array.from(new Set(tensions));
  // Reject any selection that survived parsing but is not actually
  // reachable through the controls (e.g. an altered tone with no seventh,
  // which would mean the input was something we mis-parsed): such a chord is
  // better left to the free-form field than shown with a misleading
  // selection.
  for (const t of unique) {
    if (!isTensionAvailable(triad, seventh, t)) return null;
  }
  return { triad, seventh, tensions: unique };
}

/**
 * Apply a triad change to a selection, dropping any tension the new triad
 * makes unavailable and demoting the seventh if the new triad forbids it.
 */
export function withTriad(selection: ChordTypeSelection, triad: ChordTriad): ChordTypeSelection {
  const seventh = isSeventhAvailable(triad, selection.seventh) ? selection.seventh : 'none';
  const tensions = selection.tensions.filter((t) => isTensionAvailable(triad, seventh, t));
  return { triad, seventh, tensions };
}

/**
 * Apply a seventh change to a selection, dropping any tension the new seventh
 * makes unavailable (e.g. clearing the seventh drops the altered tones).
 */
export function withSeventh(
  selection: ChordTypeSelection,
  seventh: ChordSeventh,
): ChordTypeSelection {
  if (!isSeventhAvailable(selection.triad, seventh)) return selection;
  const tensions = selection.tensions.filter((t) =>
    isTensionAvailable(selection.triad, seventh, t),
  );
  return { ...selection, seventh, tensions };
}

/**
 * Toggle a tension in a selection. With no seventh present the natural upper
 * tensions (9 / 11 / 13) are mutually exclusive (a chord can only be one of
 * add9 / add11 / add13), so selecting one clears the others.
 */
export function toggleTension(
  selection: ChordTypeSelection,
  tension: ChordTension,
): ChordTypeSelection {
  if (!isTensionAvailable(selection.triad, selection.seventh, tension)) return selection;
  const present = selection.tensions.includes(tension);
  let tensions: ChordTension[];
  if (present) {
    tensions = selection.tensions.filter((t) => t !== tension);
  } else if (
    selection.seventh === 'none' &&
    (NATURAL_UPPER as readonly string[]).includes(tension)
  ) {
    // add9 / add11 / add13 are mutually exclusive without a seventh.
    tensions = [
      ...selection.tensions.filter((t) => !(NATURAL_UPPER as readonly string[]).includes(t)),
      tension,
    ];
  } else {
    tensions = [...selection.tensions, tension];
  }
  return { ...selection, tensions };
}

/**
 * Enumerate a representative-complete set of the canonical suffixes the
 * editor can produce: every (triad × seventh) base, every base plus a single
 * tension, and the natural full stacks (`(9,11)`, `(9,11,13)`, `69`).
 *
 * This is the TypeScript half of the chord-diagram coverage sister list
 * (`.claude/rules/chord-diagram-coverage.md`): `tests/chord-type-coverage.test.ts`
 * asserts this set equals `PALETTE_SUFFIXES` in
 * `crates/chordpro/src/voicings.rs`, which the Rust suite then proves yields a
 * playable diagram on every instrument and every root. Multi-altered tension
 * combinations beyond this set are covered structurally by the algorithmic
 * voicing synthesiser (it works from a chord's pitch-class content), per that
 * rule.
 */
export function enumerateEditorSuffixes(): string[] {
  const out = new Set<string>();
  for (const { value: triad } of TRIAD_OPTIONS) {
    for (const { value: seventh } of SEVENTH_OPTIONS) {
      if (!isSeventhAvailable(triad, seventh)) continue;
      out.add(composeChordSuffix({ triad, seventh, tensions: [] }));
      for (const { value: t } of TENSION_OPTIONS) {
        if (!isTensionAvailable(triad, seventh, t)) continue;
        out.add(composeChordSuffix({ triad, seventh, tensions: [t] }));
      }
      if (seventh === 'none') {
        if (isTensionAvailable(triad, 'none', '6')) {
          out.add(composeChordSuffix({ triad, seventh, tensions: ['6', '9'] }));
        }
      } else {
        out.add(composeChordSuffix({ triad, seventh, tensions: ['9', '11'] }));
        out.add(composeChordSuffix({ triad, seventh, tensions: ['9', '11', '13'] }));
      }
    }
  }
  return Array.from(out).sort();
}

/** Quality enum values mirrored from `ChordproChordQuality` — kept as a
 * plain string union so this module stays free of an AST-type import. */
export type ChordQualityName = 'major' | 'minor' | 'diminished' | 'augmented';

/**
 * Reconstruct the chord suffix (the text after the root + accidental,
 * before any `/bass`) from a parsed quality + extension. This is the
 * inverse of how the parser splits a chord, so it round-trips: e.g.
 * `(minor, "7")` → `"m7"`, `(major, "maj7")` → `"maj7"`,
 * `(diminished, null)` → `"dim"`, `(major, null)` → `""`.
 *
 * Standalone quality→suffix utility exposed for external hosts that
 * resolve a chord from a parser quality + extension split. The bundled
 * inspector does NOT use it — it derives parts from the raw chord name
 * via `partsFromRawName` so editing stays transpose-safe (it must never
 * read the transposed `chord.detail`). Kept as public API for consumers
 * driving the editor from a structured chord rather than a raw name.
 */
export function chordSuffixFromQuality(
  quality: ChordQualityName,
  extension: string | null,
): string {
  const base =
    quality === 'minor'
      ? 'm'
      : quality === 'diminished'
        ? 'dim'
        : quality === 'augmented'
          ? 'aug'
          : ''; // major
  return `${base}${extension ?? ''}`;
}

/** The component parts the chord editor manipulates. */
export interface ChordParts {
  /** Root note letter `A`–`G` (uppercase). */
  root: string;
  /** Root accidental: `''` (natural), `'#'` (sharp), or `'b'` (flat). */
  accidental?: '' | '#' | 'b';
  /** Quality + extension suffix written after the root, e.g. `'m7'`,
   * `'maj7'`, `'sus4'`. Empty for a bare major triad. */
  suffix?: string;
  /** Optional slash-bass token (without the leading `/`), e.g. `'G'`,
   * `'F#'`. Empty / omitted = no slash. */
  bass?: string;
}

/**
 * Build a ChordPro chord token body (the text that goes inside the
 * `[...]`, without the brackets) from its parts.
 *
 * `root + accidental + suffix + (bass ? "/" + bass : "")`.
 *
 * Throws if the root is not a single `A`–`G` letter, if the accidental
 * is not one of `''` / `'#'` / `'b'`, or if `suffix` / `bass` contain a
 * character that would break the ChordPro source structure (brackets,
 * braces, angle brackets, slash inside the suffix, newlines). The throw
 * is defense-in-depth — the editor UI only ever produces valid parts —
 * mirroring {@link applyChordReposition}'s chord-name guard.
 */
export function buildChordName(parts: ChordParts): string {
  const { root } = parts;
  if (typeof root !== 'string' || !/^[A-G]$/.test(root)) {
    throw new Error(`chord root must be a single A-G letter, got ${JSON.stringify(root)}`);
  }
  const accidental = parts.accidental ?? '';
  if (accidental !== '' && accidental !== '#' && accidental !== 'b') {
    throw new Error(`chord accidental must be '', '#', or 'b', got ${JSON.stringify(accidental)}`);
  }
  const suffix = parts.suffix ?? '';
  // The suffix sits before the slash, so it must not itself contain a
  // `/` (that would create a spurious bass split) on top of the shared
  // structural denylist.
  if (CHORD_FORBIDDEN_RE.test(suffix) || suffix.includes('/')) {
    throw new Error(`chord suffix ${JSON.stringify(suffix)} contains a forbidden character`);
  }
  const bass = parts.bass ?? '';
  if (CHORD_FORBIDDEN_RE.test(bass) || bass.includes('/')) {
    throw new Error(`chord bass ${JSON.stringify(bass)} contains a forbidden character`);
  }
  return `${root}${accidental}${suffix}${bass ? `/${bass}` : ''}`;
}

/** Describes an in-place chord edit in source-coordinate terms. */
export interface ChordEditEvent {
  /** 1-indexed source line of the chord being edited. */
  line: number;
  /** 0-indexed source column of the original `[` opening bracket. */
  fromColumn: number;
  /** Source-column span of the original `[chord]`, including both
   * brackets (`oldName.length + 2`). */
  fromLength: number;
  /** New chord token body (without brackets), e.g. `"Am7"`. Build it
   * with {@link buildChordName}. */
  chord: string;
  /** Optional optimistic-concurrency guard: the chord token body
   * expected at the target span. When provided, the edit is a no-op
   * (source returned unchanged) if the current source there is not
   * `[expected]` — this prevents a stale event (built against an
   * older source that has not finished re-parsing) from splicing at
   * the wrong span. Omit to skip the check. */
  expected?: string;
}

/**
 * Apply an in-place chord edit: replace the `[chord]` token at
 * `(line, fromColumn)` spanning `fromLength` columns with
 * `[evt.chord]`, returning the updated source plus a caret offset
 * pointing just past the rewritten bracket.
 *
 * Throws if `line` / the column span is out of range, or if
 * `evt.chord` is empty or contains a structurally dangerous character
 * (same guard as {@link applyChordReposition}).
 */
export function applyChordEdit(source: string, evt: ChordEditEvent): ChordRepositionResult {
  if (typeof evt.chord !== 'string' || evt.chord.length === 0) {
    throw new Error('chord must be a non-empty string');
  }
  if (CHORD_FORBIDDEN_RE.test(evt.chord)) {
    throw new Error(
      `chord ${JSON.stringify(evt.chord)} contains forbidden character ` +
        '(brackets, braces, angle bracket, newline / carriage return)',
    );
  }
  const lines = source.split('\n');
  const lineIdx = evt.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    throw new Error(`line ${evt.line} out of range (lines: ${lines.length})`);
  }
  const lineText = lines[lineIdx];
  if (evt.fromColumn < 0 || evt.fromColumn + evt.fromLength > lineText.length) {
    throw new Error(
      `edit range [${evt.fromColumn}, ${evt.fromColumn + evt.fromLength}) ` +
        `exceeds line length ${lineText.length}`,
    );
  }
  // Optimistic-concurrency guard: if the caller told us what token to
  // expect at the span and the live source no longer matches (a stale
  // event from an edit whose re-parse hasn't landed), no-op instead of
  // splicing at the wrong place. Caret stays at the target column.
  if (
    evt.expected !== undefined &&
    lineText.slice(evt.fromColumn, evt.fromColumn + evt.fromLength) !== `[${evt.expected}]`
  ) {
    let caret = 0;
    for (let i = 0; i < lineIdx; i++) caret += lines[i].length + 1;
    return { text: source, caretOffset: caret + evt.fromColumn };
  }
  const insertBracket = `[${evt.chord}]`;
  lines[lineIdx] =
    lineText.slice(0, evt.fromColumn) + insertBracket + lineText.slice(evt.fromColumn + evt.fromLength);

  let caretOffset = 0;
  for (let i = 0; i < lineIdx; i++) {
    caretOffset += lines[i].length + 1; // +1 for the `\n`
  }
  caretOffset += evt.fromColumn + insertBracket.length;

  return { text: lines.join('\n'), caretOffset };
}

/**
 * Split a raw ChordPro chord name (as it appears between the brackets in
 * source, e.g. `"Bbm7/F"`) into the editor parts {@link ChordParts}
 * carries: root letter, accidental, quality+extension suffix, and an
 * optional slash bass.
 *
 * The split is the inverse of {@link buildChordName}, so
 * `root + accidental + suffix (+ "/" + bass)` round-trips back to the
 * original name. It operates on the RAW source name — never on a
 * transposed `chord.detail` / `chord.display` — so editing stays
 * transpose-safe (a non-zero effective transpose rewrites the rendered
 * spelling but the source token is unchanged).
 *
 * Rootless or non-standard names (e.g. `N.C.`) yield an empty `root`,
 * which {@link buildChordName} rejects — so a stray edit on such a token
 * is dropped rather than corrupting it by defaulting the root to `C`.
 * The chord stays selectable (badge / move / delete), just not
 * root/type-editable until the user sets a root.
 */
export function partsFromRawName(
  name: string,
): { root: string; accidental: '' | '#' | 'b'; suffix: string; bass: string } {
  const slash = name.indexOf('/');
  const head = slash >= 0 ? name.slice(0, slash) : name;
  const bass = slash >= 0 ? name.slice(slash + 1) : '';
  const hasRoot = /^[A-G]/.test(head);
  const root = hasRoot ? head[0] : '';
  let rest = hasRoot ? head.slice(1) : head;
  let accidental: '' | '#' | 'b' = '';
  if (rest[0] === '#') {
    accidental = '#';
    rest = rest.slice(1);
  } else if (rest[0] === 'b') {
    accidental = 'b';
    rest = rest.slice(1);
  }
  return { root, accidental, suffix: rest, bass };
}

/**
 * A `[chord]` token resolved out of the raw source by the editor caret —
 * everything the shell-level chord editor needs to (a) drive a
 * selection (`line` / `offset` / `ordinal`) and (b) feed the in-place
 * edit / nudge / delete helpers ({@link applyChordEdit},
 * {@link buildChordNudge}, {@link applyChordDelete}). Mirrors the
 * coordinate set those helpers consume so the caret path and the
 * preview-click path resolve to the same shape.
 */
export interface CaretChordMatch {
  /** 1-indexed source line the chord lives on. */
  line: number;
  /** 0-indexed source column of the chord's `[` opening bracket. */
  sourceColumn: number;
  /** Source-column span of `[chord]` including both brackets
   * (= `chordName.length + 2`). */
  bracketLength: number;
  /** Raw chord name without brackets, e.g. `"Bbm7"`. */
  chordName: string;
  /** Editable parts split from {@link chordName} via
   * {@link partsFromRawName}. */
  parts: { root: string; accidental: '' | '#' | 'b'; suffix: string; bass: string };
  /** The chord's 0-indexed lyrics offset (lyric characters before its
   * `[`), i.e. the selection's `offset`. */
  offset: number;
  /** Index of this chord among the chords on the line that share
   * `offset`, left to right — the selection's `ordinal`, disambiguating
   * stacked chords like `[A][B]word`. */
  ordinal: number;
  /** Lyrics offsets of every OTHER chord on the line (the matched chord
   * excluded), in source order — feeds {@link buildChordNudge}'s
   * destination-ordinal math. */
  otherOffsets: number[];
  /** Total visible lyric characters on the line. */
  totalLyrics: number;
}

/** One `[chord]` token found while scanning a raw source line. */
interface LineChordToken {
  colStart: number;
  colClose: number;
  name: string;
  lyricsOffset: number;
}

/**
 * Scan a single raw source line left to right, returning every
 * `[chord]` token with its column span, body, and zero-width lyrics
 * offset (lyric characters before its `[`). Chord brackets do not count
 * toward the lyrics offset — consistent with the convention used
 * throughout this module. An unterminated `[` ends the scan (the
 * remainder is treated as lyrics), so the function is total for
 * malformed input.
 */
function scanLineChords(line: string): { tokens: LineChordToken[]; totalLyrics: number } {
  const tokens: LineChordToken[] = [];
  let lyricsCount = 0;
  let i = 0;
  while (i < line.length) {
    // An escaped special (`\[`, `\]`, …) is a literal lyric character, never a
    // chord delimiter — count one lyric char and step past both columns so a
    // chord after `do\[re` is detected at its true column (#2634).
    if (isEscapedSpecial(line, i)) {
      lyricsCount++;
      i += 2;
      continue;
    }
    if (line[i] === '[') {
      const close = chordCloseIndex(line, i);
      if (close === -1) {
        // Unterminated bracket — treat the rest as lyrics, counting visible
        // lyric characters (escaped specials collapse to one).
        lyricsCount += countLyricChars(line, i);
        return { tokens, totalLyrics: lyricsCount };
      }
      tokens.push({
        colStart: i,
        colClose: close,
        // RAW body, including any escape backslashes. This is deliberate: the
        // name feeds the edit `expected` optimistic-concurrency guard, which
        // compares `'[' + name + ']'` against the live source slice — so the
        // name must round-trip the source verbatim. `'[' + 'A\]m' + ']'`
        // matches the source `[A\]m]`; the escape-resolved `A]m` would not and
        // would no-op every edit of such a chord. Chord names containing an
        // escaped special are pathological non-chords; this caret-driven path
        // still edits them correctly, while the AST path (which carries the
        // escape-resolved name) no-ops them — a documented edge (#2634).
        name: line.slice(i + 1, close),
        lyricsOffset: lyricsCount,
      });
      i = close + 1;
      continue;
    }
    lyricsCount++;
    i++;
  }
  return { tokens, totalLyrics: lyricsCount };
}

/** Count visible lyric characters in `line` from `start` to the end, treating
 * each escaped special (`\[`, `\]`, …) as a single character. Used on the
 * unterminated-bracket fall-through so the lyric count matches the AST's
 * post-lex character count rather than the raw source length. */
function countLyricChars(line: string, start: number): number {
  let count = 0;
  let i = start;
  while (i < line.length) {
    if (isEscapedSpecial(line, i)) {
      count++;
      i += 2;
    } else {
      count++;
      i++;
    }
  }
  return count;
}

/**
 * Extract the `{key}` value a single source `line` declares, or `null` when
 * the line is not a key directive.
 *
 * Recognises the directive shapes the core parser
 * (`chordsketch_chordpro::parse_directive_line`) classifies as a key: the
 * dedicated `{key: C}` / `{key C}` form and the generic-metadata `{meta: key
 * C}` / `{meta key C}` form, with the directive name matched
 * case-insensitively and the value separated by a colon or whitespace. The
 * value is returned trimmed but otherwise raw — its leniency (`C`, `Am`,
 * `F# minor`, unicode accidentals) is interpreted downstream by the
 * key-signature resolver (sister to `parse_key`).
 *
 * Selector-suffixed conditional keys (`{key-guitar: C}`) are intentionally
 * NOT matched: they apply only under an instrument filter, so they do not
 * define the staff's key in the plain editor view.
 */
function keyDirectiveValue(line: string): string | null {
  // A directive occupies a whole `{…}` token; scan the first brace group.
  // Key directives stand alone on their line in practice, so the first group
  // is the directive, and this never matches a `[chord]` bracket.
  //
  // The pattern is a single greedy character class with no overlapping
  // quantifier, so matching is linear: a leading `\s*` here would overlap
  // `[^{}]*` on whitespace and backtrack O(n²) on a `{`-then-whitespace line
  // with no closing brace (a denial-of-service surface, since this runs per
  // line on every keystroke). Leading/trailing whitespace inside the braces
  // is stripped below instead.
  const brace = /\{([^{}]*)\}/.exec(line);
  if (brace === null) return null;
  const inner = brace[1]!.trim();
  if (inner.length === 0) return null;

  // Split the directive name from its value at the first `:` (explicit value)
  // or, lacking one, the first whitespace (the attribute form `{key C}`).
  let name: string;
  let value: string;
  const colon = inner.indexOf(':');
  if (colon !== -1) {
    name = inner.slice(0, colon).trim();
    value = inner.slice(colon + 1).trim();
  } else {
    const ws = inner.search(/\s/);
    if (ws === -1) {
      name = inner;
      value = '';
    } else {
      name = inner.slice(0, ws).trim();
      value = inner.slice(ws + 1).trim();
    }
  }

  const lowerName = name.toLowerCase();
  if (lowerName === 'key') {
    return value.length > 0 ? value : null;
  }
  if (lowerName === 'meta') {
    // `{meta}` splits its value into a meta-key and the remaining value; only
    // `key` matters here.
    const ws = value.search(/\s/);
    if (ws === -1) return null;
    const metaKey = value.slice(0, ws).toLowerCase();
    if (metaKey !== 'key') return null;
    const metaValue = value.slice(ws + 1).trim();
    return metaValue.length > 0 ? metaValue : null;
  }
  return null;
}

/**
 * The song key in effect at 1-indexed `line` of `source` — the value of the
 * last `{key}` directive on or before that line, or `null` when none precedes
 * it.
 *
 * This honours mid-song modulation: a `{key}` change lower in the song
 * overrides an earlier one for every chord beneath it, so the chord editor's
 * constituent-notes staff reflects the key actually sounding at the selected
 * chord's position rather than a single song-wide key. The returned value is
 * raw (see {@link keyDirectiveValue}); the staff's key-signature resolver
 * interprets it.
 */
export function activeKeyAtLine(source: string, line: number): string | null {
  const lines = source.split('\n');
  const limit = Math.min(line, lines.length);
  let active: string | null = null;
  for (let i = 0; i < limit; i++) {
    const value = keyDirectiveValue(lines[i]!);
    if (value !== null) active = value;
  }
  return active;
}

/**
 * Resolve the `[chord]` token under the editor caret into the
 * coordinates + parts the shell-level chord editor needs.
 *
 * `caretOffset` is the absolute 0-indexed character offset of the caret
 * into `source` (clamped into range). The caret is "on" a chord exactly
 * when it sits within that chord's bracket span `[colStart, colClose]` —
 * anywhere from the `[` to the `]` inclusive. A caret immediately after
 * the `]` is in the lyrics, not on the chord (so building + inserting a
 * new chord at the lyric start stays reachable). Adjacent stacked chords
 * (`[A][B]`) are unambiguous: the `][` boundary column equals the
 * right-hand chord's `[`, so it selects the right-hand chord.
 *
 * Returns `null` when the caret is not on any chord (e.g. it is in the
 * lyrics, on a directive line, or the line has no chords) — the shell
 * treats that as "no selection" and shows the idle editor.
 */
export function findChordAtCaret(source: string, caretOffset: number): CaretChordMatch | null {
  const clamped = Math.max(0, Math.min(caretOffset, source.length));
  const lines = source.split('\n');
  // Locate (lineIdx, column) for the absolute offset. Each line consumes
  // `length + 1` characters (the trailing `\n`); a caret exactly on a
  // newline is attributed to the end of the line it terminates.
  let lineIdx = 0;
  let consumed = 0;
  while (lineIdx < lines.length) {
    const lineLen = lines[lineIdx].length;
    if (clamped <= consumed + lineLen) break;
    consumed += lineLen + 1;
    lineIdx++;
  }
  if (lineIdx >= lines.length) return null;
  const lineText = lines[lineIdx];
  const column = clamped - consumed;

  const { tokens, totalLyrics } = scanLineChords(lineText);
  if (tokens.length === 0) return null;

  // Caret within a bracket span `[colStart, colClose]` (inclusive of
  // both brackets). A caret after the `]` falls through to the lyrics
  // (null) so inserting a new chord there stays reachable.
  const matchIdx = tokens.findIndex((t) => column >= t.colStart && column <= t.colClose);
  if (matchIdx < 0) return null;

  const target = tokens[matchIdx];
  const ordinal = tokens
    .slice(0, matchIdx)
    .reduce((n, t) => (t.lyricsOffset === target.lyricsOffset ? n + 1 : n), 0);
  const otherOffsets = tokens.filter((_, i) => i !== matchIdx).map((t) => t.lyricsOffset);

  return {
    line: lineIdx + 1,
    sourceColumn: target.colStart,
    bracketLength: target.colClose - target.colStart + 1,
    chordName: target.name,
    parts: partsFromRawName(target.name),
    offset: target.lyricsOffset,
    ordinal,
    otherOffsets,
    totalLyrics,
  };
}

/**
 * Resolve a chord selection — `(line, offset, ordinal)` as the JSX
 * walker / `findChordAtCaret` produce it — back to the absolute
 * 0-indexed source offset of that chord's `[` opening bracket.
 *
 * Used by the shell-level editor to move the editor caret onto a chord
 * the user clicked in the preview, so the single caret-driven selection
 * path then re-resolves it. Returns `null` when the selection no longer
 * maps to a chord (e.g. the source changed out from under a stale
 * click). Scans the raw source line (not the post-lex AST layout), so
 * the offset points at the real bracket column.
 */
export function chordSelectionCaretOffset(
  source: string,
  selection: { line: number; offset: number; ordinal: number },
): number | null {
  const lines = source.split('\n');
  const lineIdx = selection.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  const { tokens } = scanLineChords(lines[lineIdx]);
  const atOffset = tokens.filter((t) => t.lyricsOffset === selection.offset);
  const target = atOffset[selection.ordinal];
  if (!target) return null;
  let base = 0;
  for (let i = 0; i < lineIdx; i++) base += lines[i].length + 1;
  return base + target.colStart;
}

/** Describes inserting a brand-new `[chord]` token at the caret. */
export interface ChordInsertEvent {
  /** 1-indexed source line to insert on. */
  line: number;
  /** 0-indexed source column to insert the `[chord]` bracket at
   * (typically the editor caret column). Clamped into
   * `[0, lineLength]`. If it lands strictly inside an existing
   * `[...]` token, the insertion snaps to just after that token's `]`
   * so a fresh chord can never split an existing bracket. */
  column: number;
  /** Chord body without brackets, e.g. `"Am7"`. Build it with
   * {@link buildChordName}. */
  chord: string;
}

/**
 * Insert a new `[chord]` token into the source at `(line, column)`,
 * returning the updated source plus a caret offset pointing just past
 * the inserted bracket (so the editor caret lands at the natural "I just
 * inserted here" position).
 *
 * Unlike {@link applyChordReposition}, this neither removes an existing
 * bracket nor re-derives the column from a lyrics offset — it splices a
 * literal `[chord]` at the caret column, snapping out of any bracket the
 * caret happens to sit inside (see {@link ChordInsertEvent.column}).
 *
 * Throws if `line` is out of range or `evt.chord` is empty / contains a
 * structurally dangerous character (same guard as
 * {@link applyChordReposition}).
 */
export function applyChordInsert(source: string, evt: ChordInsertEvent): ChordRepositionResult {
  if (typeof evt.chord !== 'string' || evt.chord.length === 0) {
    throw new Error('chord must be a non-empty string');
  }
  if (CHORD_FORBIDDEN_RE.test(evt.chord)) {
    throw new Error(
      `chord ${JSON.stringify(evt.chord)} contains forbidden character ` +
        '(brackets, braces, angle bracket, newline / carriage return)',
    );
  }
  const lines = source.split('\n');
  const lineIdx = evt.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    throw new Error(`line ${evt.line} out of range (lines: ${lines.length})`);
  }
  const lineText = lines[lineIdx];
  let column = Math.max(0, Math.min(evt.column, lineText.length));
  // Snap out of any `[...]` the caret sits strictly inside, so a new
  // chord is never spliced into the middle of an existing token.
  const { tokens } = scanLineChords(lineText);
  for (const t of tokens) {
    if (column > t.colStart && column <= t.colClose) {
      column = t.colClose + 1;
      break;
    }
  }
  const insertBracket = `[${evt.chord}]`;
  lines[lineIdx] = lineText.slice(0, column) + insertBracket + lineText.slice(column);

  let caretOffset = 0;
  for (let i = 0; i < lineIdx; i++) {
    caretOffset += lines[i].length + 1; // +1 for the `\n`
  }
  caretOffset += column + insertBracket.length;

  return { text: lines.join('\n'), caretOffset };
}

/** Identifies a chord token to delete, in source coordinates. */
export interface ChordDeleteTarget {
  /** 1-indexed source line. */
  line: number;
  /** 0-indexed source column of the `[` opening bracket. */
  fromColumn: number;
  /** Source-column span of `[chord]`, including both brackets. */
  fromLength: number;
  /** Optional optimistic-concurrency guard — see
   * {@link ChordEditEvent.expected}. When the live source at the span
   * is not `[expected]`, the delete is a no-op. */
  expected?: string;
}

/**
 * Delete the `[chord]` token at `(line, fromColumn)` spanning
 * `fromLength` columns, returning the updated source plus a caret
 * offset at the deletion point. The lyric text the chord annotated is
 * left untouched; only the bracketed chord is removed.
 *
 * Throws if `line` or the column span is out of range.
 */
export function applyChordDelete(
  source: string,
  evt: ChordDeleteTarget,
): ChordRepositionResult {
  const lines = source.split('\n');
  const lineIdx = evt.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    throw new Error(`line ${evt.line} out of range (lines: ${lines.length})`);
  }
  const lineText = lines[lineIdx];
  if (evt.fromColumn < 0 || evt.fromColumn + evt.fromLength > lineText.length) {
    throw new Error(
      `delete range [${evt.fromColumn}, ${evt.fromColumn + evt.fromLength}) ` +
        `exceeds line length ${lineText.length}`,
    );
  }
  if (
    evt.expected !== undefined &&
    lineText.slice(evt.fromColumn, evt.fromColumn + evt.fromLength) !== `[${evt.expected}]`
  ) {
    let caret = 0;
    for (let i = 0; i < lineIdx; i++) caret += lines[i].length + 1;
    return { text: source, caretOffset: caret + evt.fromColumn };
  }
  lines[lineIdx] = lineText.slice(0, evt.fromColumn) + lineText.slice(evt.fromColumn + evt.fromLength);

  let caretOffset = 0;
  for (let i = 0; i < lineIdx; i++) {
    caretOffset += lines[i].length + 1;
  }
  caretOffset += evt.fromColumn;

  return { text: lines.join('\n'), caretOffset };
}
