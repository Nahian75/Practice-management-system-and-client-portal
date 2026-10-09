import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { pounds, type TimeEntryDetail } from '@/lib/finance';
import { CorrectionForm } from './correction-form';

export const metadata: Metadata = { title: 'Time entry' };
export default async function TimeEntryPage({ params }: { params: Promise<{ entryId: string }> }) { const { entryId } = await params; const [result, account] = await Promise.all([apiGet<TimeEntryDetail>(`/time-entries/${encodeURIComponent(entryId)}`), currentAccount()]); if (result.status === 403) return <NoAccess what="this time entry" />; if (!result.body) notFound(); const entry = result.body; return <><span className="caption">{entry.voided ? 'Voided time entry' : 'Time entry'}</span><h1>{formatCalendarDate(entry.workedOn)} • {entry.minutes} minutes</h1><div className="actions"><Link href={`/matters/${entry.matterId}`}>Back to matter</Link></div><dl className="summary"><div className="summary-row"><dt>Person</dt><dd>{entry.worker.displayName}</dd></div><div className="summary-row"><dt>Description</dt><dd>{entry.description}</dd></div><div className="summary-row"><dt>Hourly rate</dt><dd>{pounds(entry.hourlyRate)}</dd></div><div className="summary-row"><dt>Recorded</dt><dd>{formatDateTime(entry.recordedAt)}</dd></div></dl><h2>Correction history</h2>{!entry.corrections.length ? <p>No corrections.</p> : <table className="table"><thead><tr><th scope="col">When</th><th scope="col">By</th><th scope="col">Reason</th><th scope="col">Result</th></tr></thead><tbody>{entry.corrections.map((item) => <tr key={item.id}><td>{formatDateTime(item.correctedAt)}</td><td>{item.correctedBy.displayName}</td><td>{item.reason}</td><td>{item.to ? `${formatCalendarDate(item.to.workedOn)}, ${item.to.minutes} minutes, ${item.to.description}` : 'Voided'}</td></tr>)}</tbody></table>}{account?.id === entry.worker.accountId && !entry.voided && <CorrectionForm entry={entry} />}</>; }
