import type { ReactNode } from 'react';

export type TagVariant = 'green' | 'blue' | 'yellow' | 'amber' | 'red' | 'grey' | 'purple';

export function StatusTag({
  variant = 'blue',
  children,
}: {
  variant?: TagVariant;
  children: ReactNode;
}) {
  const variantClass = variant === 'amber' ? 'tag-yellow' : `tag-${variant}`;
  return <span className={`tag ${variantClass}`}>{children}</span>;
}
