'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

export function HrRetentionActions({ scheduleId, activeHold, disposeAfter }:
  { scheduleId: string; activeHold: boolean; disposeAfter: string }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  const due = disposeAfter <= new Date().toISOString().slice(0, 10);
  async function hold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const action = String(form.get('action'));
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/hr/retention/schedules/${scheduleId}/legal-holds`, { action,
      reviewOn: action === 'released' ? null : String(form.get('reviewOn') ?? ''), authority: String(form.get('authority') ?? '').trim(),
      reason: String(form.get('reason') ?? '').trim() }); if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  async function dispose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (String(form.get('confirmation')) !== 'DISPOSE') { setErrors(['Type DISPOSE to confirm permanent deletion']); return; }
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/hr/retention/schedules/${scheduleId}/dispose`, {});
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.push('/hr/retention'); router.refresh();
    } finally { setSending(false); }
  }
  return <>{errors && <ErrorSummary messages={errors} />}
    <form aria-label="Record HR legal hold event" onSubmit={hold}><h2>{activeHold ? 'Review or release legal hold' : 'Impose legal hold'}</h2>
      <div className="field"><label className="label" htmlFor="holdAction">Event</label><select className="select" id="holdAction" name="action" defaultValue={activeHold ? 'reviewed' : 'imposed'}>
        {activeHold ? <><option value="reviewed">Reviewed; keep active</option><option value="released">Released</option></> : <option value="imposed">Imposed</option>}</select></div>
      <div className="field"><label className="label" htmlFor="holdReviewOn">Next review date</label><input className="input input-date" id="holdReviewOn" name="reviewOn" type="date" /></div>
      <div className="field"><label className="label" htmlFor="holdAuthority">Authority and scope</label><input className="input" id="holdAuthority" name="authority" required /></div>
      <div className="field"><label className="label" htmlFor="holdReason">Reason</label><textarea className="input" id="holdReason" name="reason" rows={4} required minLength={10} /></div>
      <button className="button" disabled={sending}>Record permanent event</button></form>
    {due && !activeHold && <form aria-label="Permanently dispose of HR records" onSubmit={dispose}><hr className="rule" />
      <h2>Permanently dispose of HR records</h2><div className="error-summary"><p><strong>This cannot be undone.</strong>{' '}
        Eligible database content, stored HR files and duplicating fixed exports will be deleted. Only a content-free tombstone remains.</p></div>
      <div className="field"><label className="label" htmlFor="disposeConfirmation">Type DISPOSE to confirm</label>
        <input className="input" id="disposeConfirmation" name="confirmation" autoComplete="off" /></div>
      <button className="button button-warning" disabled={sending}>Permanently dispose</button></form>}
  </>;
}
