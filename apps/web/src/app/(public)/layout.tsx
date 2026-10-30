import { LogoMark } from '@/components/logo-mark';
import type { ReactNode } from 'react';
import { appName } from '@/config';
import { PhaseBanner } from '@/components/phase-banner';
import { Footer } from '@/components/footer';
import { PageGuide } from '@/components/page-guide';

/** Pages for people who are not signed in: the name, and nothing to navigate to. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <header className="header">
        <div className="header-primary">
          <div className="header-inner">
            <div className="header-brand-wrap">
            <LogoMark />
            <span className="header-name">{appName()}</span>
            </div>
          </div>
        </div>
      </header>
      <PhaseBanner phase="Secure sign-in">
        Use only the invitation or account issued to you by the practice.
      </PhaseBanner>
      <main id="main" className="main main-public">
        <PageGuide />
        {children}
      </main>
      <Footer />
    </div>
  );
}
