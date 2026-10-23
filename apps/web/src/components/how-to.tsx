import type { ReactNode } from 'react';

/** Plain-language steps for using the current page, closed until the reader opens it. */
export function HowTo({ children }: { children: ReactNode }) {
  return (
    <details className="notice how-to">
      <summary>How to use this page</summary>
      <ol>{children}</ol>
    </details>
  );
}
