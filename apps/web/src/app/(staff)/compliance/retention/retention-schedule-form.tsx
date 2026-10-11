'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { ClientSummary } from '@/lib/clients';
import { messagesOf, postJson } from '@/lib/requests';

export function RetentionScheduleForm({ clients }: { clients: ClientSummary[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = { clientId: String(form.get('clientId') ?? ''), relationshipEndedOn: String(form.get('relationshipEndedOn') ?? ''),
      retentionYears: Number(form.get('retentionYears')), governingRule: String(form.get('governingRule') ?? '').trim(),
      evidence: String(form.get('evidence') ?? '').trim() };
    const problems = [
      ...(body.clientId ? [] : ['Choose a client']), ...(body.relationshipEndedOn ? [] : ['Enter the relationship end date']),
      ...(body.retentionYears === 5 ? [] : ['The AML retention period must be five years; use a legal hold for an evidenced exception']),
      ...(body.governingRule.length >= 10 ? [] : ['Enter the governing rule']),
      ...(body.evidence.length >= 10 ? [] : ['Explain the evidence for the relationship end date']),
    ];
    if (problems.length) { setErrors(problems); return; }
    setSending(true); setErrors(undefined);
    try {
      const response = await postJson('/api/compliance/retention', body);
      if (!response.ok) { setErrors(await messagesOf(response)); return; }
      const created = await response.json() as { id: string };
      router.push(`/compliance/retention/${created.id}`); router.refresh();
    } finally { setSending(false); }
  }
  return <form aria-label="Record relationship end and retention" onSubmit={submit} noValidate>
    <h2>New retention schedule</h2>{errors && <ErrorSummary messages={errors} />}
    <div className="field"><label className="label" htmlFor="clientId">Client</label><select className="select" id="clientId" name="clientId" defaultValue="">
      <option value="" disabled>Choose a client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.reference}: {client.name}</option>)}</select></div>
    <div className="field"><label className="label" htmlFor="relationshipEndedOn">Relationship ended</label><input className="input input-date" id="relationshipEndedOn" name="relationshipEndedOn" type="date" /></div>
    <div className="field"><label className="label" htmlFor="retentionYears">Retention period in years</label><span className="hint">Five years under regulation 40. Record an evidenced legal hold if an exception applies.</span><input className="input input-short" id="retentionYears" name="retentionYears" type="number" min="5" max="5" defaultValue="5" readOnly /></div>
    <div className="field"><label className="label" htmlFor="governingRule">Governing rule</label><input className="input" id="governingRule" name="governingRule" maxLength={500} defaultValue="MLR 2017 regulation 40 five-year retention rule" /></div>
    <div className="field"><label className="label" htmlFor="evidence">Evidence of relationship end</label><textarea className="input" id="evidence" name="evidence" rows={4} maxLength={10000} /></div>
    <button className="button" type="submit" disabled={sending}>Record schedule</button>
  </form>;
}
