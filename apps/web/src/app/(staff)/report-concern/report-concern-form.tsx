'use client';

import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { ClientSummary } from '@/lib/clients';
import { messagesOf } from '@/lib/requests';

export function ReportConcernForm({ clients }: { clients: ClientSummary[] }) {
  const [errors, setErrors] = useState<string[]>();
  const [receipt, setReceipt] = useState<string>();
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const facts = String(data.get('observedFacts') ?? '').trim();
    const problems = [
      ...(String(data.get('clientId') ?? '') ? [] : ['Choose the client connected with the concern']),
      ...(String(data.get('observedOn') ?? '') ? [] : ['Enter when you observed the facts']),
      ...(facts.length >= 20 ? [] : ['Describe the facts you observed in at least 20 characters']),
    ];
    if (problems.length) { setErrors(problems); return; }
    setSending(true); setErrors(undefined);
    try {
      const file = data.get('file');
      const hasFile = file instanceof File && file.size > 0;
      const response = hasFile
        ? await fetch('/api/compliance/restricted-reports', { method: 'POST', body: data })
        : await fetch('/api/compliance/restricted-reports', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: data.get('clientId'), matterId: data.get('matterId') || null,
            financeTransactionId: data.get('financeTransactionId') || null, observedOn: data.get('observedOn'), observedFacts: facts }) });
      if (!response.ok) { setErrors(await messagesOf(response)); return; }
      const body = await response.json() as { receiptId: string };
      form.reset(); setReceipt(body.receiptId);
    } finally { setSending(false); }
  }

  if (receipt) return <div className="notice" role="status"><h2>Report received</h2>
    <p>Your receipt is <strong>{receipt}</strong>. The report is now fixed and available only through the protected nominated-officer process.</p>
    <button className="button" type="button" onClick={() => setReceipt(undefined)}>Report another concern</button></div>;

  return <form aria-label="Confidential internal report" onSubmit={submit} noValidate>
    {errors && <ErrorSummary messages={errors} />}
    <div className="field"><label className="label" htmlFor="clientId">Client</label>
      <select className="select" id="clientId" name="clientId" defaultValue="" required>
        <option value="" disabled>Choose a client</option>
        {clients.map((client) => <option key={client.id} value={client.id}>{client.reference}: {client.name}</option>)}
      </select></div>
    <div className="field"><label className="label" htmlFor="observedOn">Date observed</label>
      <input className="input input-date" id="observedOn" name="observedOn" type="date" required /></div>
    <div className="field"><label className="label" htmlFor="matterId">Matter id (optional)</label>
      <span className="hint" id="matterId-hint">Add only when the concern belongs to a particular matter.</span>
      <input className="input" id="matterId" name="matterId" aria-describedby="matterId-hint" /></div>
    <div className="field"><label className="label" htmlFor="financeTransactionId">Finance transaction id (optional)</label>
      <input className="input" id="financeTransactionId" name="financeTransactionId" /></div>
    <div className="field"><label className="label" htmlFor="observedFacts">Facts observed</label>
      <span className="hint" id="observedFacts-hint">Record what you saw or were told, relevant dates and amounts. Do not reach a legal conclusion.</span>
      <textarea className="input" id="observedFacts" name="observedFacts" rows={9} maxLength={100000} aria-describedby="observedFacts-hint" required /></div>
    <div className="field"><label className="label" htmlFor="file">Fixed supporting file (optional)</label>
      <span className="hint" id="file-hint">PDF or another file type accepted by the firm, up to 50 MB. It will be malware-scanned and separately encrypted.</span>
      <input className="input" id="file" name="file" type="file" aria-describedby="file-hint" /></div>
    <button className="button" type="submit" disabled={sending}>{sending ? 'Sending securely...' : 'Send confidential report'}</button>
  </form>;
}
