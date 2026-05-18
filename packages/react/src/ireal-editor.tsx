import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';

import {
  irealChordToString,
  irealSectionLabelToString,
  type IrealAccidental,
  type IrealBar,
  type IrealKeyMode,
  type IrealSection,
  type IrealSong,
} from './ireal-ast';

// Narrow subset of `@chordsketch/wasm` this editor touches. Defined
// structurally so the wasm glue does not enter the React bundle's
// type graph. Mirrors the parse/serialise stub in
// `tests/helpers/wasm-stub.ts`.
interface IrealEditorWasm {
  default: () => Promise<unknown>;
  parseIrealb: (input: string) => string;
  serializeIrealb: (json: string) => string;
}

/** Loader override. Tests inject a structurally-compatible stub.
 * @internal */
export type IrealEditorLoader = () => Promise<IrealEditorWasm>;

const defaultLoader: IrealEditorLoader = () =>
  import('@chordsketch/wasm') as Promise<IrealEditorWasm>;

export interface IrealEditorProps {
  /** Current `irealb://` URL. When this prop changes between renders
   * (and does not match the URL the editor last emitted via
   * `onChange`), the editor re-parses and resets its internal AST. */
  source: string;
  /** Called whenever the user edits a field. Receives the
   * newly-serialised `irealb://` URL. Omit to drive the editor in
   * read-only mode. */
  onChange?: (url: string) => void;
  /** Force read-only display. When `true`, all form fields render
   * with `disabled` and the URL textarea is `readOnly`. */
  readOnly?: boolean;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** Optional inline style applied to the wrapper. */
  style?: CSSProperties;
  /** Optional renderer for parse / serialise errors. Defaults to an
   * inline `role="alert"`. Pass `null` to hide errors entirely. */
  errorFallback?: ReactNode | ((error: Error) => ReactNode) | null;
  /** Whether to show the raw-URL textarea. Defaults to `true`. */
  showUrl?: boolean;
  /** Whether to show the read-only bar grid. Defaults to `true`. */
  showBars?: boolean;
  /** Optional loader override.
   * @internal */
  loader?: IrealEditorLoader;
}

/** Default empty song. Matches `makeEmptySong` in
 * `packages/ui-irealb-editor/src/index.ts` (sister site per
 * [ADR-0020](../../../docs/adr/0020-ireal-pro-react-surface.md)). */
function makeEmptySong(): IrealSong {
  return {
    title: '',
    composer: null,
    style: null,
    key_signature: {
      root: { note: 'C', accidental: 'natural' },
      mode: 'major',
    },
    time_signature: { numerator: 4, denominator: 4 },
    tempo: null,
    transpose: 0,
    sections: [],
  };
}

const ROOTS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const ACCIDENTALS: readonly IrealAccidental[] = ['natural', 'flat', 'sharp'];
const MODES: readonly IrealKeyMode[] = ['major', 'minor'];
// Valid `numerator` range is `1..=12` per `crates/ireal/src/ast.rs`
// (`numerator == 0 || numerator > 12` rejected in `IrealSong::new`).
// Include `1` so an existing chart with a `T14` time signature
// round-trips through the dropdown without leaving it stuck on a
// non-matching option.
const TIME_NUMERATORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const TIME_DENOMINATORS = [2, 4, 8] as const;

/**
 * Native React iReal Pro chart editor — header metadata form + a
 * read-only bar grid summarising each section's chord stream + a
 * round-trip URL textarea.
 *
 * Per [ADR-0020](../../../docs/adr/0020-ireal-pro-react-surface.md),
 * this is a v0.1.0 MVP: structural section / bar editing,
 * popover-based per-bar chord editing, and grid keyboard navigation
 * are intentionally not implemented here yet. Consumers who need
 * those today should drive `@chordsketch/wasm` directly or consume
 * the playground at <https://chordsketch.koeda.me/chordsketch/irealpro/>.
 */
