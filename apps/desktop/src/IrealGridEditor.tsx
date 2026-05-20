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
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
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
}

export const IrealGridEditor = forwardRef<
  IrealGridEditorHandle,
  IrealGridEditorProps
>(function IrealGridEditor({ value, onChange, className }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  // `adapter` is the underlying `EditorAdapter` from
  // `createIrealbEditor`. Kept on a ref so it survives re-renders.
  const adapterRef = useRef<ReturnType<typeof createIrealbEditor> | null>(null);
  const onChangeRef = useRef(onChange);

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

    const adapter = createIrealbEditor({
      initialValue: value,
      wasm: { parseIrealb, serializeIrealb },
    });
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
    adapter.setValue(value);
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

  return <div ref={hostRef} className={wrapperClass} />;
});
