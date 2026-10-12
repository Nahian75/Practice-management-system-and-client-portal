import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { HrDisposal, HrRetentionSchedule } from '@/lib/hr';

export const metadata: Metadata = { title: 'HR retention and disposal' };

export default async function HrRetentionPage() {
  const [schedules, disposals] = await Promise.all([
    apiGet<{ schedules: HrRetentionSchedule[] }>('/hr/retention/schedules'),
    apiGet<{ disposals: HrDisposal[] }>('/hr/retention/disposals'),
  ]);
  if (schedules.status === 403) return <NoAccess what="HR retention records" />;
  if (!schedules.body || !disposals.body) throw new Error('Could not load HR retention records');
  return <><p><Link href="/hr">Back to HR workspace</Link></p><h1>HR retention and disposal</h1>
    <p className="secondary">Dates are reviewed against the source records by PostgreSQL. Legal holds always stop disposal.</p>
    {!schedules.body.schedules.length ? <p>No retention schedules.</p> : <table className="table"><thead><tr>
      <th scope="col">Category</th><th scope="col">Person</th><th scope="col">Review</th><th scope="col">Dispose after</th><th scope="col">Hold</th></tr></thead><tbody>
      {schedules.body.schedules.map((item) => <tr key={item.id}><td><Link href={`/hr/retention/${item.id}`}>{item.category.replaceAll('_', ' ')}</Link></td>
        <td>{item.personId}</td><td>{formatCalendarDate(item.reviewOn)}</td><td>{formatCalendarDate(item.disposeAfter)}</td>
        <td>{item.currentHold ? item.currentHold.action : 'None'}</td></tr>)}</tbody></table>}
    <h2>Disposal history</h2>{!disposals.body.disposals.length ? <p>No disposal runs.</p> : <table className="table"><thead><tr>
      <th scope="col">Category</th><th scope="col">State</th><th scope="col">Prepared</th><th scope="col">Records</th></tr></thead><tbody>
      {disposals.body.disposals.map((item) => <tr key={item.id}><td>{item.category.replaceAll('_', ' ')}</td><td>{item.state}</td>
        <td>{formatDateTime(item.preparedAt)}</td><td>{item.recordCount ?? 'Pending'}</td></tr>)}</tbody></table>}
  </>;
}
