import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { pounds, type FinanceAccess, type StatementImport } from '@/lib/finance';
import { StatementActions } from './statement-actions';

export const metadata: Metadata = { title: 'Bank statement' };
export default async function StatementPage({ params }: { params: Promise<{ statementId: string }> }) {
  const { statementId } = await params; const [result, access] = await Promise.all([apiGet<StatementImport>(`/finance/statement-imports/${encodeURIComponent(statementId)}`), apiGet<FinanceAccess>('/finance/access')]);
  if (result.status === 403 || access.status === 403) return <NoAccess what="this bank statement" />; if (!result.body || !access.body) notFound(); const statement = result.body;
  return <><span className="caption">Imported bank statement</span><h1>{formatCalendarDate(statement.periodStart)} to {formatCalendarDate(statement.periodEnd)}</h1><div className="actions"><Link href="/finance">Back to Finance</Link><Link href={`/finance/bank-accounts/${statement.bankAccountId}`}>Open cash book</Link></div>
    <dl className="summary"><div className="summary-row"><dt>File</dt><dd>{statement.fileName}</dd></div><div className="summary-row"><dt>Opening balance</dt><dd>{pounds(statement.openingBalance)}</dd></div><div className="summary-row"><dt>Closing balance</dt><dd>{pounds(statement.closingBalance)}</dd></div><div className="summary-row"><dt>Imported</dt><dd>{formatDateTime(statement.importedAt)}</dd></div></dl>
    <h2>Statement rows</h2>{access.body.canReconcile ? <StatementActions statement={statement} /> : <><p className="secondary">Compliance view: matching is read-only.</p><table className="table"><thead><tr><th scope="col">Row</th><th scope="col">Date</th><th scope="col">Amount</th><th scope="col">Reference</th><th scope="col">Description</th><th scope="col">Reconciliation source key</th><th scope="col">Match</th></tr></thead><tbody>{statement.rows.map((row) => <tr key={row.id}><td>{row.rowNumber}</td><td>{formatCalendarDate(row.occurredOn)}</td><td>{pounds(row.amount)}</td><td>{row.reference}</td><td>{row.description}</td><td><code>{`statement:${row.id}`}</code></td><td>{row.matches.some((match) => !match.reversedAt) ? 'Matched' : 'Unmatched'}</td></tr>)}</tbody></table></>}
  </>;
}
