'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/clients', label: 'Clients' },
] as const;

/** The main sections. The current one is marked for screen readers as well as by sight. */
export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="nav">
      <ul>
        {LINKS.map(({ href, label }) => {
          const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link href={href} aria-current={current ? 'page' : undefined}>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
