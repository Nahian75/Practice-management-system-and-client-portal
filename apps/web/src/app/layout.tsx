import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { appName } from '@/config';
import './globals.css';
import './interface.css';
import './dashboard.css';
import './sign-in.css';
import './manage.css';
import './reference-theme.css';
import './ai-workspaces.css';

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
    <html lang="en-GB">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
