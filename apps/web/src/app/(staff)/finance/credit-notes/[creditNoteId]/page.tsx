import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate } from '@/lib/format';
import { pounds, type CreditNote, type FinanceAccess } from '@/lib/finance';
import { DeliveryForm } from '../../billing-actions';

export const metadata: Metadata = { title: 'Credit note' };
export default async function CreditNotePage({ params }: { params: Promise<{ creditNoteId: string }> }) { const { creditNoteId } = await params; const [result, access] = await Promise.all([apiGet<CreditNote>(`/credit-notes/${encodeURIComponent(creditNoteId)}`), apiGet<FinanceAccess>('/finance/access')]); if (result.status === 403) return <NoAccess what="this credit note" />; if (!result.body) notFound(); const credit = result.body; return <><span className="caption">Credit note for {credit.billReference}</span><h1>{credit.reference}</h1><div className="actions"><Link href={`/finance/bills/${credit.billId}`}>Original bill</Link><a className="button button-secondary" href={`/api/credit-notes/${credit.id}/content`}>Download fixed credit note</a></div><dl className="summary"><div className="summary-row"><dt>Issued</dt><dd>{formatCalendarDate(credit.issuedOn)}</dd></div><div className="summary-row"><dt>Reason</dt><dd>{credit.reason}</dd></div><div className="summary-row"><dt>Total credit</dt><dd>{pounds(credit.gross)} including {pounds(credit.vat)} VAT</dd></div></dl><table className="table"><thead><tr><th scope="col">Description</th><th scope="col">Net</th><th scope="col">VAT</th><th scope="col">Gross</th></tr></thead><tbody>{credit.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{pounds(line.net)}</td><td>{pounds(line.vat)}</td><td>{pounds(line.gross)}</td></tr>)}</tbody></table>{access.body?.canManageBilling && <DeliveryForm kind="credit-note" id={credit.id} />}</>; }
