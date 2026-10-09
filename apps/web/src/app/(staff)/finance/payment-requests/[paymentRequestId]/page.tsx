import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { PAYMENT_KIND_LABELS, PAYMENT_STATUS_LABELS, pounds, type FinanceAccess, type PaymentRequest } from '@/lib/finance';
import { PaymentActions } from './payment-actions';

export const metadata: Metadata = { title: 'Payment request' };
export default async function PaymentRequestPage({ params }: { params: Promise<{ paymentRequestId: string }> }) {
  const { paymentRequestId } = await params; const [request, access] = await Promise.all([apiGet<PaymentRequest>(`/finance/payment-requests/${encodeURIComponent(paymentRequestId)}`), apiGet<FinanceAccess>('/finance/access')]);
  if (request.status === 403 || access.status === 403) return <NoAccess what="this payment request" />; if (!request.body || !access.body) notFound(); const payment = request.body;
  return <><span className="caption">{PAYMENT_KIND_LABELS[payment.kind]}</span><h1>{pounds(payment.amount)} payment request</h1><div className="actions"><Link href="/finance">Back to Finance</Link><Link href={`/finance/matters/${payment.matterId}`}>Matter finance</Link></div>
    <dl className="summary"><div className="summary-row"><dt>Status</dt><dd>{PAYMENT_STATUS_LABELS[payment.status]}</dd></div><div className="summary-row"><dt>Purpose</dt><dd>{payment.purpose}</dd></div><div className="summary-row"><dt>Requested by</dt><dd>{payment.requestedBy.displayName}, {formatDateTime(payment.requestedAt)}</dd></div><div className="summary-row"><dt>Evidence</dt><dd><Link href={`/documents/${payment.evidenceDocumentId}`}>Open supporting document</Link></dd></div></dl>
    <h2>Permanent history</h2>{!payment.events.length ? <p>No decision or bank outcome yet.</p> : <table className="table"><thead><tr><th scope="col">Event</th><th scope="col">When</th><th scope="col">By</th><th scope="col">Details</th></tr></thead><tbody>{payment.events.map((event) => <tr key={event.id}><td>{event.kind.replaceAll('_', ' ')}</td><td>{formatDateTime(event.actedAt)}</td><td>{event.actedBy.displayName}</td><td>{event.reason ?? event.bankReference ?? (event.occurredOn ? formatCalendarDate(event.occurredOn) : '—')}</td></tr>)}</tbody></table>}
    <PaymentActions payment={payment} access={access.body} />
  </>;
}
