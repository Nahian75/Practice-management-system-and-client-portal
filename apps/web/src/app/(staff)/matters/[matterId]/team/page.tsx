import type { Metadata } from 'next';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { Colleague } from '@/lib/matters';
import { matterToChange } from '../matter-page-data';
import { TeamChanges } from './team-changes';

export const metadata: Metadata = { title: 'Change the team' };

export default async function MatterTeamPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matter, isSupervisor, accountId } = await matterToChange((await params).matterId);
  const colleagues = isSupervisor ? await apiGet<{ colleagues: Colleague[] }>('/colleagues') : undefined;

  return (
    <>
      <p>
        <Link href={`/matters/${matter.id}`}>Back to the matter</Link>
      </p>
      <span className="caption">{matter.reference}</span>
      <h1>Change the team</h1>
      {!isSupervisor ? (
        <p>Only the matter&rsquo;s supervising partner can change its team.</p>
      ) : colleagues?.body ? (
        <TeamChanges matter={matter} colleagues={colleagues.body.colleagues} accountId={accountId} />
      ) : (
        <p>The list of colleagues could not be loaded. Reload the page to try again.</p>
      )}
    </>
  );
}
