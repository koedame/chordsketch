import type { ChangeEvent, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';

import { ChordSheet } from './chord-sheet';
import type { ChordRenderFormat, ChordWasmLoader } from './use-chord-render';
import { useDebounced } from './use-debounced';

/** Props accepted by {@link ChordEditor}. */
export interface ChordEditorProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /**
   * Controlled value. When set, the component does not manage its
   * own internal state — update `value` from the parent on every
   * `onChange` firing.
   */
  value?: string;
  /**
   * Initial value for uncontrolled usage. Ignored when `value` is
   * supplied. Defaults to the empty string.
   */
  defaultValue?: string;
  /**
   * Fires on every keystroke with the new editor contents. In
   * uncontrolled mode the component still manages its own state
   * internally; this callback is how the host observes edits.
   */
  onChange?: (value: string) => void;
  /**
   * Semitone transposition offset forwarded to the preview pane.
   * The editor text itself is never transposed — this affects
   * only how the preview renders the source.
   */
  transpose?: number;
  /**
   * Fires when the user hits the transpose keyboard shortcut
   * (Ctrl / Cmd + Up / Down). The component never mutates
   * `transpose` directly; wire this callback to your own
   * transpose state (e.g. from `useTranspose`) to respond.
   */
  onTransposeChange?: (next: number) => void;
  /** Configuration preset name or inline RRJSON forwarded to the preview. */
  config?: string;
  /** Preview render format. Defaults to `"html"`. See `<ChordSheet>`. */
  previewFormat?: ChordRenderFormat;
  /** Disables editing and focuses the preview as the primary surface. */
  readOnly?: boolean;
  /**
   * Debounce window in milliseconds for the preview re-render.
   * Defaults to `250` ms. Set to `0` to re-render synchronously
   * on every keystroke (useful for tests).
   */
  debounceMs?: number;
  /** Placeholder shown when the editor is empty. */
  placeholder?: string;
  /**
   * Accessible name forwarded to the editor textarea as
   * `aria-label`. Defaults to `"ChordPro editor"`. Placeholders
   * are not accessible names per WAI-ARIA 1.2 §5.2.8, so the
   * default is applied even when {@link placeholder} is supplied.
   * Override when the editor sits next to a visible `<label>`.
   */
  textareaAriaLabel?: string;
  /**
   * Optional content rendered while the preview's WASM module
   * initialises or re-renders. Forwarded to the internal
   * `<ChordSheet loadingFallback>`.
   */
  loadingFallback?: ReactNode;
  /**
   * Optional error render prop / null forwarded to the internal
   * `<ChordSheet errorFallback>`. Defaults to the component's own
   * inline `role="alert"` fallback.
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /** Minimum transpose offset the keyboard shortcuts will emit. Defaults to `-11`. */
  minTranspose?: number;
  /** Maximum transpose offset the keyboard shortcuts will emit. Defaults to `11`. */
  maxTranspose?: number;
  /**
   * Test-only WASM loader override forwarded to `<ChordSheet>`.
   * Production callers never need to supply this.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
}

/**
 * Split-pane editor + live preview. The editor is a plain
 * `<textarea>` deliberately — richer surfaces (syntax highlighting
 * via tree-sitter-chordpro or CodeMirror) can be layered on top
 * without changing this component's contract, because the public
 * API only promises a controlled / uncontrolled string value and
 * an onChange callback. The preview re-renders a debounced copy
 * of the source via `<ChordSheet>`, so typing does not stall the
 * UI.
 *
 * Supports controlled mode (`value` + `onChange`) and
 * uncontrolled mode (`defaultValue`). Keyboard shortcuts
 * `Ctrl+ArrowUp` / `Cmd+ArrowUp` / `Ctrl+ArrowDown` /
 * `Cmd+ArrowDown` fire `onTransposeChange` with the next value
 * clamped into `[minTranspose, maxTranspose]`, so a consumer can
 * bind the component directly to `useTranspose()`.
 */
export function ChordEditor({
  value,
  defaultValue = '',
  onChange,
  transpose = 0,
  onTransposeChange,
  config,
  previewFormat = 'html',
  readOnly = false,
  debounceMs = 250,
  placeholder = 'Enter ChordPro source here…',
  textareaAriaLabel = 'ChordPro editor',
  loadingFallback,
  errorFallback,
  minTranspose = -11,
  maxTranspose = 11,
  wasmLoader,
  className,
  ...divProps
}: ChordEditorProps): JSX.Element {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<string>(isControlled ? value : defaultValue);
  const current = isControlled ? value : internal;
  const debounced = useDebounced(current, debounceMs);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      const next = event.target.value;
      if (!isControlled) {
        setInternal(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const clampedTranspose = useMemo(() => {
    if (transpose < minTranspose) return minTranspose;
    if (transpose > maxTranspose) return maxTranspose;
    return transpose;
  }, [transpose, minTranspose, maxTranspose]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (onTransposeChange === undefined) return;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const next = Math.min(maxTranspose, clampedTranspose + 1);
        if (next !== clampedTranspose) {
          onTransposeChange(next);
        }
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = Math.max(minTranspose, clampedTranspose - 1);
        if (next !== clampedTranspose) {
          onTransposeChange(next);
        }
      }
    },
    [clampedTranspose, maxTranspose, minTranspose, onTransposeChange],
  );

  const wrapperClass = ['chordsketch-editor', className].filter(Boolean).join(' ');

  return (
    <div {...divProps} className={wrapperClass}>
      <textarea
        className="chordsketch-editor__textarea"
        value={current}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-label={textareaAriaLabel}
        spellCheck={false}
        // `autoComplete=off` and disabling form-assist attributes
        // stop browser UI (spell-check underlines, auto-capitalise,
        // autocorrect prompts) from interfering with ChordPro source
        // — almost every token in a ChordPro file is either a chord
        // shorthand or a directive name that fails every English
        // dictionary check.
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
      />
      <div className="chordsketch-editor__preview">
        <ChordSheet
          source={debounced}
          transpose={clampedTranspose}
          config={config}
          format={previewFormat}
          loadingFallback={loadingFallback}
          errorFallback={errorFallback}
          wasmLoader={wasmLoader}
        />
      </div>
    </div>
  );
}
