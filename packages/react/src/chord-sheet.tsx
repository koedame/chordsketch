import { useEffect, useMemo, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

import { ChordInspector } from './chord-inspector';
import { renderChordproAst, unicodeAccidentals } from './chordpro-jsx';
import type { ChordSelection } from './chordpro-jsx';
import { useChordAudio } from './use-chord-audio';
import type { ChordAudioWasmLoader } from './use-chord-audio';
import type { ChordproChord, ChordproSong } from './chordpro-ast';
import {
  buildChordName,
  buildChordNudge,
  chordLayoutForLine,
  chordSourceEditableUnderTranspose,
  findChordByOffsetOrdinal,
  nudgeChordPosition,
  partsFromRawName,
} from './chord-source-edit';
import type {
  ChordDeleteTarget,
  ChordEditEvent,
  ChordParts,
  ChordRepositionEvent,
} from './chord-source-edit';
import type {
  ChordDiagramInstrument,
  ChordDiagramOrientation,
} from './use-chord-diagram';
import {
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordWasmLoader,
  useChordRender,
} from './use-chord-render';
import {
  type ChordproWasmLoader,
  useChordproAst,
} from './use-chordpro-ast';

/** Props accepted by {@link ChordSheet}. */
export interface ChordSheetProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** ChordPro source to render. */
  source: string;
  /** Semitone transposition offset forwarded to the renderer. */
  transpose?: number;
  /**
   * Append a chord-diagrams grid at the end of the rendered
   * song. When set, every unique chord in the lyrics + every
   * chord declared via `{define}` gets a fretboard / keyboard
   * diagram via the in-built voicing database. Honours
   * `{diagrams: off}` / `{no_diagrams}` directives in the
   * source. Pass `'guitar'` / `'ukulele'` / `'piano'` etc.;
   * defaults to `'guitar'` when the option is set without a
   * specific instrument. Only consumed by `format="html"`.
   */
  chordDiagramsInstrument?: ChordDiagramInstrument;
  /**
   * Orientation forwarded to every `<ChordDiagram>` the walker
   * emits when `chordDiagramsInstrument` is set. Defaults to
   * `"vertical"` (Western convention, nut on top). Pass
   * `"horizontal"` for the Japanese-tablature layout with nut on
   * the left. Has no effect when `chordDiagramsInstrument` is
   * omitted (no grid is rendered) or when `format !== "html"`
   * (the text branch carries no SVG diagrams).
   *
   * Sister-site note: the React walker does not currently
   * dispatch on `{+config.diagrams.orientation: ...}` directives
   * in the source — pass orientation through this prop to opt in
   * from a React host. The Rust HTML / PDF renderers do honour
   * the source-level directive.
   */
  chordDiagramsOrientation?: ChordDiagramOrientation;
  /**
   * 1-indexed source line that should be highlighted in the
   * rendered preview. Forwarded to the AST walker
   * (`renderChordproAst`'s `activeSourceLine` option), which tags
   * every body element with `data-source-line` and applies a
   * `line--active` modifier to the matching element. Pair with
   * `<ChordSourceArea>`'s `onCaretLineChange` callback to keep the
   * preview's highlighted line in sync with the editor caret.
   * Only consumed by `format="html"` — the text branch passes
   * through unchanged.
   */
  activeSourceLine?: number;
  /**
   * 0-indexed caret column inside the active source line. Paired
   * with `caretLineLength`, drives the preview-side
   * `<span class="caret-marker">` overlay positioned by
   * `column / lineLength`. Omit either to fall back to plain
   * line-level highlighting.
   */
  caretColumn?: number;
  /** Total character length of the active source line. */
  caretLineLength?: number;
  /**
   * Optional callback enabling drag-and-drop chord
   * repositioning in the preview. When set, each rendered
   * `.chord` becomes a drag source and each `.lyrics` row a
   * drop target; on drop, this callback receives source-
   * coordinate info about the move (origin line/column,
   * destination line + lyrics character offset) and the user's
   * Alt-modifier state (`copy: true` for copy, `false` for
   * move).
   *
   * The consumer is responsible for mutating the editor source
   * — typically by feeding the event into
   * `applyChordReposition` (also exported from this package)
   * and pushing the result back through whatever surface owns
   * the source string. Omit to disable drag-and-drop.
   *
   * Only consumed by `format="html"`; the text branch passes
   * through unchanged.
   */
  onChordReposition?: (event: ChordRepositionEvent) => void;
  /**
   * Optional callback enabling in-place chord editing via the
   * left-docked inspector (#2622). When set (alongside
   * `onChordReposition`, which enables selection), clicking a chord
   * opens an editor for its root / accidental / type / bass; each
   * change emits a {@link ChordEditEvent} the consumer applies with
   * `applyChordEdit` (exported from this package). Omit to render the
   * inspector read-only / without the edit controls taking effect.
   *
   * Disabled (along with selection / drag) while an effective transpose
   * is active (a non-zero `transpose`, or a `{capo}` in the source):
   * the rendered chords are then the transposed spelling, not the raw
   * source, so source-coordinate editing would corrupt the song. Clear
   * the transpose / capo to edit.
   *
   * Only consumed by `format="html"`.
   */
  onChordEdit?: (event: ChordEditEvent) => void;
  /**
   * Optional callback enabling the inspector's "Remove chord" action
   * (#2622). Receives the chord token's source coordinates; apply it
   * with `applyChordDelete`. Omit to hide the remove button.
   *
   * Only consumed by `format="html"`.
   */
  onChordDelete?: (target: ChordDeleteTarget) => void;
  /**
   * Controlled chord-selection (#2644). When `onChordSelectionChange`
   * is supplied, the shell owns the selection: `chordSelection` drives
   * the `.chord--selected` badge, clicking a chord reports the new
   * selection via `onChordSelectionChange` (instead of mutating internal
   * state), and ChordSheet does NOT render its own footer inspector —
   * the shell renders a lifted, full-width footer below the editor +
   * preview instead. Omit `onChordSelectionChange` for the standalone
   * behaviour: ChordSheet owns the selection internally and renders its
   * own footer inspector when a chord is clicked.
   *
   * Only consumed by `format="html"`.
   */
  chordSelection?: ChordSelection | null;
  /** Setter paired with {@link chordSelection}; presence switches
   * ChordSheet into controlled-selection mode — see its docs. */
  onChordSelectionChange?: (selection: ChordSelection | null) => void;
  /**
   * Enable chord-audio mode (#2650). When `true`, every rendered chord
   * becomes a play button: clicking (or Enter / Space) sounds the chord
   * as a block chord via the Web Audio API. Audio mode takes precedence
   * over the click-to-nudge selection / drag interactions, matching the
   * toolbar-toggle UX where the user opts into audio explicitly.
   *
   * Degrades gracefully: when the environment has no Web Audio support
   * (SSR, or a browser without `AudioContext`), the flag has no effect
   * and chords stay inert. Only consumed by `format="html"`.
   */
  chordAudio?: boolean;
  /**
   * Test-only WASM loader override for the chord-audio hook. Production
   * callers never supply this — the default lazy-loads
   * `@chordsketch/wasm` for the `chordPitches` export.
   *
   * @internal
   */
  chordAudioLoader?: ChordAudioWasmLoader;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or an
   * inline RRJSON configuration string.
   */
  config?: string;
  /**
   * Render target. `"html"` (default) produces ChordPro's HTML
   * output and renders via `dangerouslySetInnerHTML`; `"text"`
   * produces plain chords-above-lyrics text which renders inside a
   * `<pre>` with no HTML parsing. Both outputs come from the
   * `@chordsketch/wasm` renderer, which the host trusts — no user
   * HTML is ever injected.
   */
  format?: ChordRenderFormat;
  /**
   * Optional content shown while WASM is initialising or a render
   * is in flight. Defaults to the last successful output so the
   * preview does not blank during edits; pass `null` to hide.
   */
  loadingFallback?: ReactNode;
  /**
   * Optional render prop that takes over when a parse or render
   * error occurs. Receives the `Error` instance; return any
   * `ReactNode`. Defaults to a minimal `role="alert"` div showing
   * the error message. Pass `null` to hide errors entirely (useful
   * when the host surfaces them via a toast or inline banner
   * alongside the stale output).
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override applied to the
   * `format="text"` branch (which still uses the wasm
   * `render_text` string surface). Production callers never
   * need to supply this — the default lazy-loads
   * `@chordsketch/wasm`.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
  /**
   * Test-only WASM loader override applied to the
   * `format="html"` branch (which now drives `parseChordpro`
   * via the AST → JSX walker per ADR-0017). Distinct from
   * {@link wasmLoader} because the two branches consume
   * different parts of the wasm surface — a stub for one is
   * not generally usable for the other.
   *
   * Production callers never need to supply this.
   *
   * @internal
   */
  astWasmLoader?: ChordproWasmLoader;
}

