import type { ChangeEvent, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChordSheet } from './chord-sheet';
import type { ChordRenderFormat, ChordWasmLoader } from './use-chord-render';
import type { ChordproWasmLoader } from './use-chordpro-ast';
import { useDebounced } from './use-debounced';

// Minimal `process.env.NODE_ENV` typing so we do not pull in
// `@types/node` for a single dev-only reference. The exact
// `process.env.NODE_ENV` token is required — bundlers (esbuild,
// Rollup, Vite, webpack DefinePlugin) replace it at build time and
// a helper that accesses it via `globalThis.process` would not
// match the substitution pattern, so the production build would
// still carry the warning code path.
declare const process: { env: { NODE_ENV?: string } };

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
   * (`Ctrl` / `Cmd` + `ArrowUp` / `ArrowDown`). The component never
   * mutates `transpose` directly; wire this callback to your own
   * transpose state (e.g. from `useTranspose`) to respond.
   *
   * ### Keyboard note
   *
   * Registering this callback suppresses the browser's default
   * text-navigation for those key combinations inside the editor
   * textarea — in Firefox `Ctrl+ArrowUp/Down` normally move the
   * caret to the start/end of the paragraph. If you need the
   * browser default, omit `onTransposeChange` or wrap it with a
   * conditional that selectively skips `preventDefault()`.
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
   * Test-only WASM loader override forwarded to `<ChordSheet>`'s
   * text branch (`format="text"`). Production callers never need
   * to supply this.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
  /**
   * Test-only WASM loader override forwarded to `<ChordSheet>`'s
   * AST → JSX branch (`format="html"`, default). Production
   * callers never need to supply this.
   *
   * @internal
   */
  astWasmLoader?: ChordproWasmLoader;
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
  astWasmLoader,
  className,
  ...divProps
}: ChordEditorProps): JSX.Element {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<string>(isControlled ? value : defaultValue);
  const current = isControlled ? value : internal;
  const debounced = useDebounced(current, debounceMs);

  // Dev-only warning if a caller flips the component between
  // controlled and uncontrolled mid-lifetime. React's built-in
  // `<input>` / `<textarea>` emit the same warning; we mirror the
  // pattern so the `<ChordEditor>` surface behaves consistently.
  // Production builds strip the warning via bundler dead-code
  // elimination on the literal `process.env.NODE_ENV` token; the
  // inline check below matches what React itself uses.
  const wasControlledRef = useRef(isControlled);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (wasControlledRef.current !== isControlled) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: A component is changing an ${wasControlledRef.current ? 'controlled' : 'uncontrolled'} <ChordEditor> to be ${isControlled ? 'controlled' : 'uncontrolled'}. ` +
          `<ChordEditor> should not switch between controlled and uncontrolled (or vice versa) during its lifetime. ` +
          `Decide between using a controlled or uncontrolled <ChordEditor> for the lifetime of the component.`,
      );
      wasControlledRef.current = isControlled;
    }
  }, [isControlled]);

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
          astWasmLoader={astWasmLoader}
        />
      </div>
    </div>
  );
}
