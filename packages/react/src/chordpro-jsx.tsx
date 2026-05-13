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

import { Fragment, cloneElement, isValidElement } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';

import { ChordDiagram } from './chord-diagram';
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
      const style: CSSProperties = {};
      if (span.attributes.fontFamily) style.fontFamily = span.attributes.fontFamily;
      if (span.attributes.size) style.fontSize = span.attributes.size;
      if (span.attributes.foreground) style.color = span.attributes.foreground;
      if (span.attributes.background) style.backgroundColor = span.attributes.background;
      if (span.attributes.weight) style.fontWeight = span.attributes.weight;
      if (span.attributes.style) style.fontStyle = span.attributes.style;
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

// ---- Chord rendering ----------------------------------------------

function renderChord(chord: ChordproChord): string {
  return chord.display ?? chord.name;
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
): JSX.Element {
  // If ANY segment on this line carries a chord, every other
  // segment needs a chord-row placeholder so the lyric baselines
  // stay aligned. A genuinely empty `<span class="chord"/>`
  // produces no line box in most browsers — `min-height: 1em`
  // does not reserve the row on its own — so chordless segments
  // float up by one row and the lyric on those segments lines up
  // with the CHORD row of its neighbours instead of the LYRIC
  // row. Emit a ` ` NBSP placeholder (matching
  // `chordsketch-render-html`'s sister-site logic in
  // `render_lyrics_line`, #2142) and mark it `aria-hidden` so
  // assistive tech does not announce it as "space". See
  // ADR-0017 for the broader sister-site parity contract.
  const lineHasChords = line.segments.some((s) => s.chord !== null);
  const chordStyle = elementStyleToCss(fmt.chord);
  const textStyle = lyricsOverride ?? elementStyleToCss(fmt.text);
  return (
    <div key={key} className="line">
      {line.segments.map((segment, i) => (
        // chord-over-lyric layout is a *visual* arrangement
        // of two parallel data lanes — the chord row is a
        // performance instruction (what to play) and the lyric
        // row is the text being sung. That's structurally
        // different from a ruby annotation (which exists to
        // *pronounce* the base text), so the markup stays a
        // pair of `<span>`s in a `<span class="chord-block">`
        // wrapper. CSS positions the chord above the lyric via
        // `inline-flex; flex-direction: column-reverse` so the
        // chord-row baseline is reserved before the lyric is
        // measured.
        <span key={i} className="chord-block">
          {segment.chord ? (
            <span className="chord" style={chordStyle ?? undefined}>
              {renderChord(segment.chord)}
            </span>
          ) : lineHasChords ? (
            <span
              className="chord"
              aria-hidden="true"
              style={chordStyle ?? undefined}
            >
              {' '}
            </span>
          ) : null}
          <span className="lyrics" style={textStyle ?? undefined}>
            {renderSegmentText(segment)}
          </span>
        </span>
      ))}
    </div>
  );
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
  const style: CSSProperties = {};
  if (attrs.width) style.width = attrs.width;
  if (attrs.height) style.height = attrs.height;
  return (
    <img
      key={key}
      src={attrs.src}
      alt={attrs.title ?? ''}
      title={attrs.title ?? undefined}
      style={Object.keys(style).length > 0 ? style : undefined}
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
  key?: number;
  tempo?: number;
  time?: number;
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
        out.key = sourceLine;
        return;
      case 'tempo':
        out.tempo = sourceLine;
        return;
      case 'time':
        out.time = sourceLine;
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
  ): JSX.Element {
    return (
      <Fragment key={baseKey}>
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
        {buildMultiValueRow('by', metadata.artists, metaLines.artists, 'artist')}
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
      buildMultiValueRow('Music', metadata.composers, metaLines.composers, 'composer'),
    );
  }
  if (metadata.lyricists.length > 0) {
    pushAttribution(
      buildMultiValueRow('Lyrics', metadata.lyricists, metaLines.lyricists, 'lyricist'),
    );
  }
  if (metadata.arrangers.length > 0) {
    pushAttribution(
      buildMultiValueRow('Arr.', metadata.arrangers, metaLines.arrangers, 'arranger'),
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
  function chipSpan(
    keyName: string,
    text: string,
    sourceLine: number | undefined,
  ): JSX.Element {
    const isActive = sourceLine !== undefined && sourceLine === active;
    return (
      <span
        key={keyName}
        className={isActive ? 'meta__chip line--active' : 'meta__chip'}
        data-source-line={sourceLine}
      >
        {text}
      </span>
    );
  }
  const paramChips: JSX.Element[] = [];
  if (metadata.key) {
    if (options.transposedKey && options.transposedKey !== metadata.key) {
      paramChips.push(chipSpan('keyOrig', `Key ${metadata.key}`, metaLines.key));
      paramChips.push(chipSpan('keyPlay', `→ ${options.transposedKey}`, undefined));
    } else {
      paramChips.push(chipSpan('key', `Key ${metadata.key}`, metaLines.key));
    }
  }
  if (metadata.capo) paramChips.push(chipSpan('capo', `Capo ${metadata.capo}`, metaLines.capo));
  if (metadata.tempo)
    paramChips.push(chipSpan('tempo', `${metadata.tempo} BPM`, metaLines.tempo));
  if (metadata.time) paramChips.push(chipSpan('time', metadata.time, metaLines.time));
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
  if (metadata.album) pushSupp(metaSpan('album', metadata.album, metaLines.album, active));
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
   * need to clamp on the hot path.
   */
  caretRatio?: number;
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
    const shouldInjectMarker = isActive && ctx.caretRatio !== undefined;
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
              style={{ left: `${(ctx.caretRatio ?? 0) * 100}%` }}
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
    ctx.section = {
      name: SECTION_TAG_TO_NAME[kind.tag]!,
      label: directive.value ?? null,
      children: [],
      startLine: key,
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
      // Inside a `section.tab` / `section.grid`, the body picks up
      // the `tab` / `grid` element style instead of the running
      // `.text` style — mirrors `chordsketch-render-html`'s
      // per-section style override.
      let lyricsOverride: CSSProperties | null = null;
      if (ctx.section?.name === 'tab') {
        lyricsOverride = elementStyleToCss(ctx.fmt.tab);
      } else if (ctx.section?.name === 'grid') {
        lyricsOverride = elementStyleToCss(ctx.fmt.grid);
      }
      pushElement(
        ctx,
        renderLyricsLine(line.value, key, ctx.fmt, lyricsOverride),
        sourceLine,
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
      } else {
        // `bottom` (default) and `below` sit at the tail of the
        // body flow. `data-position` (on the section) +
        // `song--diagrams-<position>` modifier (on the wrapper)
        // let the consumer's CSS distinguish them — `below`
        // flows naturally after the last lyric line, `bottom`
        // pins to the bottom of the document.
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
  // `<article>` is the semantic root for a self-contained song —
  // a single ChordPro document is a "composition complete in
  // itself", which is the HTML5 article definition. Carries the
  // existing `.song` class so consumer CSS keyed on `.song`
  // still hits.
  return <article className={songClass}>{ctx.out}</article>;
}
