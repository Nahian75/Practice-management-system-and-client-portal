import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import type { RetentionSchedule } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { RetentionActions } from './retention-actions';

export const metadata: Metadata = { title: 'Retention schedule' };

export default async function RetentionDetailPage({ params }: { params: Promise<{ scheduleId: string }> }) {
  const { scheduleId } = await params;
  const result = await apiGet<RetentionSchedule>(`/compliance/retention/${encodeURIComponent(scheduleId)}`);
  if (result.status === 404 || !result.body) notFound();
  const schedule = result.body;
  const current = schedule.holds.at(-1);
  const activeHold = current?.action === 'imposed' || current?.action === 'reviewed';
  return <>
    <p><Link href="/compliance/retention">Back to retention</Link></p><h1>Retention schedule</h1>
    <dl className="summary"><div><dt>Client id</dt><dd>{schedule.clientId}</dd></div><div><dt>Relationship ended</dt><dd>{formatCalendarDate(schedule.relationshipEndedOn)}</dd></div>
      <div><dt>Dispose after</dt><dd>{formatCalendarDate(schedule.disposeAfter)}</dd></div><div><dt>Governing rule</dt><dd>{schedule.governingRule}</dd></div>
      <div><dt>Evidence</dt><dd>{schedule.evidence}</dd></div><div><dt>Recorded</dt><dd>{formatDateTime(schedule.recordedAt)}</dd></div></dl>
    <section aria-labelledby="legal-holds-heading"><h2 id="legal-holds-heading">Legal-hold events</h2>
      {!schedule.holds.length ? <p>No legal hold has been recorded.</p> : <table className="table"><thead><tr><th scope="col">Event</th><th scope="col">Authority</th><th scope="col">Reason</th><th scope="col">Review</th><th scope="col">Recorded</th></tr></thead>
        <tbody>{schedule.holds.map((hold) => <tr key={hold.id}><td>{hold.action}</td><td>{hold.authority}</td><td>{hold.reason}</td>
          <td>{hold.reviewOn ? formatCalendarDate(hold.reviewOn) : 'None'}</td><td>{formatDateTime(hold.recordedAt)}</td></tr>)}</tbody></table>}
    </section>
    <RetentionActions scheduleId={schedule.id} activeHold={activeHold} disposeAfter={schedule.disposeAfter} />
  </>;
}
