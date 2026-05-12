// TypeScript shape of the ChordPro AST emitted by
// `@chordsketch/wasm`'s `parseChordpro` export.
//
// Mirrors the JSON producer at `crates/chordpro/src/json.rs` —
// changes to the Rust serializer must land in lockstep with this
// file (camelCase casing, tagged-union encoding for enums,
// `null` instead of `undefined` for optional fields).
//
// This is the wire format the AST → JSX walker
// (`<ChordSheet>`'s html branch) consumes, per
// [ADR-0017](../../docs/adr/0017-react-renders-from-ast.md).

/** Top-level parsed ChordPro song. */
export interface ChordproSong {
  metadata: ChordproMetadata;
  lines: ChordproLine[];
}

/** Metadata extracted from `{title}`, `{artist}`, etc. */
export interface ChordproMetadata {
  title: string | null;
  subtitles: string[];
  artists: string[];
  composers: string[];
  lyricists: string[];
  album: string | null;
  year: string | null;
  key: string | null;
  tempo: string | null;
  time: string | null;
  capo: string | null;
  sortTitle: string | null;
  sortArtist: string | null;
  arrangers: string[];
  copyright: string | null;
  duration: string | null;
  tags: string[];
  /** `[name, value]` pairs from unknown / generic metadata directives. */
  custom: Array<[string, string]>;
}

// ---- Line variants -------------------------------------------------

/** A single body line in the parsed song. */
export type ChordproLine =
  | { kind: 'lyrics'; value: ChordproLyricsLine }
  | { kind: 'directive'; value: ChordproDirective }
  | { kind: 'comment'; style: ChordproCommentStyle; text: string }
  | { kind: 'empty' };

export type ChordproCommentStyle = 'normal' | 'italic' | 'boxed' | 'highlight';

// ---- Lyrics --------------------------------------------------------

export interface ChordproLyricsLine {
  segments: ChordproLyricsSegment[];
}

export interface ChordproLyricsSegment {
  /** Chord placed above the start of `text`, or `null` when text-only. */
  chord: ChordproChord | null;
  /** Plain lyric text following the chord (markup stripped). */
  text: string;
  /** Inline markup tree; empty when `text` carries no markup. */
  spans: ChordproTextSpan[];
}

// ---- Inline markup -------------------------------------------------

export type ChordproTextSpan =
  | { kind: 'plain'; value: string }
  | { kind: 'bold'; children: ChordproTextSpan[] }
  | { kind: 'italic'; children: ChordproTextSpan[] }
  | { kind: 'highlight'; children: ChordproTextSpan[] }
  | { kind: 'comment'; children: ChordproTextSpan[] }
  | {
      kind: 'span';
      attributes: ChordproSpanAttributes;
      children: ChordproTextSpan[];
    };

export interface ChordproSpanAttributes {
  fontFamily: string | null;
  size: string | null;
  foreground: string | null;
  background: string | null;
  weight: string | null;
  style: string | null;
}

// ---- Chord ---------------------------------------------------------

export interface ChordproChord {
  /** Raw name as written in the source (e.g. `"Am"`, `"G7"`). */
  name: string;
  /** Parsed components — `null` when notation could not be recognised. */
  detail: ChordproChordDetail | null;
  /** Display override set by `{define}` with `display=`. */
  display: string | null;
}

export interface ChordproChordDetail {
  root: ChordproNote;
  rootAccidental: ChordproAccidental | null;
  quality: ChordproChordQuality;
  extension: string | null;
  bassNote: { note: ChordproNote; accidental: ChordproAccidental | null } | null;
}

export type ChordproNote = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type ChordproAccidental = 'sharp' | 'flat';
export type ChordproChordQuality = 'major' | 'minor' | 'diminished' | 'augmented';

// ---- Image / chord definition -------------------------------------

export interface ChordproImageAttributes {
  src: string;
  width: string | null;
  height: string | null;
  scale: string | null;
  title: string | null;
  anchor: string | null;
}

export interface ChordproChordDefinition {
  name: string;
  /** Keyboard MIDI note offsets, when defined as `keys …`. */
  keys: number[] | null;
  copy: string | null;
  copyall: string | null;
  display: string | null;
  format: string | null;
  raw: string | null;
  transposable: boolean;
}

// ---- Directive ----------------------------------------------------

