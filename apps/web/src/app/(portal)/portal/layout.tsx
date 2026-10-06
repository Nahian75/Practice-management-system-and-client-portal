import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/sign-out-button';
import { appName } from '@/config';
import { currentAccount } from '@/lib/api';

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
        <div className="header-inner">
          <Link className="header-name" href="/portal">
            {appName()}
          </Link>
          <span>Client portal</span>
          <nav aria-label="Main" className="nav">
            <ul>
              <li>
                <Link href="/portal" aria-current="page">
                  Your matters
                </Link>
              </li>
            </ul>
          </nav>
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
