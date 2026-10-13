'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { POLICY_KIND_LABELS, type PolicyVersion } from '@/lib/policies';
import { messagesOf, postJson } from '@/lib/requests';
import type { StaffMember } from '@/lib/staff';

export function PolicyActions({ canCreate, pending, owners }:
  { canCreate: boolean; pending: PolicyVersion[]; owners: StaffMember[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function send(path: `/api/${string}`, body: Record<string, unknown>) {
    setSending(true); setErrors(undefined);
    try {
      const response = await postJson(path, body);
      if (!response.ok) { setErrors(await messagesOf(response)); return false; }
      router.refresh(); return true;
    } finally { setSending(false); }
  }

  async function approve(policyId: string) {
    await send(`/api/compliance/controls/${policyId}/approval`, {});
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget; const form = new FormData(target);
    const acknowledgement = form.get('requiresAcknowledgement') === 'on';
    if (await send('/api/compliance/controls', {
      kind: form.get('kind'), title: form.get('title'), content: form.get('content'), source: form.get('source'),
      ownerAccountId: form.get('ownerAccountId'), effectiveFrom: form.get('effectiveFrom'), reviewDueOn: form.get('reviewDueOn'),
      requiresAcknowledgement: acknowledgement,
      acknowledgementDueDays: acknowledgement ? Number(form.get('acknowledgementDueDays')) : null,
    })) target.reset();
  }

  return <>{errors && <ErrorSummary messages={errors} />}
    {pending.length > 0 && <section aria-labelledby="policy-approval-heading"><h2 id="policy-approval-heading">Awaiting Partner approval</h2>
      <ul>{pending.map((policy) => <li key={policy.id}><strong>{policy.title}</strong> (version {policy.version}, prepared by {policy.preparedBy.displayName}){' '}
        <button className="button button-small" disabled={sending} onClick={() => void approve(policy.id)}>Approve exact version</button></li>)}</ul>
    </section>}
    {canCreate && <section aria-labelledby="new-policy-heading"><h2 id="new-policy-heading">Prepare a new policy version</h2>
      <p className="secondary">A different active Partner must approve this exact version before staff can rely on or acknowledge it.</p>
      <form aria-label="Prepare policy version" onSubmit={create}>
        <div className="field"><label className="label" htmlFor="policyKind">Category</label><select className="select" id="policyKind" name="kind">
          {Object.entries(POLICY_KIND_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="policyTitle">Title</label><input className="input" id="policyTitle" name="title" maxLength={200} required /></div>
        <div className="field"><label className="label" htmlFor="policyOwner">Owner</label><select className="select" id="policyOwner" name="ownerAccountId">
          {owners.filter((owner) => owner.status === 'active').map((owner) => <option key={owner.id} value={owner.id}>{owner.displayName}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="policyContent">Approved policy text</label><textarea className="input" id="policyContent" name="content" rows={12} maxLength={200000} required /></div>
        <div className="field"><label className="label" htmlFor="policySource">Source and tailoring evidence</label><textarea className="input" id="policySource" name="source" rows={3} maxLength={2000} required /></div>
        <div className="form-row"><div className="field"><label className="label" htmlFor="policyEffective">Effective from</label><input className="input" id="policyEffective" name="effectiveFrom" type="date" required /></div>
          <div className="field"><label className="label" htmlFor="policyReview">Review due</label><input className="input" id="policyReview" name="reviewDueOn" type="date" required /></div></div>
        <div className="field"><label><input name="requiresAcknowledgement" type="checkbox" /> Require staff acknowledgement</label></div>
        <div className="field"><label className="label" htmlFor="policyAckDays">Acknowledgement due (days after effective date)</label><input className="input" id="policyAckDays" name="acknowledgementDueDays" type="number" min={1} max={365} defaultValue={14} /></div>
        <button className="button" disabled={sending}>Prepare immutable version</button>
      </form></section>}
  </>;
}

export function PolicyAcknowledgeButton({ policyId }: { policyId: string }) {
  const router = useRouter(); const [error, setError] = useState<string>(); const [sending, setSending] = useState(false);
  async function acknowledge() {
    setSending(true); setError(undefined);
    try {
      const response = await postJson(`/api/compliance/policies/${policyId}/acknowledgement`, {});
      if (!response.ok) { setError((await messagesOf(response))[0] ?? 'Could not acknowledge the policy'); return; }
      router.refresh();
    } finally { setSending(false); }
  }
  return <><button className="button button-small" disabled={sending} onClick={() => void acknowledge()}>Acknowledge this version</button>
    {error && <span className="field-error" role="alert"> {error}</span>}</>;
}
