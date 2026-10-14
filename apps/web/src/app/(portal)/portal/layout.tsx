import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/sign-out-button';
import { appName } from '@/config';
import { currentAccount } from '@/lib/api';
import { PhaseBanner } from '@/components/phase-banner';
import { Footer } from '@/components/footer';

/** The client side of the app, kept separate from every staff route. */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  if (account.kind !== 'client') {
    redirect('/');
  }

  return (
    <>
      <header className="header">
        <div className="header-primary">
          <div className="header-inner">
            <Link className="header-brand-wrap" href="/portal">
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
              <span className="header-product">Client portal</span>
            </Link>
            <div className="header-actions">
              <div className="header-user-tag">
                <span className="header-user-label">Signed in as</span>
                <strong>{account.displayName}</strong>
              </div>
              <SignOutButton />
            </div>
          </div>
        </div>
        <div className="header-nav-shell">
          <div className="header-nav-inner">
            <nav aria-label="Main" className="nav">
              <ul>
                <li>
                  <Link href="/portal" aria-current="page">
                    Your matters
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
        </div>
      </header>
      <PhaseBanner phase="Secure client portal">
        Only matters and documents deliberately shared with your portal account are shown here.
      </PhaseBanner>
      <main id="main" className="main">
        {children}
      </main>
      <Footer />
    </>
  );
}
