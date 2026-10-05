import type { Metadata } from 'next';
import { Source_Sans_3, Source_Serif_4 } from 'next/font/google';
import type { ReactNode } from 'react';
import { appName } from '@/config';
import './globals.css';

// Downloaded when the app is built and served from this site: no request to
// Google, or anyone else, when a page is viewed.
const serif = Source_Serif_4({ subsets: ['latin'], variable: '--font-serif', display: 'swap' });
const sans = Source_Sans_3({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

// Every page is rendered per request: each needs its own nonce for the
// Content Security Policy, and nothing signed-in may be cached.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  const name = appName();
  return {
    title: { default: name, template: `%s – ${name}` },
    // Staff pages are never for search engines.
    robots: { index: false, follow: false },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
