import type { ReactNode } from 'react';
import { appName } from '@/config';

/** Pages for people who are not signed in: the name, and nothing to navigate to. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="header">
        <div className="header-inner">
          <span className="header-name">{appName()}</span>
        </div>
      </header>
      <main id="main" className="main">
        {children}
      </main>
    </>
  );
}