export function IrealEditor({
  source,
  onChange,
  readOnly = false,
  className,
  style,
  errorFallback,
  showUrl = true,
  showBars = true,
  loader = defaultLoader,
}: IrealEditorProps): JSX.Element {
  const wasmRef = useRef<IrealEditorWasm | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // Tracks the URL we last emitted via `onChange`, so an incoming
  // `source` prop matching it is recognised as our own echo and
  // does not trigger a re-parse (which would discard pending local
  // typing on a debounce path). `null` is the "have not emitted
  // anything yet" sentinel — distinguishing it from `''` is
  // important because the initial `source` may legitimately be the
  // empty string and that path still needs to seed the empty-song
  // state on first run.
  const lastEmittedRef = useRef<string | null>(null);

  const [song, setSong] = useState<IrealSong | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [urlDraft, setUrlDraft] = useState<string>(source);
  // True while the user is actively typing in the URL textarea
  // (set by `handleUrlChange`, cleared by `handleUrlCommit` or when
  // an external `source`-prop change takes authority). `emit` checks
  // this before updating the draft so a field edit does not clobber
  // mid-URL typing; external source changes always win and clear it.
  const urlDirtyRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        if (wasmRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          if (cancelled) return;
          wasmRef.current = mod;
        }
        if (source === lastEmittedRef.current) {
          // Our own emit echoed back. Keep the local song state.
          return;
        }
        // An external `source` change has authority over the
        // local URL textarea draft: a controlled parent passing
        // a new URL is asserting "this is the canonical chart
        // now". Clearing the dirty flag and overwriting the
        // draft keeps the textarea aligned with the form / bar
        // grid displayed alongside it. The previous mid-edit
        // typing is discarded — the host can prevent the
        // override by leaving the `source` prop stable until
        // they want to accept user edits.
        urlDirtyRef.current = false;
        if (source.length === 0) {
          if (cancelled) return;
          setSong(makeEmptySong());
          setError(null);
          setUrlDraft('');
          return;
        }
        const json = wasmRef.current.parseIrealb(source);
        let parsed: IrealSong;
        try {
          parsed = JSON.parse(json) as IrealSong;
        } catch (jsonError) {
          throw new Error(
            `Invalid AST JSON from @chordsketch/wasm.parseIrealb: ${
              jsonError instanceof Error ? jsonError.message : String(jsonError)
            }`,
          );
        }
        if (cancelled) return;
        setSong(parsed);
        setError(null);
        setUrlDraft(source);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const emit = useCallback(
    (next: IrealSong): void => {
      const wasm = wasmRef.current;
      if (wasm === null) {
        // Wasm has not finished loading. We deliberately do NOT
        // apply the optimistic `setSong(next)` because the
        // subsequent serialise would not run, leaving the
        // displayed form state ahead of the URL the parent sees.
        // The form fields disable themselves until wasm is ready
        // via the `song === null` early-return above, so this
        // branch is unreachable in practice; the guard exists
        // for defence-in-depth.
        return;
      }
      let url: string;
      try {
        url = wasm.serializeIrealb(JSON.stringify(next));
      } catch (e) {
        // Serialise failed — do NOT commit the optimistic
        // `setSong(next)` because the parent will never see the
        // matching URL, leaving the displayed editor diverged
        // from the controlled `source` prop. Surface the error
        // and leave the previously-stable song state untouched.
        setError(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      setSong(next);
      lastEmittedRef.current = url;
      // Clear any sticky external-parse error once a local edit
      // successfully serialises. Without this the fieldset would
      // remain disabled after the host recovers from a malformed
      // `source` because `disabled` is gated on `error !== null`.
      setError(null);
      if (!urlDirtyRef.current) setUrlDraft(url);
      if (onChange !== undefined) onChange(url);
    },
    [onChange],
  );

  const handleUrlChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
    urlDirtyRef.current = true;
    setUrlDraft(event.target.value);
  }, []);

  const handleUrlCommit = useCallback((): void => {
    urlDirtyRef.current = false;
    const wasm = wasmRef.current;
    if (wasm === null) return;
    const value = urlDraft.trim();
    if (value.length === 0) {
      const empty = makeEmptySong();
      emit(empty);
      return;
    }
    try {
      const json = wasm.parseIrealb(value);
      let parsed: IrealSong;
      try {
        parsed = JSON.parse(json) as IrealSong;
      } catch (jsonError) {
        throw new Error(
          `Invalid AST JSON from @chordsketch/wasm.parseIrealb: ${
            jsonError instanceof Error ? jsonError.message : String(jsonError)
          }`,
        );
      }
      emit(parsed);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [emit, urlDraft]);

  const errorNode = useMemo<ReactNode>(() => {
    if (error === null) return null;
    if (errorFallback === null) return null;
    if (errorFallback === undefined) {
      return (
        <p className="chordsketch-ireal-editor__error" role="alert">
          {error.message}
        </p>
      );
    }
    if (typeof errorFallback === 'function') {
      return errorFallback(error);
    }
    return errorFallback;
  }, [error, errorFallback]);

  // When an external `source` failed to parse the metadata fieldset
  // is disabled too. Editing a field would otherwise serialise the
  // pre-error `song` snapshot and silently emit a URL that
  // overwrites the broken one the parent passed in — and the user
  // who pasted the malformed URL would have no signal that their
  // edit lost their original input.
  const disabled = readOnly || onChange === undefined || error !== null;

  const wrapperClass = ['chordsketch-ireal-editor', className]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join(' ');

  if (song === null && error === null) {
    return (
      <div className={wrapperClass} style={style} aria-busy="true">
        <p className="chordsketch-ireal-editor__loading">Loading…</p>
      </div>
    );
  }

  return (
    <div className={wrapperClass} style={style}>
      {errorNode}
      {song !== null ? (
        <>
          <fieldset className="chordsketch-ireal-editor__metadata" disabled={disabled}>
            <legend>Chart metadata</legend>
            <label className="chordsketch-ireal-editor__field">
              <span>Title</span>
              <input
                type="text"
                value={song.title}
                onChange={(e) => emit({ ...song, title: e.target.value })}
              />
            </label>
            <label className="chordsketch-ireal-editor__field">
              <span>Composer</span>
              <input
                type="text"
                value={song.composer ?? ''}
                onChange={(e) =>
                  emit({ ...song, composer: e.target.value.length === 0 ? null : e.target.value })
                }
              />
            </label>
            <label className="chordsketch-ireal-editor__field">
              <span>Style</span>
              <input
                type="text"
                value={song.style ?? ''}
                onChange={(e) =>
                  emit({ ...song, style: e.target.value.length === 0 ? null : e.target.value })
                }
              />
            </label>
            <div className="chordsketch-ireal-editor__key">
              <label className="chordsketch-ireal-editor__field">
                <span>Key root</span>
                <select
                  value={song.key_signature.root.note}
                  onChange={(e) =>
                    emit({
                      ...song,
                      key_signature: {
                        ...song.key_signature,
                        root: { ...song.key_signature.root, note: e.target.value },
                      },
                    })
                  }
                >
                  {ROOTS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="chordsketch-ireal-editor__field">
                <span>Accidental</span>
                <select
                  value={song.key_signature.root.accidental}
                  onChange={(e) =>
                    emit({
                      ...song,
                      key_signature: {
                        ...song.key_signature,
                        root: {
                          ...song.key_signature.root,
                          accidental: e.target.value as IrealAccidental,
                        },
                      },
                    })
                  }
                >
                  {ACCIDENTALS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="chordsketch-ireal-editor__field">
                <span>Mode</span>
                <select
                  value={song.key_signature.mode}
                  onChange={(e) =>
                    emit({
                      ...song,
                      key_signature: {
                        ...song.key_signature,
                        mode: e.target.value as IrealKeyMode,
                      },
                    })
                  }
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="chordsketch-ireal-editor__time">
              <label className="chordsketch-ireal-editor__field">
                <span>Time num.</span>
                <select
                  value={song.time_signature.numerator}
                  onChange={(e) =>
                    emit({
                      ...song,
                      time_signature: {
                        ...song.time_signature,
                        numerator: Number(e.target.value),
                      },
                    })
                  }
                >
                  {TIME_NUMERATORS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="chordsketch-ireal-editor__field">
                <span>Time denom.</span>
                <select
                  value={song.time_signature.denominator}
                  onChange={(e) =>
                    emit({
                      ...song,
                      time_signature: {
                        ...song.time_signature,
                        denominator: Number(e.target.value),
                      },
                    })
                  }
                >
                  {TIME_DENOMINATORS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="chordsketch-ireal-editor__field">
              <span>Tempo</span>
              <input
                type="number"
                min={1}
                max={400}
                value={song.tempo ?? ''}
                placeholder="—"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw.length === 0) {
                    emit({ ...song, tempo: null });
                    return;
                  }
                  const parsed = Number(raw);
                  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 400) return;
                  emit({ ...song, tempo: parsed });
                }}
              />
            </label>
            <label className="chordsketch-ireal-editor__field">
              <span>Transpose</span>
              <input
                type="number"
                min={-11}
                max={11}
                step={1}
                value={song.transpose}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  const clamped = Math.max(-11, Math.min(11, Math.round(parsed)));
                  emit({ ...song, transpose: clamped });
                }}
              />
            </label>
          </fieldset>
          {showBars ? <BarGrid sections={song.sections} /> : null}
          {showUrl ? (
            <label className="chordsketch-ireal-editor__url">
              <span>URL</span>
              <textarea
                value={urlDraft}
                onChange={handleUrlChange}
                onBlur={handleUrlCommit}
                readOnly={disabled}
                spellCheck={false}
                aria-label="iReal Pro URL"
                rows={3}
              />
            </label>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface BarGridProps {
  sections: readonly IrealSection[];
}

function BarGrid({ sections }: BarGridProps): JSX.Element {
  if (sections.length === 0) {
    return (
      <p className="chordsketch-ireal-editor__empty-bars">
        No sections in this chart.
      </p>
    );
  }
  return (
    <div className="chordsketch-ireal-editor__sections">
      {sections.map((section, sIndex) => (
        <section
          key={sIndex}
          className="chordsketch-ireal-editor__section"
          aria-label={`Section ${irealSectionLabelToString(section.label)}`}
        >
          <h3 className="chordsketch-ireal-editor__section-label">
            {irealSectionLabelToString(section.label)}
          </h3>
          <ol className="chordsketch-ireal-editor__bars">
            {section.bars.map((bar, bIndex) => (
              <li key={bIndex} className="chordsketch-ireal-editor__bar">
                <span className="chordsketch-ireal-editor__bar-index">{bIndex + 1}</span>
                <span className="chordsketch-ireal-editor__bar-chords">
                  {formatBarChords(bar)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function formatBarChords(bar: IrealBar): string {
  if (bar.chords.length === 0) return '—';
  return bar.chords
    .map((c) => (c.kind === 'slash_repeat' ? '/' : irealChordToString(c.chord)))
    .join(' ');
}