/** The selected chord resolved out of the AST into the coordinates +
 * parts the inspector needs. `null` when the selection no longer maps
 * to a chord (e.g. the source was edited out from under it). */
interface ResolvedChord {
  /** Raw chord name for the inspector header. */
  chordName: string;
  parts: { root: string; accidental: '' | '#' | 'b'; suffix: string; bass: string };
  sourceLine: number;
  sourceColumn: number;
  bracketLength: number;
  currentOffset: number;
  otherOffsets: number[];
  totalLyrics: number;
}

/**
 * Resolve the current {@link ChordSelection} against the AST into the
 * selected chord's source coordinates + editable parts. Recomputes the
 * selected line's chord layout (source columns + lyrics offsets) the
 * same way the JSX walker does, then locates the chord by its
 * `(offset, ordinal)` identity. Returns `null` when the line is not a
 * lyrics line or the selection no longer resolves.
 */
function resolveSelectedChord(ast: ChordproSong, selection: ChordSelection): ResolvedChord | null {
  const line = ast.lines[selection.line - 1];
  if (!line || line.kind !== 'lyrics') return null;
  const segments = line.value.segments;
  // Shared layout helper — single source of truth for the chord
  // coordinate space (the JSX walker uses the same helper for drag /
  // nudge targeting, so the two cannot drift). See chordLayoutForLine.
  const { layout, totalLyrics: lyricsCount } = chordLayoutForLine(segments);
  const chords: Array<{
    sourceColumn: number;
    bracketLength: number;
    offset: number;
    chord: ChordproChord;
  }> = [];
  segments.forEach((seg, i) => {
    if (seg.chord) {
      chords.push({
        sourceColumn: layout[i].sourceColumn,
        bracketLength: layout[i].bracketLength,
        offset: layout[i].lyricsOffsetStart,
        chord: seg.chord,
      });
    }
  });
  const offsets = chords.map((c) => c.offset);
  const idx = findChordByOffsetOrdinal(offsets, selection.offset, selection.ordinal);
  if (idx < 0) return null;
  const target = chords[idx];
  // Derive parts from the RAW name (transpose-safe — see
  // partsFromRawName). `detail` is intentionally not used here.
  const parts = partsFromRawName(target.chord.name ?? '');
  return {
    chordName: target.chord.name ?? '',
    parts,
    sourceLine: selection.line,
    sourceColumn: target.sourceColumn,
    bracketLength: target.bracketLength,
    currentOffset: target.offset,
    otherOffsets: offsets.filter((_, i) => i !== idx),
    totalLyrics: lyricsCount,
  };
}

