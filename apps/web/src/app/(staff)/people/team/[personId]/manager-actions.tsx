'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { HrAdjustments, HrCompetence, HrLeaveRecord } from '@/lib/hr';
import { messagesOf, postJson } from '@/lib/requests';

export function ManagerActions({ personId, leave, adjustments, competence }:
  { personId: string; leave: HrLeaveRecord; adjustments: HrAdjustments; competence: HrCompetence }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>, path: `/api/${string}`, body: (form: FormData) => Record<string, unknown>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); setSending(true); setErrors(undefined);
    try { const response = await postJson(path.replace(':id', String(form.get('id'))) as `/api/${string}`, body(form));
      if (!response.ok) { setErrors(await messagesOf(response)); return; } element.reset(); router.refresh();
    } finally { setSending(false); }
  }
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const pending = leave.requests.filter((item) => item.state === 'pending');
  const activeAdjustments = adjustments.adjustments.filter((item) => item.decisionId && item.outcome === 'agreed');
  return <section aria-labelledby="manager-actions-heading"><h2 id="manager-actions-heading">Manager actions</h2>
    {errors && <ErrorSummary messages={errors} />}
    {!!pending.length && <details><summary>Decide annual leave</summary><form aria-label="Decide direct-report leave"
      onSubmit={(event) => void submit(event, '/api/hr/leave/requests/:id/decision', (form) => ({ action: form.get('action'), reason: text(form, 'reason') }))}>
      <Choice id="managerLeaveRequest" name="id" items={pending.map((item) => ({ id: item.id, label: `${item.kind}: ${item.startsOn} to ${item.endsOn}` }))} />
      <Select id="managerLeaveDecision" name="action" label="Decision" values={['approved','refused']} /><Area id="managerLeaveReason" name="reason" label="Decision reason" />
      <button className="button" disabled={sending}>Record permanent decision</button></form></details>}
    <details><summary>Record sickness administration</summary><form aria-label="Record direct-report sickness"
      onSubmit={(event) => void submit(event, `/api/hr/people/${personId}/sickness`, (form) => ({ startedOn: text(form, 'startedOn'),
        endedOn: text(form, 'endedOn') || null, notifiedAt: new Date(text(form, 'notifiedAt')).toISOString(), fitnessStatus: form.get('fitnessStatus') }))}>
      <Field id="managerSicknessStarted" name="startedOn" label="Started" type="date" /><Field id="managerSicknessEnded" name="endedOn" label="Ended (optional)" type="date" />
      <Field id="managerSicknessNotified" name="notifiedAt" label="Notified date and time" type="datetime-local" />
      <Select id="managerFitnessStatus" name="fitnessStatus" label="Operational fitness" values={['fit','not_fit','may_be_fit','not_assessed']} />
      <button className="button" disabled={sending}>Record sickness</button></form></details>
    {!!activeAdjustments.length && <details><summary>Record adjustment progress</summary><form aria-label="Record adjustment progress"
      onSubmit={(event) => void submit(event, '/api/hr/adjustments/decisions/:id/progress', (form) => ({ action: form.get('action'), note: text(form, 'note') }))}>
      <Choice id="managerAdjustmentDecision" name="id" items={activeAdjustments.map((item) => ({ id: item.decisionId!, label: item.operationalInstruction ?? 'Agreed adjustment' }))} />
      <Select id="managerAdjustmentProgress" name="action" label="Progress" values={['implemented','reviewed']} /><Area id="managerAdjustmentNote" name="note" label="Progress note" />
      <button className="button" disabled={sending}>Record progress</button></form></details>}
    <details><summary>Start a development cycle</summary><form aria-label="Start direct-report development cycle"
      onSubmit={(event) => void submit(event, `/api/hr/reports/${personId}/development`, (form) => ({ title: text(form, 'title'),
        periodStart: text(form, 'periodStart'), periodEnd: text(form, 'periodEnd') }))}>
      <Field id="managerCycleTitle" name="title" label="Title" /><Field id="managerCycleStart" name="periodStart" label="Period starts" type="date" />
      <Field id="managerCycleEnd" name="periodEnd" label="Period ends" type="date" /><button className="button" disabled={sending}>Start cycle</button></form></details>
    {!!competence.development.length && <details><summary>Add a development requirement or review</summary><form aria-label="Add direct-report development event"
      onSubmit={(event) => void submit(event, '/api/hr/development/:id/events', (form) => ({ kind: form.get('kind'), state: null,
        narrative: text(form, 'narrative'), evidenceReference: text(form, 'evidenceReference') || null }))}>
      <Choice id="managerDevelopmentCycle" name="id" items={competence.development.map((item) => ({ id: item.id, label: item.title }))} />
      <Select id="managerDevelopmentKind" name="kind" label="Kind" values={['requirement','review']} /><Area id="managerDevelopmentNarrative" name="narrative" label="Narrative" />
      <Field id="managerDevelopmentEvidence" name="evidenceReference" label="Evidence reference (optional)" /><button className="button" disabled={sending}>Record event</button></form></details>}
    <details><summary>Record an objective or appraisal</summary><form aria-label="Record direct-report review"
      onSubmit={(event) => void submit(event, `/api/hr/reports/${personId}/reviews`, (form) => { const kind = text(form, 'kind'); return { kind,
        title: text(form, 'title'), periodStart: kind === 'appraisal' ? text(form, 'periodStart') : null,
        periodEnd: kind === 'appraisal' ? text(form, 'periodEnd') : null, targetOn: kind === 'objective' ? text(form, 'targetOn') : null,
        statement: text(form, 'statement') }; })}>
      <Select id="managerReviewKind" name="kind" label="Kind" values={['objective','appraisal']} /><Field id="managerReviewTitle" name="title" label="Title" />
      <Field id="managerReviewTarget" name="targetOn" label="Objective target date" type="date" /><Field id="managerReviewStart" name="periodStart" label="Appraisal period starts" type="date" />
      <Field id="managerReviewEnd" name="periodEnd" label="Appraisal period ends" type="date" /><Area id="managerReviewStatement" name="statement" label="Statement" />
      <button className="button" disabled={sending}>Record immutable review</button></form></details>
  </section>;
}

function Choice({ id, name, items }: { id: string; name: string; items: Array<{ id: string; label: string }> }) { return <div className="field"><label className="label" htmlFor={id}>Record</label>
  <select className="select" id={id} name={name}>{items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>; }
function Field({ id, name, label, type = 'text' }: { id: string; name: string; label: string; type?: string }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><input className="input" id={id} name={name} type={type} /></div>; }
function Area({ id, name, label }: { id: string; name: string; label: string }) { return <div className="field"><label className="label" htmlFor={id}>{label}</label>
  <textarea className="input" id={id} name={name} rows={4} required minLength={3} /></div>; }
function Select({ id, name, label, values }: { id: string; name: string; label: string; values: string[] }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name}>{values.map((value) =>
    <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>; }
