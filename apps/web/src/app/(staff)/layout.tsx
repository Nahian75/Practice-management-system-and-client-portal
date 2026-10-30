import { LogoMark } from '@/components/logo-mark';
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
import { WorkspaceToolbar } from '@/components/workspace-toolbar';
import { Footer } from '@/components/footer';
import { PageGuide } from '@/components/page-guide';
import {SidebarCollapse} from '@/components/sidebar-collapse';

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
  const [{ body: notifications }, finance, compliance, hr, work] = await Promise.all([
    apiGet<NotificationPage>('/notifications'),
    apiGet('/finance/access'),
    apiGet<ComplianceAccess>('/compliance/access'),
    apiGet<HrAccess>('/hr/access'),
    apiGet('/workspace/tasks'),
  ]);

  return (
    <div className="staff-shell manage-shell">
      <aside className="header workspace-sidebar" aria-label="Workspace navigation">
        <div className="header-primary">
          <div className="header-inner">
            <Link className="header-brand-wrap" href="/">
              <LogoMark />
              <span className="header-name">{appName()}</span>
              <span className="header-product">Practice management</span>
            </Link>
            <div className="header-actions">
              <div className="header-user-tag">
                <span className="header-user-label">Signed in as</span>
                <strong>{account.displayName}</strong>
              </div>
              <SignOutButton />
              <SidebarCollapse/>
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
              canViewWork={work.status===200}
            />
          </div>
        </div>
      </aside>
      <WorkspaceToolbar name={account.displayName} accountId={account.id} unread={notifications?.unreadCount??0} canViewWork={work.status===200}/>
      <main id="main" className="main">
        <PageGuide />
        {children}
      </main>
      <Footer />
    </div>
  );
}
