import type { ReactNode } from 'react';
import { appName } from '@/config';
import { PhaseBanner } from '@/components/phase-banner';
import { Footer } from '@/components/footer';

/** Pages for people who are not signed in: the name, and nothing to navigate to. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="header">
        <div className="header-inner">
          <div className="header-brand-wrap">
            <span className="header-crest" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v18" />
                <path d="M6 7h12" />
                <path d="M4 14l2-7 2 7a2 2 0 0 1-4 0z" />
                <path d="M16 14l2-7 2 7a2 2 0 0 1-4 0z" />
                <path d="M4 21h16" />
              </svg>
            </span>
            <span className="header-name">{appName()}</span>
          </div>
        </div>
      </header>
      <PhaseBanner phase="SECURE SIGN-IN">
        Use only the invitation or account issued to you by the practice.
      </PhaseBanner>
      <main id="main" className="main">
        {children}
      </main>
      <Footer />
    </>
  );
}
