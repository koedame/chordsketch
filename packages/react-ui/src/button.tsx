import * as React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonBaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render a square icon-only button (`.btn-icon`); pass an `aria-label`. */
  iconOnly?: boolean;
  /** Show a leading spinner; keep `children` as the accessible label. */
  isLoading?: boolean;
}

export type ButtonProps =
  | (ButtonBaseProps & { as?: 'button' } & React.ButtonHTMLAttributes<HTMLButtonElement>)
  | (ButtonBaseProps & { as: 'a' } & React.AnchorHTMLAttributes<HTMLAnchorElement>);

function buttonClassName(
  variant: ButtonVariant,
  size: ButtonSize,
  iconOnly: boolean,
  className: string | undefined,
): string {
  return ['btn', `btn-${variant}`, `btn-${size}`, iconOnly ? 'btn-icon' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
}

/**
 * Design-system button primitive. Composes the canonical `.btn` class
 * vocabulary from `design-system/DESIGN.md` §6. Renders a `<button>` by
 * default, or an `<a>` when `as="a"` (for link-styled actions).
 */
export function Button(props: ButtonProps): React.ReactElement {
  const { variant = 'secondary', size = 'md', iconOnly = false, isLoading = false } = props;
  const cls = buttonClassName(variant, size, iconOnly, props.className);
  const content = (
    <>
      {isLoading ? <span className="spinner" aria-hidden="true" /> : null}
      {props.children}
    </>
  );

  if (props.as === 'a') {
    const {
      variant: _variant,
      size: _size,
      iconOnly: _iconOnly,
      isLoading: _isLoading,
      as: _as,
      className: _className,
      children: _children,
      ...anchorProps
    } = props;
    return (
      <a className={cls} aria-busy={isLoading || undefined} {...anchorProps}>
        {content}
      </a>
    );
  }

  const {
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    isLoading: _isLoading,
    as: _as,
    className: _className,
    children: _children,
    // Destructure `type` so it does not leak into the spread (undefined would
    // override the "button" default when the caller omits it entirely).
    type,
    ...buttonProps
  } = props;
  return (
    // Default type="button" prevents accidental form submission when <Button> is
    // rendered inside a <form> without an explicit type prop.
    <button
      type={type ?? 'button'}
      aria-busy={isLoading || undefined}
      className={cls}
      {...buttonProps}
    >
      {content}
    </button>
  );
}
