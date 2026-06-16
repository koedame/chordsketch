// Shell-level chord-editor coordination hook (#2644).
//
// Drives the full-width chord-editor footer that spans the editor +
// preview from the EDITOR CARET, so the chord under the caret is
// selected automatically and a new chord can be built and inserted at
// the caret. The two surfaces that own a ChordPro source editor —
// `<ChordProEditor>` (Tier 3) and the playground — both consume this
// hook so the coordination logic lives in one place rather than being
// re-derived per host (see `.claude/rules/playground-is-a-sample.md`).
//
// The hook is purely about source-coordinate bookkeeping; every chord
// mutation routes through the pure helpers in `chord-source-edit`, and
// the caret is restored via the editor's imperative
// `ChordSourceAreaHandle.setCaret` after each mutation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { ChordInspectorProps } from './chord-inspector';
import { unicodeAccidentals } from './chordpro-jsx';
import type { ChordSelection } from './chordpro-jsx';
import {
  applyChordDelete,
  applyChordEdit,
  applyChordInsert,
  applyChordReposition,
  buildChordName,
  buildChordNudge,
  chordSelectionCaretOffset,
  chordSourceEditableUnderTranspose,
  findChordAtCaret,
  nudgeChordPosition,
  type ChordParts,
  type ChordRepositionEvent,
  type ChordRepositionResult,
} from './chord-source-edit';
import type { ChordSourceAreaHandle } from './chord-source-area';

/** A fine-grained caret position as reported by
 * {@link ChordSourceAreaProps.onCaretChange}. */
interface CaretPosition {
  line: number;
  column: number;
  lineLength: number;
}

/** Parameters for {@link useChordEditor}. */
export interface UseChordEditorParams {
  /** Current ChordPro source (the editor's document). */
  source: string;
  /** Apply a source mutation produced by an editor action. */
  onSourceChange: (next: string) => void;
  /** CLI-style transpose offset in effect, for the source-editable gate
   * (mirrors `<ChordSheet>`). Defaults to `0`. */
  transpose?: number;
  /** Imperative handle to the source editor, used to restore the caret
   * after a mutation and to move it onto a chord clicked in the
   * preview. */
  editorRef: RefObject<ChordSourceAreaHandle | null>;
}

/** Everything a shell needs to render the lifted footer + wire the
 * preview, returned by {@link useChordEditor}. */
export interface UseChordEditor {
  /** Caret callback to pass to `<ChordSourceArea onCaretChange>`. */
  onCaretChange: (caret: CaretPosition) => void;
  /** Controlled selection to pass to the preview (drives the
   * `.chord--selected` badge). */
  chordSelection: ChordSelection | null;
  /** Selection-change callback to pass to the preview — a preview chord
   * click moves the editor caret onto that chord. */
  onChordSelectionChange: (selection: ChordSelection | null) => void;
  /** Reposition callback to pass to the preview — enables chord
   * interactivity (selection / drag) and applies drops to the source. */
  onChordReposition: (event: ChordRepositionEvent) => void;
  /** Props to spread onto `<ChordInspector>`, or `null` to omit the
   * footer entirely (never returned today — the footer stays visible,
   * showing an idle / gated state instead). */
  inspectorProps: ChordInspectorProps;
}

/** Default draft chord shown in the idle footer (a bare C major). */
const DEFAULT_DRAFT: Required<ChordParts> = { root: 'C', accidental: '', suffix: '', bass: '' };

/** Absolute 0-indexed offset of the start of 1-indexed `line` in
 * `source`. */
function lineBaseOffset(source: string, line: number): number {
  const lines = source.split('\n');
  let base = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) base += lines[i].length + 1;
  return base;
}

/** Unicode display name for a set of parts, falling back to the raw
 * name (then empty) when the parts do not form a valid chord. */
function displayNameFor(parts: ChordParts, rawName: string): string {
  try {
    return unicodeAccidentals(buildChordName(parts));
  } catch {
    return rawName ? unicodeAccidentals(rawName) : '';
  }
}

/**
 * Coordinate the caret-driven chord-editor footer for a ChordPro editor
 * shell. Returns the props/callbacks to wire the source editor
 * (`onCaretChange`), the preview (`chordSelection` /
 * `onChordSelectionChange` / `onChordReposition`), and the footer
 * (`inspectorProps`).
 */
