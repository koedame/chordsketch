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

// Anchor-only attributes (href, target, download, …) that do not exist on a
// <button>. Forbidden on the button arm below so they cannot silently land on
// a <button> when `as` is omitted — closing the TypeScript union
// excess-property gap (microsoft/TypeScript#14094) at the type level.
type AnchorOnlyProps = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  keyof React.ButtonHTMLAttributes<HTMLButtonElement>
>;

export type ButtonProps =
  | (ButtonBaseProps & { as?: 'button' } & React.ButtonHTMLAttributes<HTMLButtonElement> & {
      [K in keyof AnchorOnlyProps]?: never;
    })
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
 * default, or an `<a>` when `as="a"` (for link-styled actions). Anchor
 * attributes such as `href` require `as="a"` (a type error on the button
 * form). When `as="a"` and `isLoading`, navigation is suppressed and the
 * link is marked `aria-disabled`.
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
      onClick,
      ...anchorProps
    } = props;
    return (
      // A loading link is non-interactive: `aria-disabled` communicates that to
      // assistive tech, and the handler suppresses navigation (an <a> has no
      // native `disabled`).
      <a
        className={cls}
        aria-busy={isLoading || undefined}
        aria-disabled={isLoading || undefined}
        onClick={isLoading ? (event) => event.preventDefault() : onClick}
        {...anchorProps}
      >
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