function defaultErrorFallback(error: Error): ReactNode {
  return (
    <div role="alert" className="chordsketch-sheet__error">
      {error.message}
    </div>
  );
}

/**
 * Flagship render component for the library. Renders ChordPro
 * source via `@chordsketch/wasm` and memoises the result against
 * `(source, format, transpose, config)` so re-renders without
 * input changes do not re-parse.
 *
 * ```tsx
 * <ChordSheet source={chordproSource} transpose={0} />
 * ```
 *
 * Render path (per ADR-0017):
 * - `format="html"` parses with `parseChordpro` and renders the
 *   AST directly via the chordpro-jsx walker — pure React DOM,
 *   no HTML-string injection, no `<style>` block on the React
 *   surface.
 * - `format="text"` retains the wasm `render_text` path because
 *   ChordPro's text rendering is column-aligned plain output the
 *   AST walker would have to re-derive.
 *
 * Error handling: parse or render errors surface via the
 * `errorFallback` prop (default: inline `role="alert"`); the
 * component does not throw. The previous successful output stays
 * visible while a transient error shows alongside, so a
 * half-typed edit does not blank the preview.
 */
export function ChordSheet({
  source,
  transpose,
  config,
  format = 'html',
  loadingFallback,
  errorFallback = defaultErrorFallback,
  wasmLoader,
  astWasmLoader,
  chordDiagramsInstrument,
  chordDiagramsOrientation,
  activeSourceLine,
  caretColumn,
  caretLineLength,
  onChordReposition,
  onChordEdit,
  onChordDelete,
  chordSelection,
  onChordSelectionChange,
  chordAudio,
  chordAudioLoader,
  className,
  ...divProps
}: ChordSheetProps): JSX.Element {
  const wrapperClass = ['chordsketch-sheet', className].filter(Boolean).join(' ');

  if (format === 'text') {
    return (
      <ChordSheetTextBranch
        source={source}
        transpose={transpose}
        config={config}
        loadingFallback={loadingFallback}
        errorFallback={errorFallback}
        wasmLoader={wasmLoader}
        wrapperClass={wrapperClass}
        divProps={divProps}
      />
    );
  }

  return (
    <ChordSheetAstBranch
      source={source}
      transpose={transpose}
      config={config}
      loadingFallback={loadingFallback}
      errorFallback={errorFallback}
      wasmLoader={astWasmLoader}
      chordDiagramsInstrument={chordDiagramsInstrument}
      chordDiagramsOrientation={chordDiagramsOrientation}
      activeSourceLine={activeSourceLine}
      caretColumn={caretColumn}
      caretLineLength={caretLineLength}
      onChordReposition={onChordReposition}
      onChordEdit={onChordEdit}
      onChordDelete={onChordDelete}
      controlledSelection={chordSelection}
      onChordSelectionChange={onChordSelectionChange}
      chordAudio={chordAudio}
      chordAudioLoader={chordAudioLoader}
      wrapperClass={wrapperClass}
      divProps={divProps}
    />
  );
}

