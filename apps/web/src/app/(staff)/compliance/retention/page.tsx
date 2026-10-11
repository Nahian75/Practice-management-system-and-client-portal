import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import type { ClientSummary } from '@/lib/clients';
import type { DisposalRun, RetentionScheduleSummary } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { RetentionScheduleForm } from './retention-schedule-form';

export const metadata: Metadata = { title: 'Retention and disposal' };

export default async function RetentionPage() {
  const [schedules, disposals, clients] = await Promise.all([
    apiGet<{ schedules: RetentionScheduleSummary[] }>('/compliance/retention'),
    apiGet<{ disposals: DisposalRun[] }>('/compliance/retention/disposals'),
    apiGet<{ clients: ClientSummary[] }>('/compliance/clients'),
  ]);
  if (schedules.status === 403) return <NoAccess what="AML retention records" />;
  if (!schedules.body || !disposals.body) throw new Error('Could not load AML retention records');
  const names = new Map((clients.body?.clients ?? []).map((client) => [client.id, `${client.reference}: ${client.name}`]));
  return <>
    <p><Link href="/compliance">Back to Compliance</Link></p>
    <h1>Retention and disposal</h1>
    <p>Record the evidenced end of a client relationship, the governing retention rule and any legal hold. Disposal permanently removes protected AML content after every control passes.</p>
    <RetentionScheduleForm clients={clients.body?.clients ?? []} />
    <hr className="rule" />
    <section aria-labelledby="schedules-heading"><h2 id="schedules-heading">Active schedules</h2>
      {!schedules.body.schedules.length ? <p>No retention schedules.</p> : <table className="table"><thead><tr><th scope="col">Client</th><th scope="col">Relationship ended</th><th scope="col">Dispose after</th><th scope="col">Legal hold</th></tr></thead>
        <tbody>{schedules.body.schedules.map((item) => <tr key={item.id}><td><Link href={`/compliance/retention/${item.id}`}>{names.get(item.clientId) ?? item.clientId}</Link></td>
          <td>{formatCalendarDate(item.relationshipEndedOn)}</td><td>{formatCalendarDate(item.disposeAfter)}</td>
          <td>{item.currentHold ? holdLabel(item.currentHold.action, item.currentHold.reviewOn) : 'None'}</td></tr>)}</tbody></table>}
    </section>
    <section aria-labelledby="disposals-heading"><h2 id="disposals-heading">Disposal history</h2>
      {!disposals.body.disposals.length ? <p>No disposal runs.</p> : <table className="table"><thead><tr><th scope="col">Client id</th><th scope="col">State</th><th scope="col">Completed</th><th scope="col">Records</th></tr></thead>
        <tbody>{disposals.body.disposals.map((item) => <tr key={item.id}><td>{item.clientId}</td><td>{item.state === 'completed' ? 'Completed' : 'Prepared'}</td>
          <td>{item.completedAt ? formatDateTime(item.completedAt) : 'Not completed'}</td><td>{item.recordCount ?? 'Not available'}</td></tr>)}</tbody></table>}
    </section>
  </>;
}

function holdLabel(action: RetentionScheduleSummary['currentHold'] extends infer T ? T extends { action: infer A } ? A : never : never,
  reviewOn: string | null) {
  if (action === 'released') return 'Released';
  return `${action === 'imposed' ? 'Active' : 'Reviewed'}${reviewOn ? `; review ${formatCalendarDate(reviewOn)}` : ''}`;
}
