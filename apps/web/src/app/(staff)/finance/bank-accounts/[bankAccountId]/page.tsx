import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { pounds, type CashBook, type FinanceAccess } from '@/lib/finance';
import { CloseBankForm } from './close-bank-form';

export const metadata: Metadata = { title: 'Cash book' };

export default async function CashBookPage({ params, searchParams }: { params: Promise<{ bankAccountId: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const { bankAccountId } = await params; const { before } = await searchParams;
  const [result, access] = await Promise.all([
    apiGet<CashBook>(`/finance/bank-accounts/${encodeURIComponent(bankAccountId)}/cash-book`, { before: typeof before === 'string' ? before : undefined }),
    apiGet<FinanceAccess>('/finance/access'),
  ]);
  if (result.status === 403) return <NoAccess what="this cash book" />;
  if (result.status === 400 || result.status === 404 || !result.body) notFound();
  const book = result.body;
  return <><span className="caption">{book.bankAccount.kind === 'client' ? 'Client' : 'Business'} account •••• {book.bankAccount.lastFour}</span><h1>{book.bankAccount.name}</h1>
    <div className="actions"><Link href="/finance">Back to Finance</Link><a className="button button-secondary" href={`/api/finance/bank-accounts/${book.bankAccount.id}/cash-book/export`}>Export cash book (CSV)</a></div>
    <dl className="summary"><div className="summary-row"><dt>Balance</dt><dd>{pounds(book.balance)}</dd></div><div className="summary-row"><dt>Opened</dt><dd>{formatCalendarDate(book.bankAccount.openedOn)}</dd></div><div className="summary-row"><dt>Closed</dt><dd>{book.bankAccount.closedOn ? formatCalendarDate(book.bankAccount.closedOn) : 'Open'}</dd></div></dl>
    <h2>Posted entries</h2>{!book.entries.length ? <p>No entries.</p> : <table className="table"><thead><tr><th scope="col">Date</th><th scope="col">Matter</th><th scope="col">Entry</th><th scope="col">Amount</th><th scope="col">Reference and purpose</th><th scope="col">Reconciliation source key</th><th scope="col">Posted</th></tr></thead><tbody>{book.entries.map((entry) => <tr key={entry.id}><td>{formatCalendarDate(entry.occurredOn)}</td><td><Link href={`/finance/matters/${entry.matterId}`}>Open ledger</Link></td><td>{entry.kind.replaceAll('_', ' ')}</td><td>{entry.direction === 'debit' ? '+' : '−'}{pounds(entry.amount)}</td><td>{entry.reference ?? 'No reference'}<br /><span className="secondary">{entry.purpose}</span></td><td><code>{`cashbook:${entry.transactionId}:${book.bankAccount.id}`}</code></td><td>{formatDateTime(entry.postedAt)}</td></tr>)}</tbody></table>}
    {book.next && <p><Link href={`/finance/bank-accounts/${book.bankAccount.id}?before=${book.next}`}>Older entries</Link></p>}
    {!book.bankAccount.closedOn && access.body?.canRecordClientMoney && <CloseBankForm bankAccountId={book.bankAccount.id} />}
  </>;
}
