'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { HrCompetence, HrLeaveRecord, HrPersonRecord } from '@/lib/hr';
import { messagesOf, postJson, putJson } from '@/lib/requests';

export function SelfServiceActions({ person, leave, competence }:
  { person: HrPersonRecord; leave: HrLeaveRecord; competence: HrCompetence }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function send(request: Promise<Response>, form?: HTMLFormElement) {
    setSending(true); setErrors(undefined);
    try { const response = await request; if (!response.ok) { setErrors(await messagesOf(response)); return; }
      form?.reset(); router.refresh();
    } finally { setSending(false); }
  }
  function data(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const optional = (form: FormData, name: string) => text(form, name) || null;

  function contact(event: FormEvent<HTMLFormElement>) {
    const form = data(event); const addressUsed = ['line1','line2','town','postcode'].some((name) => text(form, name));
    const emergencyUsed = ['emergencyName','emergencyRelationship','emergencyPhone'].some((name) => text(form, name));
    void send(putJson('/api/hr/me/contact', { personalEmail: optional(form, 'personalEmail'), phone: optional(form, 'phone'),
      address: addressUsed ? { line1: text(form, 'line1'), line2: optional(form, 'line2'), town: text(form, 'town'),
        postcode: text(form, 'postcode'), country: text(form, 'country') } : null,
      emergencyContact: emergencyUsed ? { name: text(form, 'emergencyName'), relationship: text(form, 'emergencyRelationship'),
        phone: text(form, 'emergencyPhone') } : null }));
  }
  function correction(event: FormEvent<HTMLFormElement>) { const form = data(event);
    void send(postJson('/api/hr/me/corrections', { category: form.get('category'), request: text(form, 'request') }), event.currentTarget); }
  function requestLeave(event: FormEvent<HTMLFormElement>) { const form = data(event);
    void send(postJson('/api/hr/me/leave', { kind: form.get('kind'), startsOn: text(form, 'startsOn'),
      endsOn: text(form, 'endsOn'), reason: text(form, 'reason') }), event.currentTarget); }
  function cancelLeave(event: FormEvent<HTMLFormElement>) { const form = data(event);
    void send(postJson(`/api/hr/leave/requests/${text(form, 'requestId')}/cancel`, { reason: text(form, 'reason') })); }
  function adjustment(event: FormEvent<HTMLFormElement>) { const form = data(event);
    void send(postJson('/api/hr/me/adjustments', { request: text(form, 'request') }), event.currentTarget); }
  function cycle(event: FormEvent<HTMLFormElement>) { const form = data(event);
    void send(postJson('/api/hr/me/development', { title: text(form, 'title'), periodStart: text(form, 'periodStart'),
      periodEnd: text(form, 'periodEnd') }), event.currentTarget); }
  function developmentEvent(event: FormEvent<HTMLFormElement>) { const form = data(event); const kind = text(form, 'kind');
    void send(postJson(`/api/hr/development/${text(form, 'cycleId')}/events`, { kind,
      state: kind === 'status' ? text(form, 'state') : null, narrative: text(form, 'narrative'),
      evidenceReference: optional(form, 'evidenceReference') }), event.currentTarget); }
  function learning(event: FormEvent<HTMLFormElement>) { const form = data(event);
    void send(postJson(`/api/hr/learning-assignments/${text(form, 'assignmentId')}/events`, { action: 'completed',
      completedOn: text(form, 'completedOn'), note: text(form, 'note'), evidenceReference: optional(form, 'evidenceReference') })); }
  function review(event: FormEvent<HTMLFormElement>) { const form = data(event); const action = text(form, 'action');
    void send(postJson(`/api/hr/reviews/${text(form, 'reviewId')}/worker-events`, { action,
      note: action === 'acknowledged' ? null : text(form, 'note') })); }

  return <section aria-labelledby="self-actions-heading"><h2 id="self-actions-heading">Update or request a change</h2>
    {errors && <ErrorSummary messages={errors} />}
    <details><summary>Update contact and emergency details</summary><form aria-label="Update my contact details" onSubmit={contact}>
      <Field id="personalEmail" label="Personal email" type="email" value={person.contact.personalEmail} />
      <Field id="phone" label="Phone" type="tel" value={person.contact.phone} />
      <Field id="line1" label="Address line 1" value={person.contact.address?.line1} /><Field id="line2" label="Address line 2" value={person.contact.address?.line2} />
      <Field id="town" label="Town or city" value={person.contact.address?.town} /><Field id="postcode" label="Postcode" value={person.contact.address?.postcode} />
      <Field id="country" label="Country code" value={person.contact.address?.country ?? 'GB'} />
      <Field id="emergencyName" label="Emergency contact name" value={person.contact.emergencyContact?.name} />
      <Field id="emergencyRelationship" label="Relationship" value={person.contact.emergencyContact?.relationship} />
      <Field id="emergencyPhone" label="Emergency contact phone" value={person.contact.emergencyContact?.phone} />
      <button className="button" disabled={sending}>Save a new contact version</button></form></details>
    <details><summary>Request a correction</summary><form aria-label="Request an HR correction" onSubmit={correction}>
      <Select id="category" label="Record area" options={['contact','personal','employment','manager','work_pattern','other']} />
      <Area id="correctionRequest" name="request" label="What should be corrected and why" /><button className="button" disabled={sending}>Send correction request</button></form></details>
    <details><summary>Request leave</summary><form aria-label="Request leave" onSubmit={requestLeave}>
      <Select id="leaveKind" name="kind" label="Leave type" options={['annual','family','compassionate','unpaid','other']} />
      <Field id="startsOn" label="Starts" type="date" /><Field id="endsOn" label="Ends" type="date" />
      <Area id="leaveReason" name="reason" label="Reason" /><button className="button" disabled={sending}>Submit leave request</button></form></details>
    {!!leave.requests.some((item) => item.state === 'pending' || item.state === 'approved') && <details><summary>Cancel a leave request</summary>
      <form aria-label="Cancel leave" onSubmit={cancelLeave}><div className="field"><label className="label" htmlFor="requestId">Request</label>
        <select className="select" id="requestId" name="requestId">{leave.requests.filter((item) => item.state === 'pending' || item.state === 'approved').map((item) =>
          <option key={item.id} value={item.id}>{item.kind}: {item.startsOn} to {item.endsOn}</option>)}</select></div>
        <Area id="cancelReason" name="reason" label="Reason for cancellation" /><button className="button" disabled={sending}>Cancel request</button></form></details>}
    <details><summary>Request a workplace adjustment</summary><form aria-label="Request workplace adjustment" onSubmit={adjustment}>
      <Area id="adjustmentRequest" name="request" label="Adjustment requested and relevant circumstances" />
      <button className="button" disabled={sending}>Send private request</button></form></details>
    <details><summary>Start a development cycle</summary><form aria-label="Start my development cycle" onSubmit={cycle}>
      <Field id="title" label="Title" /><Field id="periodStart" label="Period starts" type="date" />
      <Field id="periodEnd" label="Period ends" type="date" /><button className="button" disabled={sending}>Start cycle</button></form></details>
    {!!competence.development.length && <details><summary>Add development evidence</summary><form aria-label="Add my development evidence" onSubmit={developmentEvent}>
      <div className="field"><label className="label" htmlFor="cycleId">Cycle</label><select className="select" id="cycleId" name="cycleId">
        {competence.development.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
      <Select id="developmentKind" name="kind" label="Kind" options={['reflection','need','plan','activity','evaluation','status']} />
      <Select id="state" label="State (only for status)" options={['planned','active','completed','closed']} />
      <Area id="narrative" label="Narrative" /><Field id="developmentEvidence" name="evidenceReference" label="Evidence reference (optional)" />
      <button className="button" disabled={sending}>Record evidence</button></form></details>}
    {!!competence.learning.length && <details><summary>Complete required learning</summary><form aria-label="Complete required learning" onSubmit={learning}>
      <div className="field"><label className="label" htmlFor="assignmentId">Assignment</label><select className="select" id="assignmentId" name="assignmentId">
        {competence.learning.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
      <Field id="completedOn" label="Completed" type="date" /><Area id="note" label="Completion note" />
      <Field id="learningEvidence" name="evidenceReference" label="Evidence reference (optional)" /><button className="button" disabled={sending}>Record completion</button></form></details>}
    {!!competence.reviews.length && <details><summary>Respond to an objective or appraisal</summary><form aria-label="Respond to my review" onSubmit={review}>
      <div className="field"><label className="label" htmlFor="reviewId">Record</label><select className="select" id="reviewId" name="reviewId">
        {competence.reviews.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
      <Select id="reviewAction" name="action" label="Response" options={['acknowledged','response','disagreement']} /><Area id="reviewNote" name="note" label="Note (required for response or disagreement)" required={false} />
      <button className="button" disabled={sending}>Record response</button></form></details>}
  </section>;
}

function Field({ id, name = id, label, value, type = 'text' }: { id: string; name?: string; label: string; value?: string | null; type?: string }) {
  return <div className="field"><label className="label" htmlFor={id}>{label}</label><input className="input" id={id} name={name}
    type={type} defaultValue={value ?? ''} /></div>;
}
function Area({ id, name = id, label, required = true }: { id: string; name?: string; label: string; required?: boolean }) {
  return <div className="field"><label className="label" htmlFor={id}>{label}</label><textarea className="input" id={id} name={name}
    rows={4} minLength={required ? 3 : undefined} required={required} /></div>;
}
function Select({ id, name = id, label, options }: { id: string; name?: string; label: string; options: string[] }) {
  return <div className="field"><label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name}>
    {options.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}</select></div>;
}