interface BranchProps {
  source: string;
  transpose: number | undefined;
  config: string | undefined;
  loadingFallback: ReactNode | undefined;
  errorFallback: ((error: Error) => ReactNode) | null;
  wrapperClass: string;
  divProps: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>;
}

function ChordSheetTextBranch({
  source,
  transpose,
  config,
  loadingFallback,
  errorFallback,
  wasmLoader,
  wrapperClass,
  divProps,
}: BranchProps & { wasmLoader: ChordWasmLoader | undefined }): JSX.Element {
  const renderOptions: ChordRenderOptions = { transpose, config };
  const { output, loading, error } = useChordRender(source, 'text', renderOptions, wasmLoader);
  const errorNode = error !== null && errorFallback !== null ? errorFallback(error) : null;

  if (output === null) {
    return (
      <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
        {errorNode}
        {loading && loadingFallback !== undefined ? loadingFallback : null}
      </div>
    );
  }

  return (
    <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
      {errorNode}
      <pre className="chordsketch-sheet__text">{output}</pre>
    </div>
  );
}

// Preview elements whose press must NOT clear an active chord
// selection. Two classes, both inside the song body:
//   - `.chord` — the chord glyphs (re-selected by their own click
//     handler; also covers audio play-buttons and inline diagrams,
//     which carry `.chord`).
//   - `.meta-inline` — inline directive chips, notably the `{tempo}`
//     metronome chip, which is an interactive `<button>` when Web Audio
//     is available (see `chordpro-jsx.tsx`). Pressing a chip performs
//     its own action (ticking the metronome, etc.); clearing the
//     selection as a side effect would surprise the user.
// Everything else inside the preview — lyrics, whitespace — is "outside
// a chord" and clears. Shared by the controlled and uncontrolled
// branches of the outside-press listener so the two stay in lockstep
// (.claude/rules/fix-propagation.md).
const PREVIEW_SELECTION_KEEP = '.chord, .meta-inline';

