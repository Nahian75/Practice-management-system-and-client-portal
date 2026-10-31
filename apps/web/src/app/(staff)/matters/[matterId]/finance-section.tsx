import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { formatCalendarDate } from '@/lib/format';
import { pounds, type IssuedBillSummary, type TimeEntry } from '@/lib/finance';
import type { Matter } from '@/lib/matters';
import { TimeEntryForm } from './time-entry-form';
import { ExpensesSection } from '@/components/expenses-section';

export async function FinanceSection({ matter,expensesBefore }: { matter: Matter;expensesBefore?:string }) {
  const [time, bills] = await Promise.all([
    apiGet<{ timeEntries: TimeEntry[]; next: string | null }>(`/matters/${encodeURIComponent(matter.id)}/time-entries`),
    apiGet<{ bills: IssuedBillSummary[] }>(`/matters/${encodeURIComponent(matter.id)}/bills`),
  ]);
  if (time.status !== 200 || bills.status !== 200 || !time.body || !bills.body) return null;
  return (
    <section aria-labelledby="finance-heading">
      <h2 id="finance-heading">Time and finance</h2>
      <h3>Time</h3>
      {time.body.timeEntries.length === 0 ? <p>No time has been recorded.</p> : (
        <table className="table">
          <caption className="secondary">Most recent time entries. Descriptions remain private until an entry is opened.</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Person</th><th scope="col">Minutes</th><th scope="col">Rate</th><th scope="col">State</th></tr></thead>
          <tbody>{time.body.timeEntries.map((entry) => <tr key={entry.id}>
            <td><Link href={`/finance/time-entries/${entry.id}`}>{formatCalendarDate(entry.workedOn)}</Link></td><td>{entry.worker.displayName}</td><td>{entry.minutes}</td>
            <td>{pounds(entry.hourlyRate)}</td><td>{entry.voided ? 'Voided' : 'Current'}</td>
          </tr>)}</tbody>
        </table>
      )}
      {matter.status === 'open' && <TimeEntryForm matterId={matter.id} />}
      <ExpensesSection matterId={matter.id} open={matter.status === 'open'} before={expensesBefore} paginationPath={`/matters/${matter.id}`} />
      <h3>Issued bills</h3>
      {bills.body.bills.length === 0 ? <p>No bills have been issued.</p> : (
        <table className="table"><thead><tr><th scope="col">Bill</th><th scope="col">Issued</th><th scope="col">Due</th><th scope="col">Total</th><th scope="col">File</th></tr></thead>
          <tbody>{bills.body.bills.map((bill) => <tr key={bill.id}><td><Link href={`/finance/bills/${bill.id}`}>{bill.reference}</Link></td><td>{formatCalendarDate(bill.issuedOn)}</td>
            <td>{formatCalendarDate(bill.dueOn)}</td><td>{pounds(bill.gross)}</td><td><a href={`/api/bills/${bill.id}/content`}>Download bill <span className="visually-hidden">{bill.reference}</span></a></td></tr>)}</tbody>
        </table>
      )}
      {time.body.next && <p><Link href={`/finance/matters/${matter.id}`}>See the complete finance record</Link></p>}
    </section>
  );
}
