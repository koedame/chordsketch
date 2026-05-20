import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { IrealBarGrid, type IrealBarGridLoader } from './ireal-bar-grid';
import { IrealPreview } from './ireal-preview';
import type { IrealRenderLoader } from './use-ireal-render';

// Minimal `process.env.NODE_ENV` typing so we do not pull in
// `@types/node` for a single dev-only reference. The exact
// `process.env.NODE_ENV` token is required — bundlers (esbuild,
// Rollup, Vite, webpack DefinePlugin) replace it at build time
// and a helper that accesses it via `globalThis.process` would
// not match the substitution pattern. Same pattern as
// `chord-textarea.tsx`'s `wasControlledRef` warning gate.
declare const process: { env: { NODE_ENV?: string } };

/**
 * Combined loader covering both the bar-grid editor's wasm surface
 * (`parseIrealb` + `serializeIrealb`) and the SVG preview's surface
 * (`renderIrealSvg`). A test stub providing all three methods
 * satisfies both child components with a single shared loader.
 *
 * The intersection is preferred over an `unknown`-cast at the call
 * site because TypeScript can verify the contract at the prop
 * boundary — a stub missing `renderIrealSvg` is now a compile error
 * rather than a runtime `undefined.call(...)`.
 *
 * @internal
 */
export type CombinedIrealLoader = () => Promise<
  Awaited<ReturnType<IrealBarGridLoader>> & Awaited<ReturnType<IrealRenderLoader>>
>;

export interface IrealProEditorProps {
  /**
   * Initial `irealb://` URL. The component manages the value
   * internally afterwards; pass {@link source} + {@link onChange}
   * to drive it externally instead.
   */
  defaultValue?: string;
  /** Controlled value. Pair with {@link onChange}. */
  source?: string;
  /** Controlled change callback. Pair with {@link source}. */
  onChange?: (url: string) => void;
  /** Read-only mode. */
  readOnly?: boolean;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** Optional inline style applied to the wrapper. */
  style?: CSSProperties;
  /**
   * Optional renderer for parse / render errors. Defaults to the
   * inline `role="alert"` fallback inside the child components.
   * Pass `null` to suppress error UI entirely.
   *
   * Shape mirrors {@link ChordProPreviewProps.errorFallback} —
   * function-only render prop or `null` — so the React surface
   * stays symmetric across the ChordPro and iReal Pro Tier-3
   * components.
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /** Hide the URL textarea inside the editor pane. Defaults to `false`. */
  hideUrl?: boolean;
  /** Hide the bar-grid summary inside the editor pane. Defaults to `false`. */
  hideBars?: boolean;
  /** Hide the SVG preview pane. Defaults to `false`. */
  hidePreview?: boolean;
  /** @internal Loader override for tests. Shared with the preview
   * pane via the structural {@link CombinedIrealLoader} intersection
   * — a single stub that declares `parseIrealb` + `serializeIrealb`
   * + `renderIrealSvg` + `default` satisfies both children at the
   * type level, removing the previous `unknown`-cast. */
  loader?: CombinedIrealLoader;
  /** @internal Loader override for the preview pane. Falls back
   * to `loader` when omitted so a single stub covers both panes. */
  previewLoader?: IrealRenderLoader;
}

/**
 * Tier 3 composed editor — high-level "drop-in" wrapper that
 * composes {@link IrealBarGrid} and {@link IrealPreview}. Hosts
 * that want a single-component embed analogous to the ChordPro
 * `<ChordProEditor>` use this; hosts that need to control layout
 * themselves should compose the two children directly.
 *
 * Supports both uncontrolled (`defaultValue`) and controlled
 * (`source` + `onChange`) modes; mixing the two is a configuration
 * error and the controlled props win.
 */
export function IrealProEditor({
  defaultValue = '',
  source,
  onChange,
  readOnly,
  className,
  style,
  errorFallback,
  hideUrl = false,
  hideBars = false,
  hidePreview = false,
  loader,
  previewLoader,
}: IrealProEditorProps): JSX.Element {
  const isControlled = source !== undefined;
  // Internal state is only used in uncontrolled mode. In controlled
  // mode the parent's `source` is the single source of truth, so we
  // initialise the state lazily and never write to it. The previous
  // implementation kept an unused `internalValue` synced from
  // `source` in controlled mode — dead state that confused readers
  // about which value the editor was actually rendering.
  const [internalValue, setInternalValue] = useState<string>(() =>
    isControlled ? '' : defaultValue,
  );

  // Dev-only warning if a caller flips the component between
  // controlled and uncontrolled mid-lifetime. Mirrors the
  // `wasControlledRef` pattern in `chord-textarea.tsx` so the
  // iReal Pro surface behaves consistently with the ChordPro
  // surface and React's built-in `<input>` / `<textarea>`.
  // Production builds strip the warning via bundler dead-code
  // elimination on the literal `process.env.NODE_ENV` token.
  const wasControlledRef = useRef(isControlled);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (wasControlledRef.current !== isControlled) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: A component is changing an ${wasControlledRef.current ? 'controlled' : 'uncontrolled'} <IrealProEditor> to be ${isControlled ? 'controlled' : 'uncontrolled'}. ` +
          `<IrealProEditor> should not switch between controlled and uncontrolled (or vice versa) during its lifetime. ` +
          `Decide between using a controlled or uncontrolled <IrealProEditor> for the lifetime of the component.`,
      );
      wasControlledRef.current = isControlled;
    }
  }, [isControlled]);

  const currentValue = isControlled ? (source as string) : internalValue;

  const handleChange = (url: string): void => {
    if (!isControlled) setInternalValue(url);
    if (onChange !== undefined) onChange(url);
  };

  const wrapperClass = ['chordsketch-ireal-pro-editor', className]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join(' ');

  return (
    <div className={wrapperClass} style={style}>
      <div className="chordsketch-ireal-pro-editor__editor">
        <IrealBarGrid
          source={currentValue}
          // `<IrealBarGrid>` already derives its read-only behaviour
          // from `onChange === undefined || readOnly`. Pass both
          // signals through directly — the previous code stripped
          // `onChange` to `undefined` in read-only mode, which
          // duplicated the invariant and made the data flow noisier
          // than the underlying contract. `handleChange` is a no-op
          // for the host when `readOnly` is set because
          // `<IrealBarGrid>` will not invoke it on disabled fields.
          onChange={handleChange}
          readOnly={readOnly}
          errorFallback={errorFallback}
          showUrl={!hideUrl}
          showBars={!hideBars}
          loader={loader}
        />
      </div>
      {hidePreview ? null : (
        <div className="chordsketch-ireal-pro-editor__preview">
          <IrealPreview
            source={currentValue}
            errorFallback={errorFallback}
            // The combined loader's intersection type guarantees
            // `renderIrealSvg` exists, so the preview's narrower
            // contract is satisfied without an `unknown`-cast.
            loader={previewLoader ?? loader}
          />
        </div>
      )}
    </div>
  );
}
