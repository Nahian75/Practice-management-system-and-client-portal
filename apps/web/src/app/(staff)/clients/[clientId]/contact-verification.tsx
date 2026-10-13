'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { formatDateTime } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';
import type { PortalCandidate } from './portal-access';

export interface ContactVerificationRecord {
  id: string; contactId: string | null; channel: 'email'; address: string;
  state: 'pending' | 'verified' | 'expired' | 'superseded' | 'address_changed';
  attemptCount: number; requestedAt: string; expiresAt: string; verifiedAt: string | null;
  requestedBy: { accountId: string; displayName: string };
}

const STATE = { pending: 'Awaiting client', verified: 'Email verified', expired: 'Expired',
  superseded: 'Replaced by a newer link', address_changed: 'Address changed; verify again' } as const;

export function ContactVerification({ clientId, records, candidates }:
  { clientId: string; records: ContactVerificationRecord[]; candidates: PortalCandidate[] }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [done, setDone] = useState<string>();
  const [sending, setSending] = useState(false);
  async function send(candidate: PortalCandidate) {
    setSending(true); setErrors(undefined); setDone(undefined);
    try {
      const response = await postJson(`/api/clients/${clientId}/contact-verifications`,
        candidate.contactId ? { contactId: candidate.contactId } : {});
      if (!response.ok) { setErrors(await messagesOf(response)); return; }
      setDone(`A one-time link was queued for ${candidate.email}.`); router.refresh();
    } finally { setSending(false); }
  }
  return <section aria-labelledby="contact-verification-heading"><h2 id="contact-verification-heading">Contact verification</h2>
    <p className="secondary">This confirms control of an email address only. It is separate from identity and AML verification.</p>
    {errors && <ErrorSummary messages={errors} />}<div role="status">{done && <p className="notice">{done}</p>}</div>
    {records.length > 0 && <table className="table"><thead><tr><th scope="col">Address</th><th scope="col">Status</th><th scope="col">Requested</th><th scope="col">Verified</th></tr></thead>
      <tbody>{records.map((item) => <tr key={item.id}><td>{item.address}</td><td>{STATE[item.state]}</td>
        <td>{formatDateTime(item.requestedAt)} by {item.requestedBy.displayName}</td><td>{item.verifiedAt ? formatDateTime(item.verifiedAt) : 'Not verified'}</td></tr>)}</tbody></table>}
    <ul className="plain-list">{candidates.map((candidate) => <li key={candidate.contactId ?? 'client'}>{candidate.email
      ? <button className="button button-secondary" disabled={sending} onClick={() => void send(candidate)}>Send verification link to {candidate.name}</button>
      : <span>{candidate.name} has no email address on record.</span>}</li>)}</ul>
  </section>;
}
