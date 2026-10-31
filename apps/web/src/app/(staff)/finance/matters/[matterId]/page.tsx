import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { pounds, type FinanceAccess, type IssuedBillSummary, type MatterLedger, type TimeEntry } from '@/lib/finance';
import { BillDraftForm } from '../../bill-draft-form';
import { ExpensesSection } from '@/components/expenses-section';

export const metadata: Metadata = { title: 'Matter finance' };
export default async function MatterFinancePage({ params, searchParams }: { params: Promise<{ matterId: string }>; searchParams: Promise<{ before?: string | string[];expensesBefore?:string }> }) {
  const { matterId } = await params; const { before,expensesBefore } = await searchParams; const access = await apiGet<FinanceAccess>('/finance/access');
  if (access.status === 403 || !access.body) return <NoAccess what="the firm-wide matter ledger" />;
  const [ledger, time, bills] = await Promise.all([
    apiGet<MatterLedger>(`/finance/matters/${encodeURIComponent(matterId)}/ledger`, { before: typeof before === 'string' ? before : undefined }),
    apiGet<{ timeEntries: TimeEntry[]; next: string | null }>(`/matters/${encodeURIComponent(matterId)}/time-entries`),
    apiGet<{ bills: IssuedBillSummary[] }>(`/matters/${encodeURIComponent(matterId)}/bills`),
  ]);
  if (ledger.status === 404 || time.status === 404 || bills.status === 404) notFound(); if (!ledger.body || !time.body || !bills.body) throw new Error('Could not load matter finance');
  return <><span className="caption">Matter id {matterId}</span><h1>Matter finance</h1><div className="actions"><Link href="/finance">Back to Finance</Link><a className="button button-secondary" href={`/api/finance/matters/${matterId}/ledger/export`}>Export matter ledger (CSV)</a></div>
    <dl className="summary"><div className="summary-row"><dt>Client balance</dt><dd>{pounds(ledger.body.clientBalance)}</dd></div><div className="summary-row"><dt>Business balance</dt><dd>{pounds(ledger.body.businessBalance)}</dd></div></dl>
    <h2>Ledger entries</h2>{!ledger.body.entries.length ? <p>No posted entries.</p> : <table className="table"><thead><tr><th scope="col">Date</th><th scope="col">Side</th><th scope="col">Entry</th><th scope="col">Amount</th><th scope="col">Running balance</th><th scope="col">Reference and purpose</th></tr></thead><tbody>{ledger.body.entries.map((entry) => <tr key={entry.id}><td>{formatCalendarDate(entry.occurredOn)}</td><td>{entry.side}</td><td>{entry.kind.replaceAll('_', ' ')}</td><td>{entry.direction} {pounds(entry.amount)}</td><td>{pounds(entry.runningBalance)}</td><td>{entry.reference ?? 'No reference'}<br /><span className="secondary">{entry.purpose}</span></td></tr>)}</tbody></table>}{ledger.body.next && <p><Link href={`/finance/matters/${matterId}?before=${ledger.body.next}`}>Older ledger entries</Link></p>}
    <h2>Time entries</h2>{!time.body.timeEntries.length ? <p>No time recorded.</p> : <table className="table"><thead><tr><th scope="col">Date</th><th scope="col">Person</th><th scope="col">Minutes</th><th scope="col">Rate</th><th scope="col">Recorded</th></tr></thead><tbody>{time.body.timeEntries.map((entry) => <tr key={entry.id}><td><Link href={`/finance/time-entries/${entry.id}`}>{formatCalendarDate(entry.workedOn)}</Link></td><td>{entry.worker.displayName}</td><td>{entry.minutes}</td><td>{pounds(entry.hourlyRate)}</td><td>{formatDateTime(entry.recordedAt)}{entry.voided && ' (voided)'}</td></tr>)}</tbody></table>}
    <h2>Issued bills</h2>{!bills.body.bills.length ? <p>No bills issued.</p> : <table className="table"><thead><tr><th scope="col">Reference</th><th scope="col">Tax point</th><th scope="col">Due</th><th scope="col">Total</th><th scope="col">File</th></tr></thead><tbody>{bills.body.bills.map((bill) => <tr key={bill.id}><td><Link href={`/finance/bills/${bill.id}`}>{bill.reference}</Link></td><td>{formatCalendarDate(bill.taxPoint)}</td><td>{formatCalendarDate(bill.dueOn)}</td><td>{pounds(bill.gross)}</td><td><a href={`/api/bills/${bill.id}/content`}>Download</a></td></tr>)}</tbody></table>}
    <ExpensesSection matterId={matterId} open={true} before={expensesBefore} />
    {access.body.canManageBilling && <BillDraftForm matterId={matterId} />}
  </>;
}
