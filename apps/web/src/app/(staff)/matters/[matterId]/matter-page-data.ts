import { notFound, redirect } from 'next/navigation';
import { apiGet, currentAccount } from '@/lib/api';
import type { Matter } from '@/lib/matters';

/**
 * The matter for a page that changes it, and whether the person signed in is
 * its supervising partner. A matter they cannot see, or one that is closed,
 * has nothing to change: those pages go back to the matter page, which says why.
 */
export async function matterToChange(matterId: string): Promise<{ matter: Matter; isSupervisor: boolean; accountId: string }> {
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const { status, body: matter } = await apiGet<Matter>(`/matters/${encodeURIComponent(matterId)}`);
  if (status === 400) {
    notFound();
  }
  if (!matter || matter.status === 'closed') {
    redirect(`/matters/${encodeURIComponent(matterId)}`);
  }
  const isSupervisor = matter.team.some((member) => member.accountId === account.id && member.role === 'supervising_partner');
  return { matter, isSupervisor, accountId: account.id };
}
