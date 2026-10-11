'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { ClientSummary } from '@/lib/clients';
import type { ComplianceHold, SanctionsCandidate } from '@/lib/compliance';
import { messagesOf, postJson } from '@/lib/requests';

export function ComplianceOperations({ candidates, holds, clients }:
  { candidates: SanctionsCandidate[]; holds: ComplianceHold[]; clients: ClientSummary[] }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function post(path: `/api/${string}`, body: Record<string, unknown>) {
    setSending(true); setErrors(undefined);
    try { const response = await postJson(path, body); if (!response.ok) { setErrors(await messagesOf(response)); return false; } router.refresh(); return true; }
    finally { setSending(false); }
  }
  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const candidateId = String(form.get('candidateId'));
    await post(`/api/compliance/sanctions/candidates/${candidateId}/resolution`, { outcome: form.get('outcome'), reasoning: form.get('reasoning') });
  }
  async function impose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    if (await post('/api/compliance/holds', { clientId: form.get('holdClientId'), reason: form.get('holdReason') })) target.reset();
  }
  async function lift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const holdId = String(form.get('holdId'));
    await post(`/api/compliance/holds/${holdId}/lift`, { reason: form.get('liftReason') });
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const data = new FormData(target); setSending(true); setErrors(undefined);
    try { const response = await fetch('/api/compliance/sanctions/lists', { method: 'POST', body: data }); if (!response.ok) { setErrors(await messagesOf(response)); return; } target.reset(); router.refresh(); }
    finally { setSending(false); }
  }
  return <section aria-labelledby="operations-heading"><h2 id="operations-heading">Compliance actions</h2>{errors && <ErrorSummary messages={errors} />}
    {!!candidates.length && <details><summary>Resolve a sanctions candidate</summary><form aria-label="Resolve sanctions candidate" onSubmit={resolve}>
      <div className="field"><label className="label" htmlFor="candidateId">Candidate</label><select className="select" id="candidateId" name="candidateId">{candidates.map((item) => <option key={item.candidateId} value={item.candidateId}>{item.clientReference}: {item.matchedName}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="outcome">Outcome</label><select className="select" id="outcome" name="outcome"><option value="false_positive">False positive</option><option value="confirmed">Confirmed designation</option></select></div>
      <div className="field"><label className="label" htmlFor="reasoning">Identity and ownership/control reasoning</label><textarea className="input" id="reasoning" name="reasoning" minLength={20} maxLength={10000} required rows={4} /></div><button className="button" disabled={sending}>Record permanent resolution</button>
    </form></details>}
    <details><summary>Impose an operational hold</summary><form aria-label="Impose compliance hold" onSubmit={impose}>
      <div className="field"><label className="label" htmlFor="holdClientId">Client</label><select className="select" id="holdClientId" name="holdClientId">{clients.map((client) => <option key={client.id} value={client.id}>{client.reference}: {client.name}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="holdReason">Reason</label><textarea className="input" id="holdReason" name="holdReason" minLength={20} maxLength={10000} required rows={4} /></div><button className="button" disabled={sending}>Impose hold</button>
    </form></details>
    {!!holds.length && <details><summary>Lift an operational hold</summary><form aria-label="Lift compliance hold" onSubmit={lift}>
      <div className="field"><label className="label" htmlFor="holdId">Hold</label><select className="select" id="holdId" name="holdId">{holds.map((hold) => <option key={hold.id} value={hold.id}>{hold.matterId ? 'Matter hold' : 'Client hold'} imposed {new Date(hold.imposedAt).toLocaleDateString('en-GB')}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="liftReason">Reason for lifting</label><textarea className="input" id="liftReason" name="liftReason" minLength={20} maxLength={10000} required rows={4} /></div><button className="button" disabled={sending}>Lift hold</button>
    </form></details>}
    <details><summary>Import the official UK Sanctions List CSV</summary><form aria-label="Import sanctions list" onSubmit={upload}>
      <p className="secondary">Upload the complete official UK Sanctions List CSV. The API validates its structure and report date before atomic activation.</p>
      <div className="field"><label className="label" htmlFor="sanctionsFile">CSV file</label><input className="input" id="sanctionsFile" name="file" type="file" accept=".csv,text/csv" required /></div><button className="button" disabled={sending}>Validate and activate list</button>
    </form></details>
  </section>;
}
