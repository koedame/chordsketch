/**
 * React root for the desktop frontend. Owns the editor / preview
 * state (source, mode, transpose, format) and publishes a
 * {@link desktopBridge} listener so the Tauri menu / dialog /
 * updater layer in `main.tsx` can mutate the state from outside
 * React.
 *
 * Three editor modes:
 *
 *  - `chordpro` — tree-sitter-backed CodeMirror editor
 *    (`<ChordProDesktopEditor>`) paired with `<ChordProPreview>`
 *    from `@chordsketch/react`. Default for fresh launch and any
 *    ChordPro file (`.cho` / `.chordpro` / etc.).
 *  - `irealb-grid` — bar-grid GUI editor from
 *    `@chordsketch/ui-irealb-editor` wrapped by
 *    `<IrealGridEditor>`, paired with `<IrealPreview>` from
 *    `@chordsketch/react`. Default for any opened iRealb file.
 *  - `irealb-text` — plain `<textarea>` for raw `irealb://` URL
 *    editing, paired with the same `<IrealPreview>` SVG. Surfaced
 *    via the View menu as a fallback when the user wants to
 *    read or hand-edit the URL string.
 *
 * The sample seed (`SAMPLE_CHORDPRO`) is imported from the browser
 * playground (`packages/playground/src/sample.ts`) so the two hosts
 * read the same default content from one source of truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import {
  ChordProPreview,
  IrealPreview,
} from '@chordsketch/react';
import '@chordsketch/react/styles.css';

import {
  ChordProDesktopEditor,
  type ChordProDesktopEditorHandle,
} from './ChordProDesktopEditor';
import {
  IrealGridEditor,
  type IrealGridEditorHandle,
} from './IrealGridEditor';
import { desktopBridge, type EditorMode } from './desktop-bridge';
// `SAMPLE_CHORDPRO` is imported from the playground so the desktop
// and the browser playground share one source of truth. The Vite
// alias (`apps/desktop/vite.config.ts`) + tsconfig path mapping
// (`apps/desktop/tsconfig.json`) route this specifier to
// `packages/playground/src/sample.ts`.
import { SAMPLE_CHORDPRO } from '@chordsketch/playground-sample';

type PreviewFormat = 'html' | 'text' | 'pdf';

// Range is `-11..=11` — matches the `@chordsketch/react`
// `<Transpose>` default. A full octave (`±12`) is the identity
// transposition, so the interesting values stop at ±11.
const TRANSPOSE_MIN = -11;
const TRANSPOSE_MAX = 11;

function clampTranspose(value: number): number {
  if (value < TRANSPOSE_MIN) return TRANSPOSE_MIN;
  if (value > TRANSPOSE_MAX) return TRANSPOSE_MAX;
  return value;
}

export function App(): JSX.Element {
  const [source, setSourceState] = useState<string>(SAMPLE_CHORDPRO);
  const [mode, setMode] = useState<EditorMode>('chordpro');
  const [transpose, setTranspose] = useState<number>(0);
  const [format, setFormat] = useState<PreviewFormat>('html');

  // Refs to the underlying editor / preview panes so focus
  // commands from the Tauri menu can resolve to a real DOM
  // element. The preview pane is always a single `<div>` in the
  // current layout, so we ref the wrapper directly.
  const chordProEditorRef = useRef<ChordProDesktopEditorHandle>(null);
  const irealGridEditorRef = useRef<IrealGridEditorHandle>(null);
  const irealTextAreaRef = useRef<HTMLTextAreaElement>(null);
  const previewPaneRef = useRef<HTMLDivElement>(null);

  // Track the latest value via refs so the bridge's synchronous
  // getter contract (`getSource()` etc.) can return the
  // currently-committed value without waiting for a re-render.
  // React batches setState updates; for the menu handler workflow
  // (Save reads source via the bridge), the ref-mirrored value is
  // the source of truth.
  const sourceRef = useRef(source);
  const modeRef = useRef(mode);
  const transposeRef = useRef(transpose);

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    transposeRef.current = transpose;
  }, [transpose]);

  // User-edit source path: update React state AND notify out-of-React
  // subscribers (the window-title dirty indicator in `main.tsx`).
  // Deliberately scoped to user input — programmatic loads (file
  // open, mode swap) drive `lastSavedContent` directly and update
  // the title imperatively. The bridge's `setSource` (used by
  // file-open code) goes through a separate path below that does NOT
  // call `_notifySourceChange`.
  const handleSourceChange = useCallback((next: string) => {
    setSourceState(next);
    desktopBridge._notifySourceChange(next);
  }, []);

  const handleTextAreaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.currentTarget.value;
      setSourceState(next);
      desktopBridge._notifySourceChange(next);
    },
    [],
  );

  const focusActiveEditor = useCallback(() => {
    switch (modeRef.current) {
      case 'chordpro':
        chordProEditorRef.current?.focus();
        return;
      case 'irealb-grid':
        irealGridEditorRef.current?.focus();
        return;
      case 'irealb-text':
        irealTextAreaRef.current?.focus();
        return;
    }
  }, []);

  // Publish the bridge listener on mount, detach on unmount.
  //
  // The bridge's setters below mirror-update the ref BEFORE calling
  // React's setState so a Tauri-side caller (e.g. `runOpen` in
  // `main.tsx`) that issues `setSource()` then immediately reads
  // `getSource()` sees the new value, without waiting for the next
  // React render to commit. The user-edit React state path
  // (`handleSourceChange`) is intentionally NOT covered by the
  // synchronous-read guarantee: it goes through `setSourceState` only
  // and the ref catches up on the next render via the
  // `useEffect(..., [source])` mirror above. That asymmetry is
  // correct — Tauri-side menu handlers are the only callers that
  // need the synchronous-read invariant. The ref is the imperative
  // source of truth from Tauri's perspective; React's state drives
  // the DOM.
  useEffect(() => {
    const detach = desktopBridge.attach({
      getSource() {
        return sourceRef.current;
      },
      setSource(value) {
        sourceRef.current = value;
        setSourceState(value);
      },
      getMode() {
        return modeRef.current;
      },
      setMode(next) {
        modeRef.current = next;
        setMode(next);
      },
      getTranspose() {
        return transposeRef.current;
      },
      stepTranspose(delta) {
        const next = clampTranspose(transposeRef.current + delta);
        transposeRef.current = next;
        setTranspose(next);
      },
      resetTranspose() {
        transposeRef.current = 0;
        setTranspose(0);
      },
      focusEditor() {
        focusActiveEditor();
      },
      focusPreview() {
        previewPaneRef.current?.focus();
      },
    });
    return detach;
  }, [focusActiveEditor]);

  // Editor pane — branch on mode. The wrapper class matches the
  // shared design-system split-pane shell so the global stylesheet
  // styles it.
  const editorPane = useMemo(() => {
    switch (mode) {
      case 'chordpro':
        return (
          <ChordProDesktopEditor
            ref={chordProEditorRef}
            value={source}
            onChange={handleSourceChange}
            placeholder="Paste your ChordPro here…"
            className="chordsketch-desktop__cm-editor"
          />
        );
      case 'irealb-grid':
        return (
          <IrealGridEditor
            ref={irealGridEditorRef}
            value={source}
            onChange={handleSourceChange}
            className="chordsketch-desktop__ireal-grid"
          />
        );
      case 'irealb-text':
        return (
          <textarea
            ref={irealTextAreaRef}
            className="chordsketch-desktop__ireal-text"
            value={source}
            onChange={handleTextAreaChange}
            spellCheck={false}
            placeholder="irealb://…"
          />
        );
    }
  }, [mode, source, handleSourceChange, handleTextAreaChange]);

  // Preview pane — ChordPro modes route through `<ChordProPreview>`
  // (HTML / text / PDF), iRealb modes route through `<IrealPreview>`
  // (SVG chart). The preview pane carries `tabIndex={-1}` so the
  // "Focus Preview" menu command can move keyboard focus onto it.
  const isIrealMode = mode === 'irealb-grid' || mode === 'irealb-text';

  return (
    <div className="chordsketch-desktop">
      <div className="chordsketch-desktop__split">
        <div className="chordsketch-desktop__editor-pane">{editorPane}</div>
        <div
          ref={previewPaneRef}
          className="chordsketch-desktop__preview-pane"
          tabIndex={-1}
        >
          {isIrealMode ? (
            <IrealPreview
              source={source}
              className="chordsketch-desktop__ireal-preview"
            />
          ) : (
            <ChordProPreview
              source={source}
              format={format}
              onFormatChange={setFormat}
              transpose={transpose}
              onTransposeChange={setTranspose}
              transposeMin={TRANSPOSE_MIN}
              transposeMax={TRANSPOSE_MAX}
              pdfFilename="chordsketch.pdf"
              className="chordsketch-desktop__chordpro-preview"
            />
          )}
        </div>
      </div>
    </div>
  );
}
