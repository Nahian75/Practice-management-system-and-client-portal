import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { pounds, type FinanceAccess, type Reconciliation } from '@/lib/finance';
import { SignOffButton } from './sign-off-button';

export const metadata: Metadata = { title: 'Client-account reconciliation' };
export default async function ReconciliationPage({ params }: { params: Promise<{ reconciliationId: string }> }) {
  const { reconciliationId } = await params; const [result, access] = await Promise.all([apiGet<Reconciliation>(`/finance/reconciliations/${encodeURIComponent(reconciliationId)}`), apiGet<FinanceAccess>('/finance/access')]);
  if (result.status === 403 || access.status === 403) return <NoAccess what="this reconciliation" />; if (!result.body || !access.body) notFound(); const item = result.body;
  return <><span className="caption">Fixed client-account reconciliation</span><h1>Reconciliation at {formatCalendarDate(item.asOf)}</h1><div className="actions"><Link href="/finance">Back to Finance</Link><a className="button button-secondary" href={`/api/finance/reconciliations/${item.id}/export`}>Export reconciliation (CSV)</a></div>
    <dl className="summary"><div className="summary-row"><dt>Bank balance</dt><dd>{pounds(item.bankBalance)}</dd></div><div className="summary-row"><dt>Cash book balance</dt><dd>{pounds(item.cashbookBalance)}</dd></div><div className="summary-row"><dt>Client ledger balance</dt><dd>{pounds(item.clientLedgerBalance)}</dd></div><div className="summary-row"><dt>Bank / cash book difference</dt><dd>{pounds(item.bankCashbookDifference)}</dd></div><div className="summary-row"><dt>Cash book / client ledger difference</dt><dd>{pounds(item.cashbookClientDifference)}</dd></div><div className="summary-row"><dt>Prepared</dt><dd>{formatDateTime(item.preparedAt)}</dd></div><div className="summary-row"><dt>Compliance sign-off</dt><dd>{item.signOff ? formatDateTime(item.signOff.signedOffAt) : 'Awaiting sign-off'}</dd></div></dl>
    <h2>Outstanding items and explanations</h2>{!item.items.length ? <p>No outstanding items or differences.</p> : <table className="table"><thead><tr><th scope="col">Type</th><th scope="col">Date</th><th scope="col">Amount</th><th scope="col">Reference</th><th scope="col">Explanation</th></tr></thead><tbody>{item.items.map((entry) => <tr key={entry.id}><td>{entry.kind.replaceAll('_', ' ')}</td><td>{entry.occurredOn ? formatCalendarDate(entry.occurredOn) : '—'}</td><td>{pounds(entry.amount)}</td><td>{entry.reference ?? '—'}</td><td>{entry.explanation}</td></tr>)}</tbody></table>}
    {!item.signOff && access.body.canSignOffReconciliation && <SignOffButton reconciliationId={item.id} />}
    {!item.signOff && !access.body.canSignOffReconciliation && <p className="notice">Awaiting a different active Compliance holder to sign off this fixed snapshot.</p>}
  </>;
}
