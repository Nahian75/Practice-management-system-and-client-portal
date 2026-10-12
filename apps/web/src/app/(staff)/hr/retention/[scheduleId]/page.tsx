import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { HrRetentionSchedule } from '@/lib/hr';
import { HrRetentionActions } from './retention-actions';

export const metadata: Metadata = { title: 'HR retention schedule' };

export default async function HrRetentionDetailPage({ params }: { params: Promise<{ scheduleId: string }> }) {
  const { scheduleId } = await params;
  const [detail, list] = await Promise.all([
    apiGet<HrRetentionSchedule>(`/hr/retention/schedules/${scheduleId}`),
    apiGet<{ schedules: HrRetentionSchedule[] }>('/hr/retention/schedules'),
  ]);
  if (detail.status === 404) notFound();
  if (!detail.body || !list.body) throw new Error('Could not load the HR retention schedule');
  const summary = list.body.schedules.find((item) => item.id === scheduleId);
  const latest = detail.body.holds?.at(-1); const activeHold = latest?.action === 'imposed' || latest?.action === 'reviewed';
  return <><p><Link href="/hr/retention">Back to HR retention</Link></p><h1>HR retention schedule</h1>
    <dl className="summary"><dt>Person</dt><dd>{detail.body.personId}</dd><dt>Category</dt><dd>{detail.body.category.replaceAll('_', ' ')}</dd>
      <dt>Source date</dt><dd>{formatCalendarDate(detail.body.basisOn)}</dd><dt>Review</dt><dd>{formatCalendarDate(detail.body.reviewOn)}</dd>
      <dt>Dispose after</dt><dd>{formatCalendarDate(detail.body.disposeAfter)}</dd><dt>Governing rule</dt><dd>{summary?.governingRule ?? 'Recorded rule'}</dd>
      <dt>Evidence</dt><dd className="pre-wrap">{detail.body.evidence}</dd></dl>
    <h2>Legal-hold history</h2>{!detail.body.holds?.length ? <p>No legal hold.</p> : <table className="table"><thead><tr>
      <th scope="col">Event</th><th scope="col">Review</th><th scope="col">Authority</th><th scope="col">Reason</th><th scope="col">Recorded</th></tr></thead><tbody>
      {detail.body.holds.map((item) => <tr key={item.id}><td>{item.action}</td><td>{item.reviewOn ? formatCalendarDate(item.reviewOn) : 'Released'}</td>
        <td>{item.authority}</td><td>{item.reason}</td><td>{formatDateTime(item.recordedAt)}</td></tr>)}</tbody></table>}
    <HrRetentionActions scheduleId={scheduleId} activeHold={activeHold} disposeAfter={detail.body.disposeAfter} />
  </>;
}
