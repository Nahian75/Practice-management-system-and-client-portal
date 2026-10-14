import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { appName } from '@/config';
import { apiGet, currentAccount } from '@/lib/api';
import type { NotificationPage } from '@/lib/notifications';
import type { ComplianceAccess } from '@/lib/compliance';
import { hasHrWorkspace, type HrAccess } from '@/lib/hr';
import { NavLinks } from '@/components/nav-links';
import { SignOutButton } from '@/components/sign-out-button';
import { PhaseBanner } from '@/components/phase-banner';
import { Footer } from '@/components/footer';

/**
 * Every staff page. Without a valid staff session the visitor is sent to sign
 * in; the API checks the session again on every call these pages make.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  if (account.kind !== 'staff') {
    redirect('/portal');
  }
  const [{ body: notifications }, finance, compliance, hr] = await Promise.all([
    apiGet<NotificationPage>('/notifications'),
    apiGet('/finance/access'),
    apiGet<ComplianceAccess>('/compliance/access'),
    apiGet<HrAccess>('/hr/access'),
  ]);

  return (
    <>
      <header className="header">
        <div className="header-primary">
          <div className="header-inner">
            <Link className="header-brand-wrap" href="/">
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
            <NavLinks
              unreadCount={notifications?.unreadCount ?? 0}
              canViewFinance={finance.status === 200}
              canViewCompliance={compliance.status === 200}
              complianceAttention={compliance.body?.attentionCount ?? 0}
              canViewHr={!!hr.body && hasHrWorkspace(hr.body)}
            />
          </div>
        </div>
      </header>
      <PhaseBanner />
      <main id="main" className="main">
        {children}
      </main>
      <Footer />
    </>
  );
}
