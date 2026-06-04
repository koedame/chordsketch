import * as React from 'react';

export type CardVariant = 'song' | 'setlist' | 'featured';

const VARIANT_CLASS: Record<CardVariant, string> = {
  song: 'song-card',
  setlist: 'setlist',
  featured: 'featured-card',
};

export type CardProps = React.HTMLAttributes<HTMLElement> &
  (
    | {
        variant?: 'song';
        /** Apply the crimson accent border. Only valid on the `song` variant. */
        featured?: boolean;
      }
    | { variant: 'setlist' | 'featured'; featured?: never }
  );

/**
 * Design-system card container (`design-system/DESIGN.md` §6). Renders an
 * `<article>` with the canonical card class for the chosen variant; the
 * inner structure (`.artist`, `.meta`, `.footer`, `.stats`, …) is composed
 * by the caller per the design-system markup. `featured` is accepted only on
 * the `song` variant (a type error on `setlist` / `featured`).
 */
export function Card({
  variant = 'song',
  featured = false,
  className,
  children,
  ...rest
}: CardProps): React.ReactElement {
  const cls = [
    VARIANT_CLASS[variant],
    variant === 'song' && featured ? 'featured' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article className={cls} {...rest}>
      {children}
    </article>
  );
}
