import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { appName } from '@/config';
import { apiGet, currentAccount } from '@/lib/api';
import type { NotificationPage } from '@/lib/notifications';
import { NavLinks } from '@/components/nav-links';
import { SignOutButton } from '@/components/sign-out-button';

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
  const [{ body: notifications }, finance] = await Promise.all([
    apiGet<NotificationPage>('/notifications'), apiGet('/finance/access'),
  ]);

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <Link className="header-name" href="/">
            {appName()}
          </Link>
          <NavLinks unreadCount={notifications?.unreadCount ?? 0} canViewFinance={finance.status === 200} />
          <span>{account.displayName}</span>
          <SignOutButton />
        </div>
      </header>
      <main id="main" className="main">
        {children}
      </main>
    </>
  );
}
