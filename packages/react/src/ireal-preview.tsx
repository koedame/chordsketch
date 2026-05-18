import { useMemo, type CSSProperties, type ReactNode } from 'react';

import { useIrealRender, type IrealRenderLoader } from './use-ireal-render';

export interface IrealPreviewProps {
  /** `irealb://` URL to render. */
  source: string;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** Optional inline style applied to the wrapper. */
  style?: CSSProperties;
  /**
   * Optional renderer for parse / render errors. Defaults to an
   * inline `role="alert"`. Pass `null` to suppress entirely and
   * keep the last successful SVG visible without overlay.
   */
  errorFallback?: ReactNode | ((error: Error) => ReactNode) | null;
  /**
   * Optional loader override. Tests inject a structurally-compatible
   * stub. Production callers should leave the default.
   * @internal
   */
  loader?: IrealRenderLoader;
}

/**
 * Render an `irealb://` URL as inline SVG via
 * `@chordsketch/wasm`'s `renderIrealSvg`. The SVG output is fully
 * server-controlled (Rust renderer) and injected via
 * `dangerouslySetInnerHTML`; consumers passing untrusted iReal Pro
 * URLs should review the
 * [renderer's SMuFL glyph + path output](https://github.com/koedame/chordsketch/tree/main/crates/render-ireal)
 * for confidence that the strings cannot escape the SVG container.
 *
 * The component is intentionally narrow: it does not embed pan / zoom
 * controls or wire up click handlers. Hosts that need those can wrap
 * `<IrealPreview>` or use `useIrealRender` directly and place the SVG
 * inside their own container.
 */
export function IrealPreview({
  source,
  className,
  style,
  errorFallback,
  loader,
}: IrealPreviewProps): JSX.Element {
  const { svg, loading, error } = useIrealRender(source, loader);

  const errorNode = useMemo<ReactNode>(() => {
    if (error === null) return null;
    if (errorFallback === null) return null;
    if (errorFallback === undefined) {
      return (
        <p className="chordsketch-ireal-preview__error" role="alert">
          {error.message}
        </p>
      );
    }
    if (typeof errorFallback === 'function') {
      return errorFallback(error);
    }
    return errorFallback;
  }, [error, errorFallback]);

  const wrapperClass = ['chordsketch-ireal-preview', className]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .join(' ');

  return (
    <div
      className={wrapperClass}
      style={style}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
    >
      {errorNode}
      {svg === null ? null : (
        <div
          className="chordsketch-ireal-preview__svg"
          // The SVG is produced by the trusted Rust renderer; no host
          // input flows into the markup beyond the structured chord /
          // metadata fields the renderer already escapes.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