export interface ChordproDirective {
  /** Canonical directive name. */
  name: string;
  /** Optional value following the colon. */
  value: string | null;
  /** Classified kind — switch on `kind.tag` for behaviour. */
  kind: ChordproDirectiveKind;
  /** `{name-piano}` selector suffix, if present. */
  selector: string | null;
}

/**
 * Tagged-union directive kind. The `tag` field discriminates;
 * payload-bearing variants add a `value` field. Mirrors the
 * encoding in `crates/chordpro/src/json.rs::ToJson for DirectiveKind`.
 */
export type ChordproDirectiveKind =
  // Metadata
  | { tag: 'title' }
  | { tag: 'subtitle' }
  | { tag: 'artist' }
  | { tag: 'composer' }
  | { tag: 'lyricist' }
  | { tag: 'album' }
  | { tag: 'year' }
  | { tag: 'key' }
  | { tag: 'tempo' }
  | { tag: 'time' }
  | { tag: 'capo' }
  | { tag: 'sortTitle' }
  | { tag: 'sortArtist' }
  | { tag: 'arranger' }
  | { tag: 'copyright' }
  | { tag: 'duration' }
  | { tag: 'tag' }
  // Transpose
  | { tag: 'transpose' }
  // Comment
  | { tag: 'comment' }
  | { tag: 'commentItalic' }
  | { tag: 'commentBox' }
  | { tag: 'highlight' }
  // Sections
  | { tag: 'startOfChorus' }
  | { tag: 'endOfChorus' }
  | { tag: 'startOfVerse' }
  | { tag: 'endOfVerse' }
  | { tag: 'startOfBridge' }
  | { tag: 'endOfBridge' }
  | { tag: 'startOfTab' }
  | { tag: 'endOfTab' }
  | { tag: 'startOfGrid' }
  | { tag: 'endOfGrid' }
  // Font / size / colour
  | { tag: 'textFont' }
  | { tag: 'textSize' }
  | { tag: 'textColour' }
  | { tag: 'chordFont' }
  | { tag: 'chordSize' }
  | { tag: 'chordColour' }
  | { tag: 'tabFont' }
  | { tag: 'tabSize' }
  | { tag: 'tabColour' }
  // Recall
  | { tag: 'chorus' }
  // Page control
  | { tag: 'newPage' }
  | { tag: 'newPhysicalPage' }
  | { tag: 'columnBreak' }
  | { tag: 'columns' }
  | { tag: 'pagetype' }
  // Extended fonts
  | { tag: 'titleFont' }
  | { tag: 'titleSize' }
  | { tag: 'titleColour' }
  | { tag: 'chorusFont' }
  | { tag: 'chorusSize' }
  | { tag: 'chorusColour' }
  | { tag: 'footerFont' }
  | { tag: 'footerSize' }
  | { tag: 'footerColour' }
  | { tag: 'headerFont' }
  | { tag: 'headerSize' }
  | { tag: 'headerColour' }
  | { tag: 'labelFont' }
  | { tag: 'labelSize' }
  | { tag: 'labelColour' }
  | { tag: 'gridFont' }
  | { tag: 'gridSize' }
  | { tag: 'gridColour' }
  | { tag: 'tocFont' }
  | { tag: 'tocSize' }
  | { tag: 'tocColour' }
  // Song boundary
  | { tag: 'newSong' }
  // Chord definition
  | { tag: 'define' }
  | { tag: 'chordDirective' }
  // Delegate environments
  | { tag: 'startOfAbc' }
  | { tag: 'endOfAbc' }
  | { tag: 'startOfLy' }
  | { tag: 'endOfLy' }
  | { tag: 'startOfSvg' }
  | { tag: 'endOfSvg' }
  | { tag: 'startOfTextblock' }
  | { tag: 'endOfTextblock' }
  | { tag: 'startOfMusicxml' }
  | { tag: 'endOfMusicxml' }
  // Custom sections (payload = section name)
  | { tag: 'startOfSection'; value: string }
  | { tag: 'endOfSection'; value: string }
  // Generic meta (payload = first word of `{meta}` value)
  | { tag: 'meta'; value: string }
  // Diagrams
  | { tag: 'diagrams' }
  | { tag: 'noDiagrams' }
  // Image (payload = parsed image attributes)
  | { tag: 'image'; value: ChordproImageAttributes }
  // Config override (payload = dot-separated key)
  | { tag: 'configOverride'; value: string }
  // Unknown (payload = raw lowercased name)
  | { tag: 'unknown'; value: string };
