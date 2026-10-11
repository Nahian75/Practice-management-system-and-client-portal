import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { clientName, type Client, type ClientSummary } from '@/lib/clients';
import type { CddSummary } from '@/lib/compliance';
import { formatDateTime } from '@/lib/format';
import { ClientComplianceActions } from './client-compliance-actions';

export const metadata: Metadata = { title: 'Client AML record' };

export default async function ClientCompliancePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const [client, complianceClients, cdd, sanctions] = await Promise.all([
    apiGet<Client>(`/clients/${encodeURIComponent(clientId)}`),
    apiGet<{ clients: ClientSummary[] }>('/compliance/clients'),
    apiGet<{ cases: CddSummary[]; next: string | null }>(`/clients/${encodeURIComponent(clientId)}/cdd`),
    apiGet<{ state: 'clear' | 'unscreened' | 'stale' | 'possible_match' | 'confirmed' }>(`/compliance/sanctions/clients/${encodeURIComponent(clientId)}`),
  ]);
  if (!cdd.body) notFound();
  const selected = complianceClients.body?.clients.find((item) => item.id === clientId);
  const displayName = client.body ? clientName(client.body) : selected?.name;
  if (!displayName) notFound();
  const hasDraft = cdd.body.cases.some((item) => item.status === 'draft');
  return <>
    <p><Link href={client.body ? `/clients/${clientId}` : '/compliance'}>Back to {client.body ? 'client' : 'Compliance'}</Link></p><h1>{displayName}: AML record</h1>
    <p className="secondary">Internal only. Do not copy these checks into the client portal.</p>
    {sanctions.body && <div className={`notice ${sanctions.body.state === 'clear' ? '' : 'notice-warning'}`}><p><strong>Sanctions: {sanctionsLabel(sanctions.body.state)}.</strong></p></div>}
    <ClientComplianceActions clientId={clientId} hasDraft={hasDraft} canScreen={sanctions.status === 200} />
    <section aria-labelledby="cdd-heading"><h2 id="cdd-heading">CDD cases</h2>
      {!cdd.body.cases.length ? <p>No case has been started.</p> : <table className="table"><thead><tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Prepared by</th><th scope="col">Subjects</th><th scope="col">Evidence</th><th scope="col">Created</th></tr></thead>
        <tbody>{cdd.body.cases.map((item) => <tr key={item.id}><td><Link href={`/clients/${clientId}/compliance/${item.id}`}>Version {item.version}</Link></td><td>{item.status}</td><td>{item.preparedBy.displayName}</td>
          <td>{item.subjectCount}</td><td>{item.evidenceCount}</td><td>{formatDateTime(item.createdAt)}</td></tr>)}</tbody></table>}
    </section>
  </>;
}

function sanctionsLabel(state: 'clear' | 'unscreened' | 'stale' | 'possible_match' | 'confirmed') {
  return ({ clear: 'clear', unscreened: 'screening required', stale: 'screening out of date', possible_match: 'Compliance review required', confirmed: 'restricted by sanctions controls' } as const)[state];
}
