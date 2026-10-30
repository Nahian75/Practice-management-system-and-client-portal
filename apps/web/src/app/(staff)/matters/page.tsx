import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { MATTER_STATUS_LABELS, MATTER_TYPE_LABELS, type MatterSummary } from '@/lib/matters';
import {WorkspaceHeading} from '@/components/workspace-page';

export const metadata: Metadata = { title: 'Matters' };

export default async function MattersPage({ searchParams }: { searchParams: Promise<{ before?: string | string[];q?:string;state?:string }> }) {
  const { before,q:rawQ,state:rawState } = await searchParams;
  const q=typeof rawQ==='string'?rawQ.slice(0,100):'';
  const state=typeof rawState==='string'&&['open','closed','awaiting_clearance'].includes(rawState)?rawState:'all';
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

  const matters = (body?.matters ?? []).filter(m=>(state==='all'||m.status===state)&&(!q||`${m.reference} ${m.title} ${m.client.name}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <WorkspaceHeading title="Matters" description="Manage case work, client relationships and matter teams." action="New matter" href="/clients"/>
      <nav className="workspace-tabs" aria-label="Matter status">{[['all','All'],['open','Open'],['awaiting_clearance','Pending'],['closed','Closed']].map(([value,label])=><Link key={value} href={`/matters?state=${value}`} aria-current={state===value?'page':undefined}>{label}</Link>)}</nav>
      <form className="workspace-filters"><input name="state" type="hidden" value={state}/><label>Search this page<input type="search" name="q" defaultValue={q} maxLength={100} placeholder="Matter, reference or client"/></label><button className="button button-secondary">Apply filters</button></form>
      <p className="workspace-filter-note">Filters apply to the loaded page. Use the top search bar to search all accessible matters. To open a new matter, choose its client first.</p>
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
