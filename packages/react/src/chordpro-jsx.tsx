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

import type { CSSProperties, JSX, ReactNode } from 'react';
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

/**
 * Returns true when `href` is safe to embed in an `href` / `src`
 * attribute.
 *
 * Mirrors `has_dangerous_uri_scheme` in
 * `crates/render-html/src/lib.rs` byte for byte:
 *
 *   1. Trim leading whitespace.
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
 * Any change here MUST land in the Rust function in the same PR
 * (sister-site parity per `.claude/rules/fix-propagation.md`).
 */
function isSafeHref(href: string): boolean {
  const out: string[] = [];
  let started = false;
  for (let i = 0; i < href.length && out.length < 30; i++) {
    const code = href.charCodeAt(i);
    if (!started) {
      if (isAsciiWhitespace(code)) continue;
      started = true;
    }
    if (isAsciiWhitespace(code) || isAsciiControl(code) || isInvisibleFormatChar(code)) {
      continue;
    }
    out.push(href[i]!);
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

function renderLyricsLine(line: ChordproLyricsLine, key: number): JSX.Element {
  return (
    <div key={key} className="line">
      {line.segments.map((segment, i) => (
        <span key={i} className="chord-block">
          {segment.chord && (
            <span className="chord">{renderChord(segment.chord)}</span>
          )}
          <span className="lyrics">{renderSegmentText(segment)}</span>
        </span>
      ))}
    </div>
  );
}

// ---- Comment line --------------------------------------------------

function renderComment(
  style: 'normal' | 'italic' | 'boxed',
  text: string,
  key: number,
): JSX.Element {
  if (style === 'boxed') {
    return (
      <div key={key} className="comment-box">
        {text}
      </div>
    );
  }
  if (style === 'italic') {
    return (
      <p key={key} className="comment">
        <em>{text}</em>
      </p>
    );
  }
  return (
    <p key={key} className="comment">
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
}

// ---- Header rendering ----------------------------------------------

function renderHeader(metadata: ChordproMetadata): JSX.Element[] {
  const out: JSX.Element[] = [];
  if (metadata.title) {
    out.push(<h1 key="title">{metadata.title}</h1>);
  }
  if (metadata.subtitles.length > 0) {
    out.push(<h2 key="subtitle">{metadata.subtitles.join(' · ')}</h2>);
  }
  // Mirror the metadata strip emitted by
  // `chordsketch-render-html`'s metadata-header path: artist · key · capo · BPM · time.
  const metaParts: string[] = [];
  if (metadata.artists.length > 0) metaParts.push(metadata.artists.join(', '));
  if (metadata.key) metaParts.push(`Key ${metadata.key}`);
  if (metadata.capo) metaParts.push(`Capo ${metadata.capo}`);
  if (metadata.tempo) metaParts.push(`${metadata.tempo} BPM`);
  if (metadata.time) metaParts.push(metadata.time);
  if (metaParts.length > 0) {
    out.push(
      <p key="meta" className="meta">
        {metaParts.join(' · ')}
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
   * Output buffer for top-level (non-section) elements. The walker
   * appends a finished section's `<section>` into this buffer when
   * the section closes.
   */
  out: JSX.Element[];
}

function flushSection(ctx: WalkContext, key: number): void {
  if (!ctx.section) return;
  const { name, label, children } = ctx.section;
  const labelText = label ?? SECTION_LABEL_DEFAULT[name];
  const labelNode = labelText ? (
    <div key="label" className="section-label">
      {labelText}
    </div>
  ) : null;
  ctx.out.push(
    <section key={key} className={name}>
      {labelNode}
      {children}
    </section>,
  );
  ctx.section = null;
}

function pushElement(ctx: WalkContext, element: JSX.Element): void {
  if (ctx.section) {
    ctx.section.children.push(element);
  } else {
    ctx.out.push(element);
  }
}

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

  // Section open — named (chorus / verse / bridge / tab / grid /
  // delegate) and custom (`{start_of_<name>}`).
  if (kind.tag in SECTION_TAG_TO_NAME) {
    // If a previous section was still open, flush it before
    // opening a new one — `<section>` nesting is not part of the
    // ChordPro grammar, so the lenient path is "implicit close".
    flushSection(ctx, key * 1000);
    ctx.section = {
      name: SECTION_TAG_TO_NAME[kind.tag]!,
      label: directive.value ?? null,
      children: [],
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
    };
    return;
  }

  // Section close — named + custom.
  if (kind.tag in END_TAG_TO_NAME || kind.tag === 'endOfSection') {
    flushSection(ctx, key);
    return;
  }

  // `{chorus}` recall — emit a placeholder block. The Rust
  // renderer materialises the most recent chorus body inline; that
  // recall behaviour requires the renderer to remember the prior
  // chorus's lines, which is tracked as a follow-up. For now, emit
  // the same `chorus-recall` wrapper with just the label so the
  // CSS hook lands.
  if (kind.tag === 'chorus') {
    pushElement(
      ctx,
      <div key={key} className="chorus-recall">
        <div className="section-label">{directive.value ?? 'Chorus'}</div>
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
  switch (line.kind) {
    case 'lyrics':
      pushElement(ctx, renderLyricsLine(line.value, key));
      return;
    case 'comment':
      pushElement(ctx, renderComment(line.style, line.text, key));
      return;
    case 'empty':
      pushElement(ctx, <div key={key} className="empty-line" />);
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
 */
export function renderChordproAst(song: ChordproSong): JSX.Element {
  const ctx: WalkContext = { section: null, out: [] };
  // Emit header first so metadata lands above the body even when
  // the source has metadata directives interleaved with lines.
  for (const headerNode of renderHeader(song.metadata)) {
    ctx.out.push(headerNode);
  }
  song.lines.forEach((line, i) => renderLine(ctx, line, i + 1));
  // Final close: if the song ends inside an open section, flush
  // it so the user sees their lines instead of dropping them.
  flushSection(ctx, song.lines.length + 1);
  return <div className="song">{ctx.out}</div>;
}