function ChordSheetAstBranch({
  source,
  transpose,
  config,
  loadingFallback,
  errorFallback,
  wasmLoader,
  chordDiagramsInstrument,
  chordDiagramsOrientation,
  activeSourceLine,
  caretColumn,
  caretLineLength,
  onChordReposition,
  onChordEdit,
  onChordDelete,
  controlledSelection,
  onChordSelectionChange,
  chordAudio,
  chordAudioLoader,
  wrapperClass,
  divProps,
}: BranchProps & {
  wasmLoader: ChordproWasmLoader | undefined;
  chordDiagramsInstrument: ChordDiagramInstrument | undefined;
  chordDiagramsOrientation: ChordDiagramOrientation | undefined;
  activeSourceLine: number | undefined;
  caretColumn: number | undefined;
  caretLineLength: number | undefined;
  onChordReposition: ((event: ChordRepositionEvent) => void) | undefined;
  onChordEdit: ((event: ChordEditEvent) => void) | undefined;
  onChordDelete: ((target: ChordDeleteTarget) => void) | undefined;
  controlledSelection: ChordSelection | null | undefined;
  onChordSelectionChange: ((selection: ChordSelection | null) => void) | undefined;
  chordAudio: boolean | undefined;
  chordAudioLoader: ChordAudioWasmLoader | undefined;
}): JSX.Element {
  const { ast, loading, error, transposedKey, transposedKeyDirectives } = useChordproAst(
    source,
    { transpose, config },
    wasmLoader,
  );
  const errorNode = error !== null && errorFallback !== null ? errorFallback(error) : null;

  // Chord-audio mode (#2650). The hook is always instantiated (rules of
  // hooks) but only wired into the walker when the consumer opted in via
  // the `chordAudio` prop AND the environment supports Web Audio — so on
  // SSR / unsupported browsers chords stay inert instead of dead buttons.
  const audio = useChordAudio(chordAudioLoader, Boolean(chordAudio));
  const chordAudioConfig =
    chordAudio && audio.supported ? { enabled: true, play: audio.play } : null;

  // Click-to-focus + nudge selection state (#2614). Owned here so it
  // survives the re-render a nudge triggers (the nudge mutates source,
  // which re-parses the AST and recreates the chord span); the walker
  // re-locates the selected chord by its (offset, ordinal) identity.
  // Only meaningful when `onChordReposition` is wired — otherwise the
  // chords never become interactive, so the state simply stays null.
  //
  // Controlled mode (#2644): when the shell supplies
  // `onChordSelectionChange`, it owns the selection (driven by the
  // editor caret) and renders the lifted full-width footer. ChordSheet
  // then only paints the `.chord--selected` badge from
  // `controlledSelection` and reports chord clicks upward — it renders
  // no in-pane inspector, and the outside-click / scroll-into-view
  // bookkeeping below (which exist for the in-pane dock) is skipped.
  const controlled = onChordSelectionChange !== undefined;
  const [internalSelection, setInternalSelection] = useState<ChordSelection | null>(null);
  const chordSelection = controlled ? (controlledSelection ?? null) : internalSelection;
  const selectChord = controlled ? onChordSelectionChange : setInternalSelection;
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Per-instance root spanning both the song content and the footer
  // inspector (which is a sibling of `__content`, not inside it). Used
  // by the outside-click handler so clicking inside this sheet's
  // inspector does not count as "outside" and clear the selection.
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Clear the selection when the user presses down anywhere that is
  // not a chord / inline chip belonging to THIS sheet's preview.
  // Clicking a chord re-selects via that chord's own handler, so we keep
  // the selection only for presses that land on `PREVIEW_SELECTION_KEEP`
  // targets; presses on bare lyrics / whitespace clear it. Scoped to
  // when a selection is active so there is no idle global listener.
  //
  // The listener is per-instance (`wrapperRef` is THIS sheet's root):
  // the shipped shells mount a single preview, so there is no
  // cross-instance interference; a host that mounts two controlled
  // previews against one shared selection would need to scope the
  // selection per preview, which is the host's responsibility.
  useEffect(() => {
    if (chordSelection == null) return;
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null;
      // Resolve to the nearest Element: a pointer event's target can be
      // a non-Element node (e.g. the chord name's Text node) which has
      // no `closest`, and treating that as "outside" would clear the
      // selection the instant the user presses on the chord glyph.
      const el =
        node instanceof Element ? node : (node?.parentElement ?? null);
      const root = wrapperRef.current;
      if (controlled) {
        // Controlled mode: the shell owns the selection (caret-driven)
        // and renders the chord-editor footer OUTSIDE this sheet, so the
        // only clear scoped here is a press on a non-chord part of the
        // preview (#2654) — that reports `null` upward, and the shell
        // moves the editor caret off the chord. Presses outside the
        // preview (the editor, the footer) are owned by the editor caret
        // and must not be disturbed here.
        if (
          root != null &&
          el != null &&
          root.contains(el) &&
          el.closest(PREVIEW_SELECTION_KEEP) == null
        ) {
          onChordSelectionChange?.(null);
        }
        return;
      }
      // Uncontrolled mode: scope to THIS sheet's subtree (chords / chips
      // in `__content` + the sibling inspector footer), so a press on a
      // chord, an inline chip, or anywhere in the inspector keeps the
      // selection; anything else — including clicks entirely outside
      // this sheet — clears it.
      if (
        root != null &&
        el != null &&
        root.contains(el) &&
        el.closest(`${PREVIEW_SELECTION_KEEP}, .chordsketch-sheet__cins`)
      ) {
        return;
      }
      setInternalSelection(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [controlled, chordSelection, onChordSelectionChange]);

  // Resolve the selection into the selected chord's coordinates + parts
  // for the inspector. Recomputed whenever the AST (a re-parse after an
  // edit / nudge) or the selection changes.
  const resolvedChord = useMemo(
    () => (ast && chordSelection ? resolveSelectedChord(ast, chordSelection) : null),
    [ast, chordSelection],
  );

  // Source-coordinate editing (selection / drag / nudge / inspector)
  // is only valid when the chords the walker renders match the raw
  // source. The wasm parse path transposes the AST in place — folding
  // any `{capo: N}` into the effective transpose (ADR-0023) — so under
  // a non-zero effective transpose `chord.name` is the TRANSPOSED
  // spelling, and editing by source coordinates would write the wrong
  // chord / miscompute columns. The gate mirrors the core's
  // `effective_transpose` capo semantics exactly (1..=24 accept-or-zero,
  // NOT the `<Capo>` control's 0..=12 display clamp), so a hand-edited
  // `{capo: 18}` cannot fool the gate into editing a transposed AST.
  const sourceEditable = chordSourceEditableUnderTranspose(source, transpose);
  const repositionCb = sourceEditable ? onChordReposition : undefined;
  const editCb = sourceEditable ? onChordEdit : undefined;
  const deleteCb = sourceEditable ? onChordDelete : undefined;
  // Drop a stale selection if the user applies a transpose / capo while
  // a chord is selected, so no badge / inspector lingers on a chord the
  // user can no longer safely edit. In controlled mode the shell owns
  // this (it derives the selection from the caret under the same gate).
  useEffect(() => {
    if (!controlled && !sourceEditable && chordSelection != null) setInternalSelection(null);
  }, [controlled, sourceEditable, chordSelection]);

  // Keep the selected chord visible above the bottom-docked inspector
  // (#2630). The dock pins to the bottom of the scrollport, so a chord
  // near the bottom would otherwise sit under it. When the selection
  // changes — a new chord, or a nudge that relocates it — scroll the
  // active `.chord--selected` badge to the centre of the scrollport,
  // above the dock. Keyed on `chordSelection`, which is stable across
  // in-place text edits (they keep the same (line, offset, ordinal)
  // coordinates), so typing in the inspector does not re-scroll.
  useEffect(() => {
    // In-pane dock only — controlled mode renders the footer outside the
    // sheet (below the editor + preview), so there is nothing to scroll
    // a chord above here.
    if (controlled || !sourceEditable || chordSelection == null) return;
    const root = contentRef.current;
    if (root == null) return;
    const raf = requestAnimationFrame(() => {
      const target = root.querySelector('.chord--selected');
      if (target == null || typeof target.scrollIntoView !== 'function') return;
      const reduce =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [controlled, chordSelection, sourceEditable]);

  if (ast === null) {
    return (
      <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
        {errorNode}
        {loading && loadingFallback !== undefined ? loadingFallback : null}
      </div>
    );
  }

  // AST walker emits a `<div class="song">` root matching the
  // `chordsketch-render-html` DOM contract so existing CSS keeps
  // working unchanged. Pure React reconciliation owns the tree
  // — no innerHTML escape hatch on this surface. The
  // `transposedKey` plumbed through from `parseChordproWithWarnings*`
  // drives the "Original Key X · Play Key Y" header path.
  return (
    <div {...divProps} ref={wrapperRef} className={wrapperClass} aria-busy={loading || undefined}>
      {errorNode}
      <div className="chordsketch-sheet__content" ref={contentRef}>
        {renderChordproAst(ast, {
          transposedKey,
          transposedKeyDirectives,
          chordDiagrams: chordDiagramsInstrument
            ? {
                instrument: chordDiagramsInstrument,
                orientation: chordDiagramsOrientation,
              }
            : null,
          activeSourceLine,
          caretColumn,
          caretLineLength,
          onChordReposition: repositionCb,
          chordSelection: repositionCb ? chordSelection : null,
          setChordSelection: repositionCb ? selectChord : undefined,
          chordAudio: chordAudioConfig,
        })}
      </div>
      {!controlled && resolvedChord && editCb ? (
        <ChordInspector
          chordName={resolvedChord.chordName}
          // Header shows the chord with Unicode accidentals (B♭, not
          // Bb) so the editor title matches the rendered chord, while
          // `chordName` stays raw for the source-edit `expected` guard.
          displayName={unicodeAccidentals(resolvedChord.chordName)}
          root={resolvedChord.parts.root}
          accidental={resolvedChord.parts.accidental}
          suffix={resolvedChord.parts.suffix}
          bass={resolvedChord.parts.bass}
          // `[]` for otherOffsets: availability depends only on
          // the line bounds; otherOffsets is used solely to compute
          // the destination ordinal (not the null/non-null result),
          // so an empty list is fine for the can-move check.
          canLeft={
            nudgeChordPosition(resolvedChord.currentOffset, [], resolvedChord.totalLyrics, -1) !==
            null
          }
          canRight={
            nudgeChordPosition(resolvedChord.currentOffset, [], resolvedChord.totalLyrics, 1) !==
            null
          }
          onChange={(parts: ChordParts) => {
            let chord: string;
            try {
              chord = buildChordName(parts);
            } catch {
              // Invalid parts (e.g. a rootless chord whose root is
              // empty — buildChordName throws); ignore rather than
              // corrupt the source.
              return;
            }
            editCb({
              line: resolvedChord.sourceLine,
              fromColumn: resolvedChord.sourceColumn,
              fromLength: resolvedChord.bracketLength,
              chord,
              expected: resolvedChord.chordName,
            });
          }}
          onNudge={(direction) => {
            const result = buildChordNudge({
              sourceLine: resolvedChord.sourceLine,
              chordName: resolvedChord.chordName,
              sourceColumn: resolvedChord.sourceColumn,
              bracketLength: resolvedChord.bracketLength,
              currentOffset: resolvedChord.currentOffset,
              otherOffsets: resolvedChord.otherOffsets,
              totalLyrics: resolvedChord.totalLyrics,
              direction,
            });
            if (!result || !repositionCb) return;
            repositionCb(result.event);
            setInternalSelection((prev) => ({
              line: resolvedChord.sourceLine,
              offset: result.offset,
              ordinal: result.ordinal,
              nonce: (prev?.nonce ?? 0) + 1,
            }));
          }}
          onRemove={
            deleteCb
              ? () => {
                  deleteCb({
                    line: resolvedChord.sourceLine,
                    fromColumn: resolvedChord.sourceColumn,
                    fromLength: resolvedChord.bracketLength,
                    expected: resolvedChord.chordName,
                  });
                  setInternalSelection(null);
                }
              : undefined
          }
          onClose={() => setInternalSelection(null)}
        />
      ) : null}
    </div>
  );
}
