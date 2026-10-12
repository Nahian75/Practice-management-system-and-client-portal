'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

export function ExportDecision({ exportId }: { exportId: string }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget);
    setSending(true); setErrors(undefined); try { const response = await postJson(`/api/hr/exports/${exportId}/decision`, {
      decision: form.get('decision'), note: String(form.get('note') ?? '').trim() });
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); } }
  return <form aria-label="Decide HR export release" onSubmit={submit}><h2>Release decision</h2>{errors && <ErrorSummary messages={errors} />}
    <div className="field"><label className="label" htmlFor="exportDecision">Decision</label><select className="select" id="exportDecision" name="decision">
      <option value="approved">Approve release</option><option value="rejected">Reject release</option></select></div>
    <div className="field"><label className="label" htmlFor="exportNote">Review note</label><textarea className="input" id="exportNote" name="note" rows={4} required minLength={10} /></div>
    <button className="button" disabled={sending}>Record permanent decision</button></form>;
}
