'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

export function ClientComplianceActions({ clientId, hasDraft, canScreen }:
  { clientId: string; hasDraft: boolean; canScreen: boolean }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function draft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const body = { intendedRelationship: String(form.get('intendedRelationship') ?? '').trim(), reason: String(form.get('reason') ?? '').trim() };
    if (body.intendedRelationship.length < 10 || body.reason.length < 10) { setErrors(['Describe the intended relationship and why checks are being made']); return; }
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/clients/${clientId}/cdd`, body);
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  async function screen() {
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/compliance/sanctions/clients/${clientId}/screenings`, {});
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  return <>{errors && <ErrorSummary messages={errors} />}
    {canScreen && <div className="actions"><button className="button" type="button" onClick={screen} disabled={sending}>Screen against current UK Sanctions List</button></div>}
    {!hasDraft && <form aria-label="Start CDD case" onSubmit={draft} noValidate><h2>Start CDD case</h2>
      <div className="field"><label className="label" htmlFor="intendedRelationship">Intended relationship</label><textarea className="input" id="intendedRelationship" name="intendedRelationship" rows={3} maxLength={10000} /></div>
      <div className="field"><label className="label" htmlFor="reason">Reason for these checks</label><textarea className="input" id="reason" name="reason" rows={3} maxLength={10000} /></div>
      <button className="button" type="submit" disabled={sending}>Start versioned CDD case</button></form>}
  </>;
}
