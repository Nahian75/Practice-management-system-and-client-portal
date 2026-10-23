import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HowTo } from '@/components/how-to';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { MATTER_STATUS_LABELS, MATTER_TYPE_LABELS, type MatterSummary } from '@/lib/matters';

export const metadata: Metadata = { title: 'Matters' };

export default async function MattersPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { before } = await searchParams;
  const { status, body } = await apiGet<{ matters: MatterSummary[]; next: string | null }>('/matters', {
    before: typeof before === 'string' ? before : undefined,
  });
  if (status === 403) {
    return (
      <>
        <NoAccess what="matters" />
        <p>
          Compliance can <Link href="/matters/compliance-access">look at a matter with a reason</Link>.
        </p>
      </>
    );
  }
  if (status === 400) {
    redirect('/matters');
  }

  const matters = body?.matters ?? [];
  return (
    <>
      <h1>Matters</h1>
      <p>To open a matter, go to the client&rsquo;s page.</p>
      <HowTo>
        <li>A matter is one piece of work for a client, such as a house purchase or a dispute.</li>
        <li>You see only the matters whose team you are on.</li>
        <li>Select a matter&rsquo;s title to add documents and tasks and to record time.</li>
        <li>To start a new matter, open the client and select &ldquo;Open a matter&rdquo;.</li>
      </HowTo>
      {matters.length === 0 ? (
        <p>You are on no matter team yet.</p>
      ) : (
        <table className="table">
          <caption className="secondary">Newest first. Only matters you are on the team of appear here.</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Title</th>
              <th scope="col">Client</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {matters.map((matter) => (
              <tr key={matter.id}>
                <td>{matter.reference}</td>
                <td>
                  <Link href={`/matters/${matter.id}`}>{matter.title}</Link>
                </td>
                <td>{matter.client.name}</td>
                <td>{MATTER_TYPE_LABELS[matter.matterType]}</td>
                <td>{MATTER_STATUS_LABELS[matter.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {body?.next && (
        <p>
          <Link href={`/matters?before=${encodeURIComponent(body.next)}`}>Older matters</Link>
        </p>
      )}

      <hr className="rule" />
      <h2>Matters you are not on the team of</h2>
      <ul>
        <li>
          Partners: <Link href="/matters/supervision-takeover">take over supervision</Link> from a supervising partner who
          can no longer act
        </li>
        <li>
          Compliance: <Link href="/matters/compliance-access">look at a matter with a reason</Link>
        </li>
      </ul>
    </>
  );
}
