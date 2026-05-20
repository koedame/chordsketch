/**
 * Desktop wrapper that hosts the imperative bar-grid editor from
 * `@chordsketch/ui-irealb-editor` (`createIrealbEditor`) inside a
 * React component. The desktop continues to depend on
 * `@chordsketch/ui-irealb-editor` — the package is staying and is
 * the source of truth for the bar-grid GUI today; this wrapper is
 * the seam that lets the imperative adapter live inside `<App />`'s
 * React tree.
 *
 * The bar-grid editor is paired with `<IrealPreview>` from
 * `@chordsketch/react` for the SVG chart pane in `App.tsx`; this
 * component owns only the editor half of the pair.
 *
 * Programmatic `value`-prop updates from the parent dispatch
 * through the adapter's `setValue`, which per the
 * `@chordsketch/ui-irealb-editor` contract does NOT fire the
 * adapter's onChange — matching React controlled-input semantics.
 *
 * ## Failure containment
 *
 * `createIrealbEditor({ initialValue })` calls `parseIrealb(initialValue)`
 * synchronously and throws on malformed input; `adapter.setValue(next)`
 * does the same on update. The upstream `<App />` already gates the grid
 * mode behind a `canParseAsIrealbUrl(value)` check, so the throw is
 * structurally unreachable in production — but a future code path
 * (Tauri command, HMR edge case, direct `desktopBridge.setMode('irealb-grid')`)
 * could violate that invariant and bubble the throw up through React's
 * commit phase, blanking the entire window.
 *
 * Both the mount call and the controlled-mode `setValue` sync are
 * wrapped in try/catch; on failure the wrapper renders an inline
 * `role="alert"` fallback (or the caller-supplied `fallback` render
 * prop) that points the user at the "Edit as URL Text" view as the
 * recovery path. The previously-mounted adapter, if any, stays in the
 * tree so the user does not lose ongoing work on a transient setValue
 * failure.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { createIrealbEditor } from '@chordsketch/ui-irealb-editor';
import { parseIrealb, serializeIrealb } from '@chordsketch/wasm';

/** Imperative handle exposed via `ref`. */
export interface IrealGridEditorHandle {
  /** Move keyboard focus into the editor. */
  focus(): void;
  /** Read the current `irealb://` URL. */
  getValue(): string;
}

export interface IrealGridEditorProps {
  /** Controlled `irealb://` URL. Pair with `onChange`. */
  value: string;
  /** Fires synchronously on every user-initiated edit. Programmatic
   * `value`-prop updates do NOT fire this handler. */
  onChange?: (next: string) => void;
  /** className applied to the wrapper `<div>`. */
  className?: string;
  /**
   * Optional render prop that takes over when the bar-grid adapter
   * cannot mount or sync (e.g. malformed `irealb://` URL slipping
   * past the upstream `canParseAsIrealbUrl` gate). Receives the
   * `Error` thrown by the adapter. When omitted, the wrapper
   * renders a default inline `role="alert"` with a hint pointing
   * at the "Edit as URL Text" recovery view.
   */
  fallback?: (error: Error) => ReactNode;
}

const DEFAULT_FALLBACK_HINT =
  "Switch to 'Edit as URL Text' (View menu) to edit the raw URL.";

function renderDefaultFallback(error: Error): ReactNode {
  return (
    <div
      role="alert"
      className="chordsketch-ireal-grid-host__error"
    >
      <p className="chordsketch-ireal-grid-host__error-message">
        {error.message}
      </p>
      <p className="chordsketch-ireal-grid-host__error-hint">
        {DEFAULT_FALLBACK_HINT}
      </p>
    </div>
  );
}

export const IrealGridEditor = forwardRef<
  IrealGridEditorHandle,
  IrealGridEditorProps
>(function IrealGridEditor({ value, onChange, className, fallback }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  // `adapter` is the underlying `EditorAdapter` from
  // `createIrealbEditor`. Kept on a ref so it survives re-renders.
  const adapterRef = useRef<ReturnType<typeof createIrealbEditor> | null>(null);
  const onChangeRef = useRef(onChange);
  // Mount / sync failure surfaced via the `fallback` render prop. We
  // hold the error in state rather than throwing so React's commit
  // phase completes — an uncaught throw here blanks the entire
  // window because `<App />` does not wrap the editor pane in an
  // error boundary.
  const [mountError, setMountError] = useState<Error | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Mount the imperative adapter once on first render. Subsequent
  // prop changes (`value`) flow through the synchronisation effect
  // below; the adapter has no other tunable inputs that justify a
  // remount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let adapter: ReturnType<typeof createIrealbEditor>;
    try {
      adapter = createIrealbEditor({
        initialValue: value,
        wasm: { parseIrealb, serializeIrealb },
      });
    } catch (e) {
      // `parseIrealb` (called from `createIrealbEditor` for non-empty
      // input) threw on the initial URL. Surface the error via the
      // fallback render path — letting the throw propagate would
      // blank the window because there is no enclosing error
      // boundary.
      setMountError(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    adapterRef.current = adapter;
    host.appendChild(adapter.element);

    const unsubscribe = adapter.onChange((next) => {
      onChangeRef.current?.(next);
    });

    return () => {
      unsubscribe();
      adapter.destroy();
      if (adapterRef.current === adapter) adapterRef.current = null;
      // The adapter destroys its own DOM via `destroy()`; the
      // element is also explicitly removed from the host so a
      // future React render starts with an empty container.
      if (adapter.element.parentNode === host) {
        host.removeChild(adapter.element);
      }
    };
    // We intentionally mount once and use `setValue` for updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled-mode value synchronisation. Skips when the adapter's
  // current value already matches.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    const current = adapter.getValue();
    if (current === value) return;
    try {
      adapter.setValue(value);
    } catch (e) {
      // `setValue` re-parses the URL and throws on malformed input.
      // Surface via the fallback path — the previously-mounted
      // adapter stays in the tree until the next mount cycle, so
      // ongoing work is not lost on a transient setValue failure.
      setMountError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        adapterRef.current?.focus?.();
      },
      getValue() {
        return adapterRef.current?.getValue() ?? '';
      },
    }),
    [],
  );

  const wrapperClass = ['chordsketch-ireal-grid-host', className]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join(' ');

  if (mountError !== null) {
    return (
      <div className={wrapperClass}>
        {fallback !== undefined
          ? fallback(mountError)
          : renderDefaultFallback(mountError)}
      </div>
    );
  }

  return <div ref={hostRef} className={wrapperClass} />;
});
