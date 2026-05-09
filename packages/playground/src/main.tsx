import { StrictMode, useCallback, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';

import init from '@chordsketch/wasm';
import { SAMPLE_CHORDPRO } from '@chordsketch/ui-web';
import {
  RendererPreview,
  SourceEditor,
  SplitLayout,
  Transpose,
  type PreviewFormat,
} from '@chordsketch/react';
import '@chordsketch/react/styles.css';

import './playground.css';

// ---------------------------------------------------------------
// WASM bootstrap.
// ---------------------------------------------------------------
//
// `init()` must resolve before any wasm-backed function is called.
// `<RendererPreview>` and `<SourceEditor>` from `@chordsketch/react`
// either don't depend on wasm (the editor is pure CodeMirror) or
// gate their first render on the same module's lazy loader, so the
// playground only needs to kick off `init()` once at module load
// to warm the path.
void init();

// ---------------------------------------------------------------
// PlaygroundApp — top-level shell with format select + transpose
// over the ChordPro source editor and renderer preview.
// ---------------------------------------------------------------
//
// iRealb support has been removed from the playground for the
// 2026-05-09 design-system migration window; it will be
// reintroduced as a separate feature once the React component
// surface for the bar-grid editor is ready. The format toggle,
// URL-hash sync, and `IrealbPane` wrapper that previously lived
// here have been deleted along with the imports — searching for
// `irealb` in the playground source should turn up zero hits.

function PlaygroundApp(): JSX.Element {
  const [source, setSource] = useState<string>(SAMPLE_CHORDPRO);
  const [previewFormat, setPreviewFormat] = useState<PreviewFormat>('html');
  const [transpose, setTranspose] = useState<number>(0);

  const handleSourceChange = useCallback((next: string) => {
    setSource(next);
  }, []);

  const formatSelectId = useId();

  return (
    <div className="chordsketch-app">
      <header className="chordsketch-app__header">
        <h1 className="chordsketch-app__title">
          <span className="chordsketch-app__brand-mark" aria-hidden="true" />
          <span>ChordSketch Playground</span>
        </h1>
        <div className="chordsketch-app__controls">
          <label
            htmlFor={formatSelectId}
            className="chordsketch-app__control-label"
          >
            Format
            <select
              id={formatSelectId}
              className="chordsketch-app__select"
              value={previewFormat}
              onChange={(e) =>
                setPreviewFormat(e.currentTarget.value as PreviewFormat)
              }
            >
              <option value="html">HTML</option>
              <option value="text">Text</option>
              <option value="pdf">PDF</option>
            </select>
          </label>
          <Transpose
            className="chordsketch-app__transpose"
            value={transpose}
            onChange={setTranspose}
            label="Transpose"
          />
        </div>
      </header>

      <SplitLayout
        className="chordsketch-app__split"
        start={
          <SourceEditor
            value={source}
            onChange={handleSourceChange}
            placeholder="Paste your ChordPro here…"
          />
        }
        end={
          <RendererPreview
            source={source}
            transpose={transpose}
            format={previewFormat}
          />
        }
      />
    </div>
  );
}

const root = document.getElementById('app');
if (!root) {
  throw new Error('Playground entry point #app element missing from index.html');
}

createRoot(root).render(
  <StrictMode>
    <PlaygroundApp />
  </StrictMode>,
);
