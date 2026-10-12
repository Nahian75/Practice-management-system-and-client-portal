'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { HrDirectoryMember } from '@/lib/hr';
import { messagesOf, postJson } from '@/lib/requests';

export function CaseActions({ caseId, eventIds, role, memberships, people }: { caseId: string; eventIds: string[];
  role?: string; memberships: Array<{ id: string; role: string }>; people: HrDirectoryMember[] }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function send(event: FormEvent<HTMLFormElement>, path: `/api/${string}`, body: (form: FormData) => Record<string, unknown>) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target); setSending(true); setErrors(undefined);
    try { const response = await postJson(path.replace(':id', String(form.get('id'))) as `/api/${string}`, body(form));
      if (!response.ok) { setErrors(await messagesOf(response)); return; } target.reset(); router.refresh();
    } finally { setSending(false); }
  }
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const eventKinds = ['evidence','meeting','response','notice','action','correction',
    ...(role === 'decision_maker' ? ['outcome'] : []), ...(role === 'appeal_officer' ? ['appeal'] : []),
    ...(role === 'hr_member' ? ['status'] : [])];
  const isHrMember = role === 'hr_member';
  return <section aria-labelledby="case-actions-heading"><h2 id="case-actions-heading">Case actions</h2>
    {errors && <ErrorSummary messages={errors} />}
    <details open><summary>Record a case event</summary><form aria-label="Record case event"
      onSubmit={(event) => void send(event, `/api/hr/cases/${caseId}/events`, (form) => { const kind = text(form, 'kind'); return {
        kind, state: kind === 'status' ? text(form, 'state') : null, occurredOn: text(form, 'occurredOn'),
        supersedesEventId: kind === 'correction' ? text(form, 'supersedesEventId') : null,
        summary: text(form, 'summary'), details: text(form, 'details'), evidenceReference: text(form, 'evidenceReference') || null }; })}>
      <Select id="eventKind" name="kind" label="Event kind" values={eventKinds} />
      <Select id="caseState" name="state" label="State (only for a status event)" values={['open','investigating','decision_due','appeal_open','closed']} />
      <Field id="eventDate" name="occurredOn" label="Occurred" type="date" />
      {!!eventIds.length && <div className="field"><label className="label" htmlFor="supersedesEventId">Corrected event (only for a correction)</label>
        <select className="select" id="supersedesEventId" name="supersedesEventId" defaultValue=""><option value="">Choose when correcting</option>
          {eventIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></div>}
      <Field id="eventSummary" name="summary" label="Summary" /><Area id="eventDetails" name="details" label="Details" />
      <Field id="eventEvidence" name="evidenceReference" label="Evidence reference (optional)" />
      <button className="button" disabled={sending}>Record permanent event</button></form></details>
    {isHrMember && <><details><summary>Add a case-team member</summary><form aria-label="Add case member"
      onSubmit={(event) => void send(event, `/api/hr/cases/${caseId}/members`, (form) => ({ accountId: form.get('accountId'),
        role: form.get('role'), separationOverride: text(form, 'separationOverride') || null }))}>
      <div className="field"><label className="label" htmlFor="caseAccountId">Staff member</label><select className="select" id="caseAccountId" name="accountId">
        {people.map((person) => <option key={person.accountId} value={person.accountId}>{person.displayName}</option>)}</select></div>
      <Select id="caseRole" name="role" label="Case role" values={['hr_member','investigator','decision_maker','appeal_officer']} />
      <Area id="separationOverride" name="separationOverride" label="Small-firm separation reason (only if roles overlap)" required={false} />
      <button className="button" disabled={sending}>Add member</button></form></details>
      <details><summary>End a case-team membership</summary><form aria-label="End case membership"
        onSubmit={(event) => void send(event, '/api/hr/case-memberships/:id/end', (form) => ({ reason: text(form, 'reason') }))}>
        <div className="field"><label className="label" htmlFor="membershipId">Membership</label><select className="select" id="membershipId" name="id">
          {memberships.map((item) => <option key={item.id} value={item.id}>{item.role.replaceAll('_', ' ')} — {item.id}</option>)}</select></div>
        <Area id="endingReason" name="reason" label="Reason for ending access" />
        <button className="button button-warning" disabled={sending}>End membership</button></form></details></>}
  </section>;
}

function Field({ id, name, label, type = 'text' }: { id: string; name: string; label: string; type?: string }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><input className="input" id={id} name={name} type={type} /></div>; }
function Area({ id, name, label, required = true }: { id: string; name: string; label: string; required?: boolean }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><textarea className="input" id={id} name={name} rows={4} required={required} minLength={required ? 3 : undefined} /></div>; }
function Select({ id, name, label, values }: { id: string; name: string; label: string; values: string[] }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name}>{values.map((value) =>
    <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>; }
