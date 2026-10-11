'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { ClientSummary } from '@/lib/clients';
import { messagesOf, postJson } from '@/lib/requests';

export function ExportForm({ clients }: { clients: ClientSummary[] }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const body = { clientId: String(form.get('clientId') ?? ''), reason: String(form.get('reason') ?? '').trim() };
    if (!body.clientId || body.reason.length < 10) { setErrors(['Choose a client and enter the documented regulatory purpose']); return; }
    setSending(true); setErrors(undefined);
    try { const response = await postJson('/api/compliance/exports', body);
      if (!response.ok) { setErrors(await messagesOf(response)); return; } event.currentTarget.reset(); router.refresh();
    } finally { setSending(false); }
  }
  return <form aria-label="Generate ordinary AML export" onSubmit={submit} noValidate><h2>Generate export</h2>
    {errors && <ErrorSummary messages={errors} />}
    <div className="field"><label className="label" htmlFor="clientId">Client</label><select className="select" id="clientId" name="clientId" defaultValue="">
      <option value="" disabled>Choose a client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.reference}: {client.name}</option>)}</select></div>
    <div className="field"><label className="label" htmlFor="reason">Regulatory purpose</label><span className="hint" id="reason-hint">Name the request, authority or review this fixed bundle answers.</span>
      <textarea className="input" id="reason" name="reason" rows={3} maxLength={500} aria-describedby="reason-hint" /></div>
    <button className="button" type="submit" disabled={sending}>Generate fixed export</button>
  </form>;
}