export function useChordEditor({
  source,
  onSourceChange,
  transpose = 0,
  editorRef,
}: UseChordEditorParams): UseChordEditor {
  const [caret, setCaret] = useState<CaretPosition | null>(null);
  const [draft, setDraft] = useState<Required<ChordParts>>(DEFAULT_DRAFT);
  const onCaretChange = useCallback((next: CaretPosition) => setCaret(next), []);

  // Source-coordinate editing is only safe when the rendered chords
  // match the raw source — i.e. no effective transpose / capo (ADR-0023,
  // mirrors `<ChordSheet>`).
  const editable = chordSourceEditableUnderTranspose(source, transpose);

  // The chord under the caret (null when the caret is in the lyrics, off
  // a chord, or editing is gated).
  const caretChord = useMemo(() => {
    if (!editable || caret == null) return null;
    return findChordAtCaret(source, lineBaseOffset(source, caret.line) + caret.column);
  }, [editable, caret, source]);

  // Monotonic selection nonce, bumped when the selected chord identity
  // changes so the walker re-focuses the new span (see ChordSelection).
  const nonceRef = useRef(0);
  const lastIdRef = useRef<string | null>(null);
  const chordSelection = useMemo<ChordSelection | null>(() => {
    if (!caretChord) {
      lastIdRef.current = null;
      return null;
    }
    const id = `${caretChord.line}:${caretChord.offset}:${caretChord.ordinal}`;
    if (id !== lastIdRef.current) {
      lastIdRef.current = id;
      nonceRef.current += 1;
    }
    return {
      line: caretChord.line,
      offset: caretChord.offset,
      ordinal: caretChord.ordinal,
      nonce: nonceRef.current,
    };
  }, [caretChord]);

  // Restore the caret after a source mutation. Deferred to an effect on
  // `source` so the editor's controlled-value sync (a child effect, run
  // before this parent effect) has updated the document first.
  //
  // The pending caret is tagged with the exact source text it targets,
  // so a commit that turns out to be a no-op (an optimistic-concurrency
  // guard mismatch returns the SAME source string, the host's setState
  // bails, and this effect never fires) cannot leak its stale offset
  // onto a later, unrelated source change (e.g. the user typing): the
  // effect applies the caret only when `source` actually became the
  // committed text, and otherwise drops the stale request.
  const pendingCaretRef = useRef<{ text: string; offset: number } | null>(null);
  useEffect(() => {
    const pending = pendingCaretRef.current;
    if (pending == null) return;
    if (pending.text === source) {
      editorRef.current?.setCaret(pending.offset);
    }
    pendingCaretRef.current = null;
  }, [source, editorRef]);

  const commit = useCallback(
    (result: ChordRepositionResult, caretTarget?: number) => {
      pendingCaretRef.current = { text: result.text, offset: caretTarget ?? result.caretOffset };
      onSourceChange(result.text);
    },
    [onSourceChange],
  );

  // The parts the footer currently shows: the selected chord's, or the
  // draft being built for insertion.
  const parts: Required<ChordParts> = caretChord
    ? {
        root: caretChord.parts.root,
        accidental: caretChord.parts.accidental,
        suffix: caretChord.parts.suffix,
        bass: caretChord.parts.bass,
      }
    : draft;

  const onChange = useCallback(
    (next: ChordParts) => {
      if (!caretChord) {
        // Idle: update the draft chord used by Insert.
        setDraft({
          root: next.root,
          accidental: next.accidental ?? '',
          suffix: next.suffix ?? '',
          bass: next.bass ?? '',
        });
        return;
      }
      // Selected: rewrite the chord in place.
      let chord: string;
      try {
        chord = buildChordName(next);
      } catch {
        // Invalid parts (e.g. a rootless token whose root is empty);
        // drop the edit rather than corrupt the source.
        return;
      }
      // Guard: if the chip click produces the same chord name that is
      // already in the source (e.g. the user re-clicks the selected root
      // chip), bail before calling commit. `applyChordEdit` would return
      // the same source string, React would bail on the setState, the
      // source-change effect would never fire, and `pendingCaretRef`
      // would never be cleared — blocking `onChordSelectionChange` from
      // moving the editor caret on the next preview chord click.
      if (chord === caretChord.chordName) return;
      const result = applyChordEdit(source, {
        line: caretChord.line,
        fromColumn: caretChord.sourceColumn,
        fromLength: caretChord.bracketLength,
        chord,
        expected: caretChord.chordName,
      });
      // Keep the caret inside the rewritten bracket so the chord stays
      // selected (a caret just after `]` would deselect it).
      const target = lineBaseOffset(source, caretChord.line) + caretChord.sourceColumn + 1;
      commit(result, target);
    },
    [caretChord, source, commit],
  );

  const onInsert = useCallback(() => {
    if (caret == null) return;
    let chord: string;
    try {
      chord = buildChordName(parts);
    } catch {
      return;
    }
    const result = applyChordInsert(source, { line: caret.line, column: caret.column, chord });
    // Land the caret inside the freshly inserted bracket so it becomes
    // the selected chord (ready to tweak). `result.caretOffset` points
    // just past the bracket; back up to just after its `[`.
    const target = result.caretOffset - (chord.length + 2) + 1;
    commit(result, target);
  }, [caret, parts, source, commit]);

  const onNudge = useCallback(
    (direction: -1 | 1) => {
      if (!caretChord) return;
      const nudge = buildChordNudge({
        sourceLine: caretChord.line,
        chordName: caretChord.chordName,
        sourceColumn: caretChord.sourceColumn,
        bracketLength: caretChord.bracketLength,
        currentOffset: caretChord.offset,
        otherOffsets: caretChord.otherOffsets,
        totalLyrics: caretChord.totalLyrics,
        direction,
      });
      if (!nudge) return;
      const result = applyChordReposition(source, nudge.event);
      // Keep the moved chord selected: caret inside its new bracket.
      const target = result.caretOffset - (caretChord.chordName.length + 2) + 1;
      commit(result, target);
    },
    [caretChord, source, commit],
  );

  const onRemove = useCallback(() => {
    if (!caretChord) return;
    const result = applyChordDelete(source, {
      line: caretChord.line,
      fromColumn: caretChord.sourceColumn,
      fromLength: caretChord.bracketLength,
      expected: caretChord.chordName,
    });
    commit(result);
  }, [caretChord, source, commit]);

  const onChordReposition = useCallback(
    (event: ChordRepositionEvent) => {
      const result = applyChordReposition(source, event);
      commit(result);
    },
    [source, commit],
  );

  const onChordSelectionChange = useCallback(
    (selection: ChordSelection | null) => {
      if (!selection) return;
      // If a source-mutating commit is in flight (e.g. the preview's
      // keyboard nudge fires onChordReposition then this in the same
      // tick), its caret restoration is already queued against the NEW
      // source — don't fight it with a caret move computed from the
      // still-stale `source` here. The click path has no pending commit,
      // so it falls through and moves the caret as intended.
      if (pendingCaretRef.current != null) return;
      const offset = chordSelectionCaretOffset(source, selection);
      if (offset == null) return;
      // Move the editor caret just inside the clicked chord's bracket;
      // the caret path then re-resolves it as the selection.
      editorRef.current?.setCaret(offset + 1);
    },
    [source, editorRef],
  );

  const canLeft = caretChord
    ? nudgeChordPosition(caretChord.offset, [], caretChord.totalLyrics, -1) !== null
    : false;
  const canRight = caretChord
    ? nudgeChordPosition(caretChord.offset, [], caretChord.totalLyrics, 1) !== null
    : false;

  const inspectorProps: ChordInspectorProps = {
    selected: caretChord != null,
    chordName: caretChord?.chordName ?? '',
    displayName: displayNameFor(parts, caretChord?.chordName ?? ''),
    root: parts.root,
    accidental: parts.accidental ?? '',
    suffix: parts.suffix ?? '',
    bass: parts.bass ?? '',
    canLeft,
    canRight,
    onChange,
    onNudge,
    // Insert needs a caret to target; offer it only once the editor has
    // reported a caret position and editing is not gated.
    onInsert: editable && caret != null ? onInsert : undefined,
    onRemove: caretChord != null ? onRemove : undefined,
    note: editable ? undefined : 'Clear transpose / capo to edit chords.',
  };

  return {
    onCaretChange,
    chordSelection,
    onChordSelectionChange,
    onChordReposition,
    inspectorProps,
  };
}
