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

const DANGEROUS_URI_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
];

/**
 * Returns true when `href` is safe to embed in an `href` / `src`
 * attribute. Mirrors the blocklist applied by
 * `crates/render-html/src/lib.rs::has_dangerous_uri_scheme`.
 */
function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return !DANGEROUS_URI_SCHEMES.some((scheme) => trimmed.startsWith(scheme));
}

// ---- Inline span rendering ----------------------------------------

function renderSpan(span: ChordproTextSpan, key: number): ReactNode {
  switch (span.kind) {
    case 'plain':
      return span.value;
    case 'bold':
      return <strong key={key}>{span.children.map(renderSpan)}</strong>;
    case 'italic':
      return <em key={key}>{span.children.map(renderSpan)}</em>;
    case 'highlight':
      return <mark key={key}>{span.children.map(renderSpan)}</mark>;
    case 'comment':
      return (
        <span key={key} className="inline-comment">
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

const SECTION_LABEL_DEFAULT: Record<string, string> = {
  chorus: 'Chorus',
  verse: 'Verse',
  bridge: 'Bridge',
  tab: 'Tab',
  grid: 'Grid',
};

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
  const { tag } = directive.kind;
  // Section open / close.
  if (tag in SECTION_TAG_TO_NAME) {
    // If a previous section was still open, flush it before
    // opening a new one — `<section>` nesting is not part of the
    // ChordPro grammar, so the lenient path is "implicit close".
    flushSection(ctx, key * 1000);
    ctx.section = {
      name: SECTION_TAG_TO_NAME[tag]!,
      label: directive.value ?? null,
      children: [],
    };
    return;
  }
  if (tag in END_TAG_TO_NAME) {
    flushSection(ctx, key);
    return;
  }
  // `{chorus}` recall — emit a placeholder block. The Rust
  // renderer materialises the most recent chorus body inline; that
  // recall behaviour requires the renderer to remember the prior
  // chorus's lines, which is tracked as a follow-up. For now, emit
  // the same `chorus-recall` wrapper with just the label so the
  // CSS hook lands.
  if (tag === 'chorus') {
    pushElement(
      ctx,
      <div key={key} className="chorus-recall">
        <div className="section-label">{directive.value ?? 'Chorus'}</div>
      </div>,
    );
    return;
  }
  // Image directive.
  if (tag === 'image') {
    const img = renderImage(directive.kind.value, key);
    if (img) pushElement(ctx, img);
    return;
  }
  // Page-control directives — no DOM impact in the React preview
  // (pagination is renderer-specific to PDF).
  if (
    tag === 'newPage' ||
    tag === 'newPhysicalPage' ||
    tag === 'columnBreak' ||
    tag === 'columns' ||
    tag === 'newSong'
  ) {
    return;
  }
  // Font / size / colour directives — these affect the Rust
  // renderer's emitted `<style>` block. The React preview lives
  // inside the consumer's stylesheet and does not read these
  // directives; consumers that need per-song style overrides can
  // walk the AST themselves.
  // Diagrams toggle / config override / generic meta — consumed by
  // the renderer's setup phase, no body output.
  // All metadata-class directives (title, artist, etc.) are
  // surfaced via the `metadata` block, not as inline lines, so
  // ignore them here too.
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
