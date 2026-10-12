'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/clients', label: 'Clients' },
  { href: '/matters', label: 'Matters' },
  { href: '/people', label: 'People' },
  { href: '/hr', label: 'HR workspace' },
  { href: '/finance', label: 'Finance' },
  { href: '/compliance', label: 'Compliance' },
  { href: '/report-concern', label: 'Report a concern' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/staff', label: 'Staff' },
] as const;

/** The main sections. The current one is marked for screen readers as well as by sight. */
export function NavLinks({ unreadCount, canViewFinance, canViewCompliance, complianceAttention, canViewHr }:
  { unreadCount: number; canViewFinance: boolean; canViewCompliance: boolean; complianceAttention: number;
    canViewHr: boolean }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="nav">
      <ul>
        {LINKS.filter(({ href }) => (href !== '/finance' || canViewFinance) &&
          (href !== '/compliance' || canViewCompliance) && (href !== '/hr' || canViewHr)).map(({ href, label }) => {
          const current = href === '/' ? pathname === '/' : pathname.startsWith(href);
          const notifications = href === '/notifications';
          const compliance = href === '/compliance';
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                aria-label={notifications ? `Notifications, ${unreadCount} unread` :
                  compliance ? `Compliance, ${complianceAttention} ordinary actions require attention` : undefined}
              >
                {label}{notifications && ` (${unreadCount})`}{compliance && complianceAttention > 0 && ` (${complianceAttention})`}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
