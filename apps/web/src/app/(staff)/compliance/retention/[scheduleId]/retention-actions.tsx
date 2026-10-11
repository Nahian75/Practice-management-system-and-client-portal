'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

export function RetentionActions({ scheduleId, activeHold, disposeAfter }:
  { scheduleId: string; activeHold: boolean; disposeAfter: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);
  const due = disposeAfter <= new Date().toISOString().slice(0, 10);
  async function hold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const action = String(form.get('action'));
    const body = { action, reviewOn: action === 'released' ? null : String(form.get('reviewOn') ?? ''),
      authority: String(form.get('authority') ?? '').trim(), reason: String(form.get('reason') ?? '').trim() };
    if (body.authority.length < 3 || body.reason.length < 10 || (action !== 'released' && !body.reviewOn)) {
      setErrors(['Enter the authority, a full reason and the next review date for an active hold']); return;
    }
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/compliance/retention/${encodeURIComponent(scheduleId)}/legal-holds`, body);
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  async function dispose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (String(form.get('confirmation')) !== 'DISPOSE') { setErrors(['Type DISPOSE to confirm permanent deletion']); return; }
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/compliance/retention/${encodeURIComponent(scheduleId)}/dispose`, {});
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.push('/compliance/retention'); router.refresh();
    } finally { setSending(false); }
  }
  return <>{errors && <ErrorSummary messages={errors} />}
    <form aria-label="Record legal hold event" onSubmit={hold} noValidate><h2>{activeHold ? 'Review or release legal hold' : 'Impose legal hold'}</h2>
      <div className="field"><label className="label" htmlFor="action">Event</label><select className="select" id="action" name="action" defaultValue={activeHold ? 'reviewed' : 'imposed'}>
        {activeHold ? <><option value="reviewed">Reviewed; keep active</option><option value="released">Released</option></> : <option value="imposed">Imposed</option>}</select></div>
      <div className="field"><label className="label" htmlFor="reviewOn">Next review date</label><span className="hint">Required while the hold remains active; ignored when released.</span><input className="input input-date" id="reviewOn" name="reviewOn" type="date" /></div>
      <div className="field"><label className="label" htmlFor="authority">Authority and scope</label><input className="input" id="authority" name="authority" maxLength={500} /></div>
      <div className="field"><label className="label" htmlFor="reason">Reason</label><textarea className="input" id="reason" name="reason" rows={4} maxLength={10000} /></div>
      <button className="button" type="submit" disabled={sending}>Record permanent event</button></form>
    {due && !activeHold && <form aria-label="Permanently dispose of AML records" onSubmit={dispose} noValidate><hr className="rule" /><h2>Permanently dispose of AML records</h2>
      <div className="error-summary"><p><strong>This cannot be undone.</strong> Protected database content and stored evidence files will be deleted. Only a content-free disposal record remains.</p></div>
      <div className="field"><label className="label" htmlFor="confirmation">Type DISPOSE to confirm</label><input className="input" id="confirmation" name="confirmation" autoComplete="off" /></div>
      <button className="button" type="submit" disabled={sending}>Permanently dispose</button></form>}
  </>;
}
