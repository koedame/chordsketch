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
  type IrealAccidental,
  type IrealBar,
  type IrealKeyMode,
  type IrealSection,
  type IrealSectionLabel,
  type IrealSong,
} from './ireal-ast';
import {
  IrealBarGrid,
  reconcileActiveBar,
  type IrealActiveBarRef,
  type IrealStructuralOps,
} from './ireal-editor-bar-grid';
import { IrealBarPopover } from './ireal-editor-popover';
import {
  makeDefaultBar,
  makeDefaultSection,
  sectionLabelEquals,
  formatSectionLabelForPrompt,
} from './ireal-editor-defaults';
import {
  defaultPromptSectionLabel,
  defaultConfirmDeleteSection,
} from './ireal-editor-section-prompt';
import { useAnnouncer } from './use-announcer';

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
  /** Whether to show the bar grid (structural editing + ARIA grid).
   * Defaults to `true`. */
  showBars?: boolean;
  /**
   * Override for the section-label prompt fired by "+ Add section"
   * and the per-section rename button. Defaults to
   * `window.prompt` + the parser in `parseIrealSectionLabel`.
   * Hosts that want a styled modal can inject a custom resolver
   * that returns `null` for cancellation.
   */
  promptSectionLabel?: (current: IrealSectionLabel | null) => IrealSectionLabel | null;
  /**
   * Override for the delete-section confirmation. Defaults to
   * `window.confirm`. Returning `false` cancels the deletion
   * before any AST mutation.
   */
  confirmDeleteSection?: (label: IrealSectionLabel) => boolean;
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
 * Native React iReal Pro chart editor — header metadata form + an
 * interactive bar grid with structural editing and keyboard
 * navigation + a round-trip URL textarea + a polite ARIA live
 * region that announces structural edits.
 *
 * The bar grid surfaces:
 * - ARIA grid semantics (`role="grid"`, `aria-rowcount`,
 *   `aria-colcount={4}`, `role="row"`, `role="gridcell"`,
 *   `aria-rowindex` / `aria-colindex`).
 * - Roving tabindex per W3C APG — exactly one bar cell carries
 *   `tabindex="0"` (or none for an empty chart).
 * - Per-section action buttons (rename / move up / move down /
 *   delete) and per-bar action buttons (move left / move right /
 *   delete), plus "+ Add section" / "+ Add bar" trailers.
 * - Keyboard shortcuts on the focused bar cell:
 *   `Arrow{Left,Right,Up,Down}` / `Home` / `End` for roving
 *   navigation, `Alt+ArrowLeft`/`Alt+ArrowRight` to reorder, and
 *   `Delete` / `Backspace` to remove the bar.
 *
 * Clicking a bar cell opens an `<IrealBarPopover>` modal dialog
 * (`role="dialog"` `aria-modal="true"` with focus trap + Escape /
 * outside-click dismissal) that edits the bar's start / end
 * barlines, chord rows (root + accidental + 12 named qualities +
 * Custom + optional `/X` bass + beat position 1 / 1.5 / … / 4.5;
 * add / remove / reorder), N-th ending (empty / 0 untitled / 1–9),
 * and musical symbol (None / Segno / Coda / Fine / Fermata /
 * Break + the 11 player-recognised D.C. / D.S. macro variants).
 * Save commits via the host's `emit` path; Cancel / Escape /
 * outside-click discard the draft.
 *
 * Per [ADR-0020](../../../docs/adr/0020-ireal-pro-react-surface.md),
 * `v0.2.0` reaches parity with the private
 * `@chordsketch/ui-irealb-editor` for this surface — the
 * playground and the desktop app continue to back the DOM editor
 * during the migration window.
 *
 * `promptSectionLabel` / `confirmDeleteSection` props accept
 * custom resolvers for hosts that want styled modals instead of
 * the default `window.prompt` / `window.confirm`.
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
  promptSectionLabel = defaultPromptSectionLabel,
  confirmDeleteSection = defaultConfirmDeleteSection,
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

  // Roving-tabindex active bar (#2368 sister-site). `null` for an
  // empty chart (no Tab stop in the grid until a bar exists).
  const [activeBar, setActiveBar] = useState<IrealActiveBarRef | null>(null);
  const { announce, liveRegion } = useAnnouncer();

  // Reconcile the active-bar ref whenever the song's structure
  // changes — a delete or move can leave the ref pointing at a
  // non-existent cell. Sister-site: `reconcileActiveBar` in
  // `packages/ui-irealb-editor/src/index.ts` (lines 151-191).
  useEffect(() => {
    if (song === null) return;
    const next = reconcileActiveBar(activeBar, song.sections);
    if (next !== activeBar) {
      setActiveBar(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.sections]);

  // Structural editing ops. Each closure mutates a shallow-cloned
  // song via the existing `emit` path so the URL round-trip stays
  // single-source — same path the header form already uses.
  // Sister-site: the `StructuralOps` implementation in
  // `packages/ui-irealb-editor/src/index.ts` (lines 334-547).
  const ops = useMemo<IrealStructuralOps>(() => {
    if (song === null || disabled) {
      const noop = (): void => {};
      return {
        addSection: noop,
        renameSection: noop,
        deleteSection: noop,
        moveSectionUp: noop,
        moveSectionDown: noop,
        addBar: noop,
        deleteBar: noop,
        moveBarLeft: noop,
        moveBarRight: noop,
      };
    }
    return {
      addSection: () => {
        const label = promptSectionLabel(null);
        if (label === null) return;
        emit({
          ...song,
          sections: [...song.sections, makeDefaultSection(label)],
        });
        announce(`Section ${formatSectionLabelForPrompt(label)} added`);
      },
      renameSection: (secIndex, current) => {
        if (secIndex < 0 || secIndex >= song.sections.length) return;
        const nextLabel = promptSectionLabel(current);
        if (nextLabel === null) return;
        if (sectionLabelEquals(current, nextLabel)) return;
        const sections = song.sections.map((s, i) =>
          i === secIndex ? { ...s, label: nextLabel } : s,
        );
        emit({ ...song, sections });
        announce(
          `Section renamed from ${formatSectionLabelForPrompt(current)} ` +
            `to ${formatSectionLabelForPrompt(nextLabel)}`,
        );
      },
      deleteSection: (secIndex) => {
        const section = song.sections[secIndex];
        if (!section) return;
        if (!confirmDeleteSection(section.label)) return;
        const removedLabel = section.label;
        const sections = song.sections.filter((_, i) => i !== secIndex);
        emit({ ...song, sections });
        announce(`Section ${formatSectionLabelForPrompt(removedLabel)} deleted`);
      },
      moveSectionUp: (secIndex) => {
        if (secIndex <= 0 || secIndex >= song.sections.length) return;
        const sections = [...song.sections];
        const tmp = sections[secIndex - 1]!;
        sections[secIndex - 1] = sections[secIndex]!;
        sections[secIndex] = tmp;
        // Re-anchor the active-bar ref against the moved section —
        // see sister-site rationale at
        // `packages/ui-irealb-editor/src/index.ts:405-417`.
        if (activeBar !== null) {
          if (activeBar.secIndex === secIndex) {
            setActiveBar({ secIndex: secIndex - 1, barIndex: activeBar.barIndex });
          } else if (activeBar.secIndex === secIndex - 1) {
            setActiveBar({ secIndex, barIndex: activeBar.barIndex });
          }
        }
        emit({ ...song, sections });
        announce(
          `Section ${formatSectionLabelForPrompt(sections[secIndex - 1]!.label)} moved up`,
        );
      },
      moveSectionDown: (secIndex) => {
        if (secIndex < 0 || secIndex >= song.sections.length - 1) return;
        const sections = [...song.sections];
        const tmp = sections[secIndex + 1]!;
        sections[secIndex + 1] = sections[secIndex]!;
        sections[secIndex] = tmp;
        if (activeBar !== null) {
          if (activeBar.secIndex === secIndex) {
            setActiveBar({ secIndex: secIndex + 1, barIndex: activeBar.barIndex });
          } else if (activeBar.secIndex === secIndex + 1) {
            setActiveBar({ secIndex, barIndex: activeBar.barIndex });
          }
        }
        emit({ ...song, sections });
        announce(
          `Section ${formatSectionLabelForPrompt(sections[secIndex + 1]!.label)} moved down`,
        );
      },
      addBar: (secIndex) => {
        const section = song.sections[secIndex];
        if (!section) return;
        const newBarIndex = section.bars.length;
        const sections = song.sections.map((s, i) =>
          i === secIndex ? { ...s, bars: [...s.bars, makeDefaultBar()] } : s,
        );
        emit({ ...song, sections });
        announce(
          `Bar ${newBarIndex + 1} added to section ${formatSectionLabelForPrompt(section.label)}`,
        );
      },
      deleteBar: (secIndex, barIndex) => {
        const section = song.sections[secIndex];
        if (!section) return;
        if (barIndex < 0 || barIndex >= section.bars.length) return;
        const removedBarNumber = barIndex + 1;
        const sectionLabel = section.label;
        const sections = song.sections.map((s, i) =>
          i === secIndex
            ? { ...s, bars: s.bars.filter((_, j) => j !== barIndex) }
            : s,
        );
        emit({ ...song, sections });
        announce(
          `Bar ${removedBarNumber} deleted from section ${formatSectionLabelForPrompt(sectionLabel)}`,
        );
      },
      moveBarLeft: (secIndex, barIndex) => {
        const section = song.sections[secIndex];
        if (!section) return;
        if (barIndex <= 0 || barIndex >= section.bars.length) return;
        const bars = [...section.bars];
        const tmp = bars[barIndex - 1]!;
        bars[barIndex - 1] = bars[barIndex]!;
        bars[barIndex] = tmp;
        const sections = song.sections.map((s, i) =>
          i === secIndex ? { ...s, bars } : s,
        );
        emit({ ...song, sections });
        announce(`Bar ${barIndex + 1} moved left`);
      },
      moveBarRight: (secIndex, barIndex) => {
        const section = song.sections[secIndex];
        if (!section) return;
        if (barIndex < 0 || barIndex >= section.bars.length - 1) return;
        const bars = [...section.bars];
        const tmp = bars[barIndex + 1]!;
        bars[barIndex + 1] = bars[barIndex]!;
        bars[barIndex] = tmp;
        const sections = song.sections.map((s, i) =>
          i === secIndex ? { ...s, bars } : s,
        );
        emit({ ...song, sections });
        announce(`Bar ${barIndex + 1} moved right`);
      },
    };
  }, [song, disabled, emit, announce, promptSectionLabel, confirmDeleteSection, activeBar]);

  // Popover open-target. When non-null the bar at that index has
  // its modal popover rendered next to the bar grid; the popover
  // commits via `onSave(next)` which routes through `emit()`.
  const [popoverTarget, setPopoverTarget] = useState<{
    secIndex: number;
    barIndex: number;
  } | null>(null);

  // Anchor ref tracking the last-clicked bar-cell button so the
  // popover's focus trap can exclude pointerdowns on the anchor
  // from outside-click dismissal and so focus returns to the
  // anchor on close. Updated via the `onFocus` path inside
  // `<IrealBarGrid>`, which fires before `onOpenBar`.
  const popoverAnchorRef = useRef<HTMLElement | null>(null);

  const handleOpenBar = useCallback((secIndex: number, barIndex: number): void => {
    const active = (typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null);
    if (active !== null && active.classList?.contains('chordsketch-ireal-editor__bar')) {
      popoverAnchorRef.current = active;
    }
    setPopoverTarget({ secIndex, barIndex });
  }, []);

  const handlePopoverDismiss = useCallback((): void => {
    setPopoverTarget(null);
  }, []);

  const handlePopoverSave = useCallback(
    (secIndex: number, barIndex: number, next: IrealBar): void => {
      // Defense-in-depth: the popover trigger (bar-cell button) is
      // already disabled when the editor is read-only / errored, so
      // a Save dispatch on a disabled editor is structurally
      // unreachable. The guard makes the invariant locally
      // explicit at the receive side — symmetric with the `disabled
      // ||` short-circuits guarding the structural-ops `useMemo`.
      if (disabled || song === null) return;
      const section = song.sections[secIndex];
      if (!section) return;
      const bars = section.bars.map((b, i) => (i === barIndex ? next : b));
      const sections = song.sections.map((s, i) =>
        i === secIndex ? { ...s, bars } : s,
      );
      emit({ ...song, sections });
    },
    [disabled, song, emit],
  );

  // The popover edits the bar at `popoverTarget`. Looked up lazily
  // so a structural mutation that clamps `popoverTarget` (e.g. a
  // bar deletion while open) renders the popover against the
  // post-mutation bar at that index — or unmounts the popover if
  // the slot no longer exists.
  const popoverBar: IrealBar | null = useMemo(() => {
    if (popoverTarget === null || song === null) return null;
    const section = song.sections[popoverTarget.secIndex];
    if (!section) return null;
    return section.bars[popoverTarget.barIndex] ?? null;
  }, [popoverTarget, song]);

  // Dismiss the popover whenever its target bar no longer exists
  // (e.g. the section was deleted by a sibling structural op).
  useEffect(() => {
    if (popoverTarget !== null && popoverBar === null) {
      setPopoverTarget(null);
    }
  }, [popoverTarget, popoverBar]);

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
      {liveRegion}
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
          {showBars ? (
            <IrealBarGrid
              sections={song.sections}
              activeBar={activeBar}
              onActiveBarChange={setActiveBar}
              onOpenBar={handleOpenBar}
              ops={ops}
              disabled={disabled}
            />
          ) : null}
          {showBars && popoverTarget !== null && popoverBar !== null ? (
            <IrealBarPopover
              key={`${popoverTarget.secIndex}:${popoverTarget.barIndex}`}
              bar={popoverBar}
              anchorRef={popoverAnchorRef}
              onSave={(next) =>
                handlePopoverSave(popoverTarget.secIndex, popoverTarget.barIndex, next)
              }
              onDismiss={handlePopoverDismiss}
            />
          ) : null}
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

