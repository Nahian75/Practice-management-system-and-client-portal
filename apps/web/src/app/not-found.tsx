import type { Metadata } from 'next';
import Link from 'next/link';
import { appName } from '@/config';

export const metadata: Metadata = { title: 'Page not found' };

/** For an address with no page, and for pages that call notFound(), such as a malformed id. */
export default function NotFound() {
  return (
    <>
      <header className="header">
        <div className="header-inner">
          <Link className="header-name" href="/">
            {appName()}
          </Link>
        </div>
      </header>
      <main id="main" className="main">
        <h1>Page not found</h1>
        <p>If you typed the web address, check it is correct. If you followed a link, it may be out of date.</p>
        <p>
          <Link href="/">Go to the home page</Link>
        </p>
      </main>
    </>
  );
}
