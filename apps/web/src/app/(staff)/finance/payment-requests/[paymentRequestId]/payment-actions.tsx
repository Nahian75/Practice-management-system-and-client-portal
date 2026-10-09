'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { FinanceAccess, PaymentRequest } from '@/lib/finance';
import { messagesOf, postJson } from '@/lib/requests';

export function PaymentActions({ payment, access }: { payment: PaymentRequest; access: FinanceAccess }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [message, setMessage] = useState<string>(); const [busy, setBusy] = useState(false); const [payee, setPayee] = useState<string>();
  async function act(action: string, body: Record<string, unknown>, success: string) {
    setBusy(true); setErrors(undefined); setMessage(undefined);
    try { const response = await postJson(`/api/finance/payment-requests/${payment.id}/${action}`, body); if (!response.ok) { setErrors(await messagesOf(response)); return; } setMessage(success); router.refresh(); } finally { setBusy(false); }
  }
  async function revealPayee() {
    setBusy(true); setErrors(undefined);
    try { const response = await fetch(`/api/finance/payment-requests/${payment.id}/payee`); if (!response.ok) { setErrors(await messagesOf(response)); return; } const item = await response.json() as { name: string; sortCode: string; accountNumber: string }; setPayee(`${item.name} • ${item.sortCode} • ${item.accountNumber}`); } finally { setBusy(false); }
  }
  const pending = payment.status === 'pending'; const approved = payment.status === 'approved';
  if (!access.canApprovePayment && !access.canRecordClientMoney && !access.canRequestPayment) return <p className="secondary">Compliance view: payment actions and payee bank details are not available.</p>;
  return <section aria-labelledby="actions-heading"><h2 id="actions-heading">Actions</h2>{errors && <ErrorSummary messages={errors} />}{message && <p className="notice" role="status">{message}</p>}
    {access.canRecordClientMoney && (pending || approved) && payment.kind !== 'costs_transfer' && <><button className="button button-secondary" type="button" disabled={busy} onClick={revealPayee}>Show payee bank details</button>{payee && <p className="notice" role="status"><strong>Payee:</strong> {payee}</p>}</>}
    <div className="actions">{access.canApprovePayment && pending && <button className="button" type="button" disabled={busy} onClick={() => act('approve', {}, 'Payment approved and funds reserved.')}>Approve</button>}
      {access.canApprovePayment && pending && <ReasonButton label="Reject" busy={busy} onAct={(reason) => act('reject', { reason }, 'Payment rejected.')} />}
      {access.canRequestPayment && (pending || approved) && <ReasonButton label="Cancel" busy={busy} onAct={(reason) => act('cancel', { reason }, 'Payment cancelled.')} />}</div>
    {access.canRecordClientMoney && approved && <BankOutcome busy={busy} onPaid={(bankReference, occurredOn) => act('paid', { bankReference, occurredOn }, 'Bank payment recorded.')} onRejected={(reason) => act('bank-rejected', { reason }, 'Bank rejection recorded.')} />}
  </section>;
}
function ReasonButton({ label, busy, onAct }: { label: string; busy: boolean; onAct: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return <span><label className="visually-hidden" htmlFor={`${label}-reason`}>{label} reason</label><input className="input input-inline" id={`${label}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`${label} reason`} /><button className="button button-secondary" type="button" disabled={busy || !reason.trim()} onClick={() => onAct(reason.trim())}>{label}</button></span>;
}

function BankOutcome({ busy, onPaid, onRejected }: { busy: boolean; onPaid: (reference: string, date: string) => void; onRejected: (reason: string) => void }) {
  const [reference, setReference] = useState(''); const [date, setDate] = useState(''); const [reason, setReason] = useState('');
  return <div><h3>Record bank outcome</h3><div className="field"><label className="label" htmlFor="bank-reference">Bank reference</label><input className="input" id="bank-reference" value={reference} onChange={(event) => setReference(event.target.value)} /></div><div className="field"><label className="label" htmlFor="paid-on">Date paid</label><input className="input input-date" id="paid-on" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div><button className="button" type="button" disabled={busy || !reference.trim() || !date} onClick={() => onPaid(reference.trim(), date)}>Record paid</button><div className="field after-form"><label className="label" htmlFor="bank-rejection-reason">Bank rejection reason</label><input className="input" id="bank-rejection-reason" value={reason} onChange={(event) => setReason(event.target.value)} /></div><button className="button button-secondary" type="button" disabled={busy || !reason.trim()} onClick={() => onRejected(reason.trim())}>Record bank rejection</button></div>;
}
