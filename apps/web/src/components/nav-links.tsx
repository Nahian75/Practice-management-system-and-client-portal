'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/clients', label: 'Clients' },
  { href: '/matters', label: 'Matters' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/staff', label: 'Staff' },
] as const;

/** The main sections. The current one is marked for screen readers as well as by sight. */
export function NavLinks({ unreadCount }: { unreadCount: number }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="nav">
      <ul>
        {LINKS.map(({ href, label }) => {
          const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
          const notifications = href === '/notifications';
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                aria-label={notifications ? `Notifications, ${unreadCount} unread` : undefined}
              >
                {label}{notifications && ` (${unreadCount})`}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
