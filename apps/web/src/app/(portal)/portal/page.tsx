import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { MATTER_STATUS_LABELS, MATTER_TYPE_LABELS, TEAM_ROLE_LABELS } from '@/lib/matters';
import type { PortalMatter } from '@/lib/portal';

export const metadata: Metadata = { title: 'Your matters' };

export default async function PortalMattersPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { before } = await searchParams;
  const result = await apiGet<{ matters: PortalMatter[]; next: string | null }>('/portal/matters', {
    before: typeof before === 'string' ? before : undefined,
  });
  if (result.status === 401) {
    redirect('/sign-in');
  }
  if (result.status === 403) {
    redirect('/');
  }
  if (result.status === 400) {
    redirect('/portal');
  }
  if (!result.body) {
    throw new Error('The client matter list could not be loaded');
  }

  return (
    <>
      <h1>Your matters</h1>
      <p>Open and closed matters the firm has made available to you.</p>
      {result.body.matters.length === 0 ? (
        <p>You have no matters to view.</p>
      ) : (
        <table className="table">
          <caption className="secondary">Newest first.</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Title</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Opened</th>
              <th scope="col">Your legal team</th>
            </tr>
          </thead>
          <tbody>
            {result.body.matters.map((matter) => (
              <tr key={matter.id}>
                <td>{matter.reference}</td>
                <td>
                  <Link href={`/portal/matters/${matter.id}`}>{matter.title}</Link>
                </td>
                <td>{MATTER_TYPE_LABELS[matter.matterType]}</td>
                <td>{MATTER_STATUS_LABELS[matter.status]}</td>
                <td>{formatDate(matter.openedAt)}</td>
                <td>
                  {matter.team.map((member, index) => (
                    <span key={`${member.role}-${index}`}>
                      {index > 0 && <br />}
                      {member.displayName} <span className="secondary">({TEAM_ROLE_LABELS[member.role].toLowerCase()})</span>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.body.next && (
        <p>
          <Link href={`/portal?before=${encodeURIComponent(result.body.next)}`}>Older matters</Link>
        </p>
      )}
    </>
  );
}
