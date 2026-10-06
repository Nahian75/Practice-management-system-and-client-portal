import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { appName } from '@/config';
import { currentAccount } from '@/lib/api';
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

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <Link className="header-name" href="/">
            {appName()}
          </Link>
          <NavLinks />
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
