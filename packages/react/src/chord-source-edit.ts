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
    // Skip any chord brackets at the current position FIRST so a
    // drop at the "start of the lyric" lands AFTER any leading
    // `[chord]` brackets — i.e. the new chord becomes the one
    // sitting above the lyric, instead of being pushed into a
    // zero-width segment before the existing brackets. Loop so
    // adjacent brackets like `[A][B]` are all skipped before
    // checking the lyric counter.
    while (i < line.length && line[i] === '[') {
      const close = line.indexOf(']', i);
      if (close === -1) {
        // Malformed bracket — bail out, treat the rest as lyrics.
        return i;
      }
      i = close + 1;
    }
    if (lyricsCount >= lyricsOffset) return i;
    if (i >= line.length) return line.length;
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
  if (/[\[\]{}<\n\r]/.test(evt.chord)) {
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
    if (line[i] === '[') {
      const close = line.indexOf(']', i);
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
  const ordinal = otherOffsets.reduce((n, o) => (o === offset ? n + 1 : n), 0);
  return { offset, ordinal };
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
