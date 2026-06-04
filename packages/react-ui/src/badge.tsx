import * as React from 'react';

export type BadgeVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'crimson'
  | 'muted'
  | 'key'
  | 'key-crimson'
  | 'format';

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  crimson: 'crimson',
  muted: 'muted',
  key: 'key',
  'key-crimson': 'key crimson-fill',
  format: 'format',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Show a leading status dot (`.dot`). */
  dot?: boolean;
}

/**
 * Design-system badge primitive (`design-system/DESIGN.md` §6) — status,
 * key, and format badges from `components-badges.html`.
 */
export function Badge({
  variant,
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps): React.ReactElement {
  const cls = ['badge', variant ? VARIANT_CLASS[variant] : '', dot ? 'dot' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Filled (inverted) pill (`.pill.solid`). */
  solid?: boolean;
}

/** Genre pill primitive (`design-system/DESIGN.md` §6). */
export function Pill({ solid = false, className, children, ...rest }: PillProps): React.ReactElement {
  const cls = ['pill', solid ? 'solid' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
