import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { IrealBarGrid, type IrealBarGridLoader } from './ireal-bar-grid';
import { IrealPreview } from './ireal-preview';
import type { IrealRenderLoader } from './use-ireal-render';

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
   */
  errorFallback?: ReactNode | ((error: Error) => ReactNode) | null;
  /** Hide the URL textarea inside the editor pane. Defaults to `false`. */
  hideUrl?: boolean;
  /** Hide the bar-grid summary inside the editor pane. Defaults to `false`. */
  hideBars?: boolean;
  /** Hide the SVG preview pane. Defaults to `false`. */
  hidePreview?: boolean;
  /** @internal Loader override for tests. Shared with the preview
   * pane (which only needs the `renderIrealSvg` shape); the
   * structural compatibility of `IrealBarGridWasm` (parse +
   * serialize + default) is a superset of `IrealRenderer`
   * (renderIrealSvg + default), so the editor stub can satisfy
   * the preview's narrower contract too as long as the test stub
   * declares `renderIrealSvg`. */
  loader?: IrealBarGridLoader;
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
  const [internalValue, setInternalValue] = useState<string>(defaultValue);

  // Sync the internal state when the parent flips from uncontrolled
  // to controlled mid-stream. The check guards against the
  // controlled-default-prop pattern where parents pass a stable
  // `defaultValue` that should NOT override later user edits.
  useEffect(() => {
    if (isControlled && source !== internalValue) {
      setInternalValue(source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const currentValue = isControlled ? source : internalValue;

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
          onChange={readOnly ? undefined : handleChange}
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
            loader={
              previewLoader ?? (loader as unknown as IrealRenderLoader | undefined)
            }
          />
        </div>
      )}
    </div>
  );
}
